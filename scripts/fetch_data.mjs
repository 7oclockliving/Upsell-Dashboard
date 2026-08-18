/**
 * ============================================================================
 * fetch_data.mjs – Datenabruf für das SEVN Upsell-Dashboard (7 o'clock)
 *
 * Läuft täglich in GitHub Actions (siehe .github/workflows/update.yml) und
 * schreibt docs/data.json, das von docs/index.html (GitHub Pages) geladen
 * wird.
 *
 * Struktur (seit 11.08.2026, Zeitraum-Tabs): Aggregation PRO TAG – die
 * Seite rechnet daraus beliebige Zeiträume (Letzter Tag / 7 / 30 / 90 /
 * 365 Tage / Custom) clientseitig zusammen.
 *
 * Datenquelle: Shopify Admin GraphQL API (2026-07).
 * Erkennung der Upsell-Käufe: Line-Item-Attribut "_sevn_upsell"
 *   (Wert = Szenario-/Mapping-Handle, z.B. "geschirr-matt").
 * A/B-Zuordnung: Order-Attribut "_sevn_ab_upsell" ("test" | "control").
 *
 * Env-Variablen (GitHub Secrets):
 *   SHOPIFY_SHOP        z.B. "7oclock-de.myshopify.com"
 *   SEVN_CLIENT_ID      Client-ID der App "sevn-checkout-upsell"
 *   SEVN_CLIENT_SECRET  Client-Secret derselben App
 *   (alternativ SHOPIFY_TOKEN = fertiger Admin-Token shpat_… mit read_orders)
 *
 * Auth: Client-Credentials-Grant. KEIN product-Feld in der Query – das
 * würde zusätzlich read_products erfordern.
 * ============================================================================
 */

const SHOP = process.env.SHOPIFY_SHOP || '7oclock-de.myshopify.com';
const CLIENT_ID = process.env.SEVN_CLIENT_ID;
const CLIENT_SECRET = process.env.SEVN_CLIENT_SECRET;
let TOKEN = process.env.SHOPIFY_TOKEN || null;
const API_VERSION = '2026-07';
/** Go-live des Checkout-Upsells (Profil "7 O'CLOCK + SEVN Upsell App") */
const SINCE = '2026-08-10';

const UPSELL_ATTR = '_sevn_upsell';
const AB_ATTR = '_sevn_ab_upsell';
/** Anzeige-Tracking (ab 11.08.2026, App v18): Wert = Mapping-Handle */
const SHOWN_ATTR = '_sevn_upsell_shown';
/** Aktivierungs-Tracking (ab App v19, Teaser-Modus): Wert = Mapping-Handle */
const ACTIVATED_ATTR = '_sevn_upsell_activated';

if (!TOKEN && (!CLIENT_ID || !CLIENT_SECRET)) {
  console.error(
    'Secrets fehlen: SEVN_CLIENT_ID + SEVN_CLIENT_SECRET (oder SHOPIFY_TOKEN).',
  );
  process.exit(1);
}

async function getToken() {
  if (TOKEN) return TOKEN;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  const j = await res.json();
  if (!j.access_token) {
    throw new Error('Token-Austausch fehlgeschlagen: HTTP ' + res.status);
  }
  TOKEN = j.access_token;
  return TOKEN;
}

async function gql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await getToken(),
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

/**
 * Neukunden-Erkennung (18.08.2026, Wunsch Alina): customerJourneySummary.
 * customerOrderIndex = 1 -> erste Bestellung dieses Kunden (Neukunde).
 * Braucht ggf. zusaetzlichen Scope -> withJourney=false als Fallback,
 * damit der restliche Datenlauf nie daran scheitert.
 */
const ordersQuery = (withJourney) => `
  query SevnOrders($cursor: String, $q: String!) {
    orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        tags
        createdAt
        ${withJourney ? 'customerJourneySummary { customerOrderIndex }' : ''}
        totalPriceSet { shopMoney { amount currencyCode } }
        customAttributes { key value }
        lineItems(first: 100) {
          nodes {
            title
            sku
            quantity
            customAttributes { key value }
            originalTotalSet { shopMoney { amount } }
            discountedTotalSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

/**
 * Abgebrochene Checkouts (11.08.2026, Abbruch-Analyse): Checkouts mit
 * hinterlassenen Kontaktdaten, die NICHT abgeschlossen wurden. Die Cart-
 * Attribute der Extension (_sevn_upsell_shown / _sevn_upsell_activated /
 * _sevn_ab_upsell) haengen als customAttributes dran – damit laesst sich
 * die Abbruchquote mit/ohne Deal-Anzeige vergleichen (Korrelation!
 * Kausal beantwortet das nur der A/B-Test). completedAt != null =
 * Warenkorb spaeter doch abgeschlossen -> getrennt als Recovery gezaehlt
 * (13.08.2026). Scope: read_orders.
 */
const ABANDONED_QUERY = `
  query SevnAbandoned($cursor: String, $q: String!) {
    abandonedCheckouts(first: 100, after: $cursor, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        createdAt
        completedAt
        customAttributes { key value }
        totalPriceSet { shopMoney { amount } }
      }
    }
  }
`;

function scenarioGroup(marker) {
  if (!marker) return 'Unbekannt';
  if (marker.startsWith('geschirr')) return 'Geschirr';
  if (marker.startsWith('glaser-lose')) return 'Lose Gläser (Staffel)';
  if (marker.startsWith('glaser')) return 'Gläser-Bundles';
  return 'Sonstige';
}

const num = (v) => Math.round(parseFloat(v || '0') * 100) / 100;
const round2 = (x) => Math.round(x * 100) / 100;

async function main() {
  const q = `created_at:>=${SINCE}`;
  let journeyAvailable = true;
  let orders = [];
  // Erst mit Kundenhistorie versuchen; scheitert das (fehlender Scope),
  // einmal komplett ohne wiederholen, damit der Datenlauf nie ausfaellt.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      orders = [];
      let cursor = null;
      for (let page = 0; page < 100; page++) {
        const data = await gql(ordersQuery(journeyAvailable), { cursor, q });
        const conn = data.orders;
        orders.push(...conn.nodes);
        if (!conn.pageInfo.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
      }
      break;
    } catch (e) {
      if (journeyAvailable) {
        journeyAvailable = false;
        console.error('WARNUNG: Kundenhistorie (Neukunden) nicht verfuegbar:', e.message);
      } else {
        throw e;
      }
    }
  }

  const days = {}; // key: yyyy-mm-dd (Datum aus createdAt, UTC)
  let currency = 'EUR';

  const emptyDay = () => ({
    orders: 0,
    totalRevenue: 0,
    upsellOrders: 0,
    upsellUnits: 0,
    upsellRevenue: 0,
    upsellOrdersRevenue: 0, // Gesamt-Bestellwert der Bestellungen MIT Upsell (fuer AOV-Uplift)
    activatedOrders: 0, // Bestellungen mit Deal-Aktivierung (Teaser-Modus, ab App v19)
    // Neusendungen & Kooperationen (18.08.2026, Wunsch Alina): Erkennung
    // strikt ueber die SKU-Labels der Marker-Produkte (SYS-NS-* = Neusendung
    // inkl. Kategorien wie Defekt/Artikel fehlt/Schweiz, SYS-KOP = Kooperation)
    // - genau wie im Neusendungs-Dashboard. Diese Bestellungen werden aus
    // ALLEN Kennzahlen ausgeklammert (verfaelschen sonst AOV, Take-Rate,
    // Sichtbarkeit) und getrennt gezaehlt.
    excluded: { ns: 0, koop: 0, zero: 0, revenue: 0 },
    // Neukunden (18.08.2026): normale Bestellungen mit customerOrderIndex = 1
    newCustomers: 0,
    // Shop-Sessions des Tages aus Shopify Analytics (ShopifyQL) fuer die
    // Conversion-Rate; 0 = nicht verfuegbar (siehe sessionsAvailable).
    sessions: 0,
    // Bestellnummern der Upsell-Bestellungen (11.08.2026, Wunsch Alina):
    // {name, total, upsellRevenue, scenarios[]} – KEINE Kundendaten!
    upsellOrdersList: [],
    shown: {}, // Szenario-Gruppe -> {shown, converted} (Anzeige-Tracking, ab App v18)
    // Abgebrochene Checkouts des Tages (Abbruch-Analyse 11.08.2026)
    abandoned: {
      total: 0,
      shown: 0, // davon: Deal wurde angezeigt
      activated: 0, // davon: Deal wurde aktiviert (Teaser-Modus)
      revenue: 0, // Warenwert der abgebrochenen Checkouts
      recovered: 0, // spaeter doch abgeschlossen (Warenkorb-Recovery, 13.08.2026)
      recoveredRevenue: 0, // Warenwert der zurueckgeholten Warenkoerbe
      recoveredList: [], // Details je Recovery: {name, created, completed, value}
      ab: { test: 0, control: 0, none: 0 }, // offene Abbrueche je A/B-Bucket
      recAb: { test: 0, control: 0, none: 0 }, // Recovery je A/B-Bucket (unabh. vom Deal-Filter, 13.08.2026)
    },
    products: {}, // title -> {units, orders, revenue, discountGiven, scenarios{}}
    scenarios: {}, // name -> {upsellOrders, units, revenue}
    ab: {
      test: { orders: 0, upsellOrders: 0, revenue: 0 },
      control: { orders: 0, upsellOrders: 0, revenue: 0 },
      none: { orders: 0, upsellOrders: 0, revenue: 0 },
    },
  });

  for (const o of orders) {
    const date = o.createdAt.slice(0, 10);
    days[date] ??= emptyDay();
    const d = days[date];
    // Neusendungen/Koops VOR allen Kennzahlen abfangen (18.08.2026, Fix):
    // Erkennung STRIKT ueber die SKU-Labels der Marker-Produkte, wie im
    // Neusendungs-Dashboard: SYS-NS-* (alle Neusendungs-Kategorien inkl.
    // Schweiz) und SYS-KOP (Kooperationen/Influencer).
    const liSkus = (o.lineItems?.nodes || []).map((li) => String(li.sku || ''));
    const isNs = liSkus.some((s) => /^SYS-NS/i.test(s));
    const isKoop = liSkus.some((s) => /^SYS-KOP/i.test(s));
    const orderTotal = num(o.totalPriceSet?.shopMoney?.amount);
    // Sicherheitsnetz (18.08.2026, Wunsch Alina): JEDE 0-Euro-Bestellung wird
    // ausgeklammert - auch wenn das Team mal vergisst, das Marker-Produkt
    // beizulegen. Echte Kundenbestellungen sind nie 0 Euro.
    if (isNs || isKoop || orderTotal === 0) {
      if (isNs) d.excluded.ns++;
      else if (isKoop) d.excluded.koop++;
      else d.excluded.zero++;
      d.excluded.revenue = round2(d.excluded.revenue + orderTotal);
      continue;
    }
    d.orders++;
    d.totalRevenue += num(o.totalPriceSet?.shopMoney?.amount);
    currency = o.totalPriceSet?.shopMoney?.currencyCode || currency;
    if (o.customerJourneySummary?.customerOrderIndex === 1) d.newCustomers++;

    const abVal =
      (o.customAttributes || []).find((a) => a.key === AB_ATTR)?.value || 'none';
    const bucket = d.ab[abVal] ? abVal : 'none';
    d.ab[bucket].orders++;
    d.ab[bucket].revenue += num(o.totalPriceSet?.shopMoney?.amount);

    const shownVal = (o.customAttributes || []).find((a) => a.key === SHOWN_ATTR)?.value;
    const shownGroup = shownVal ? scenarioGroup(shownVal) : null;
    if (shownGroup) {
      d.shown[shownGroup] ??= { shown: 0, converted: 0 };
      d.shown[shownGroup].shown++;
    }
    if ((o.customAttributes || []).some((a) => a.key === ACTIVATED_ATTR)) {
      d.activatedOrders++;
    }

    let orderHasUpsell = false;
    let orderUpsellPaid = 0;
    const seenScen = new Set();
    for (const li of o.lineItems.nodes) {
      const marker = (li.customAttributes || []).find(
        (a) => a.key === UPSELL_ATTR,
      )?.value;
      if (!marker) continue;
      orderHasUpsell = true;

      const gross = num(li.originalTotalSet?.shopMoney?.amount);
      const paid = num(li.discountedTotalSet?.shopMoney?.amount);
      const g = scenarioGroup(marker);

      d.products[li.title] ??= {
        units: 0,
        orders: 0,
        revenue: 0,
        discountGiven: 0,
        scenarios: {},
      };
      const p = d.products[li.title];
      p.units += li.quantity;
      p.orders++;
      p.revenue = round2(p.revenue + paid);
      p.discountGiven = round2(p.discountGiven + Math.max(0, gross - paid));
      p.scenarios[g] = (p.scenarios[g] || 0) + li.quantity;

      d.scenarios[g] ??= { upsellOrders: 0, units: 0, revenue: 0 };
      d.scenarios[g].units += li.quantity;
      d.scenarios[g].revenue = round2(d.scenarios[g].revenue + paid);
      if (!seenScen.has(g)) {
        seenScen.add(g);
        d.scenarios[g].upsellOrders++;
      }

      d.upsellUnits += li.quantity;
      d.upsellRevenue = round2(d.upsellRevenue + paid);
      orderUpsellPaid = round2(orderUpsellPaid + paid);
    }
    if (orderHasUpsell) {
      d.upsellOrders++;
      d.upsellOrdersRevenue = round2(d.upsellOrdersRevenue + num(o.totalPriceSet?.shopMoney?.amount));
      d.ab[bucket].upsellOrders++;
      if (shownGroup) d.shown[shownGroup].converted++;
      d.upsellOrdersList.push({
        name: o.name,
        total: num(o.totalPriceSet?.shopMoney?.amount),
        upsellRevenue: orderUpsellPaid,
        scenarios: [...seenScen],
      });
    }
  }

  // --- Order-Index fuer Recovery-Zuordnung (13.08.2026) --------------------
  // AbandonedCheckout hat KEIN order-Feld. Wird ein Checkout doch abgeschlossen
  // (completedAt), entsteht eine Bestellung, deren createdAt praktisch identisch
  // mit completedAt ist (verifiziert: 1 Sek. Abstand). Wir ordnen die echte
  // Bestellnummer ueber Zeitnaehe + Betrag zu (Untergrenze: sehr zuverlaessig
  // bei exaktem Betrag im 10-Min-Fenster).
  const orderIndex = orders.map((o) => ({
    name: o.name,
    t: new Date(o.createdAt).getTime(),
    total: num(o.totalPriceSet?.shopMoney?.amount),
  }));
  const matchOrder = (completedAt, value) => {
    if (!completedAt) return '';
    const ct = new Date(completedAt).getTime();
    const cands = orderIndex.filter((o) => Math.abs(o.t - ct) <= 10 * 60 * 1000);
    if (!cands.length) return '';
    const exact = cands.filter((o) => Math.abs(o.total - value) < 0.05);
    const pool = exact.length ? exact : cands;
    pool.sort((a, b) => Math.abs(a.t - ct) - Math.abs(b.t - ct));
    return pool[0].name || '';
  };

  // --- Abgebrochene Checkouts (11.08.2026) ---------------------------------
  // Defensiv: Schlaegt die Abandoned-Query fehl (z.B. fehlende Berechtigung),
  // laeuft der Rest des Datenlaufs normal weiter; das Dashboard zeigt dann
  // einen Hinweis statt der Abbruch-Sektion (abandonedAvailable=false).
  let abandonedAvailable = true;
  try {
    let aCursor = null;
    for (let page = 0; page < 100; page++) {
      const data = await gql(ABANDONED_QUERY, { cursor: aCursor, q });
      const conn = data.abandonedCheckouts;
      for (const n of conn.nodes) {
        const date = n.createdAt.slice(0, 10);
        days[date] ??= emptyDay();
        const a = days[date].abandoned;
        // Warenkorb-Recovery (13.08.2026): Shopify setzt completedAt, sobald
        // der Kunde DENSELBEN Checkout doch noch abschliesst (Recovery-Mail
        // oder spaetere Sitzung). Diese Faelle getrennt zaehlen statt
        // verwerfen. Hinweis: Wer spaeter einen KOMPLETT NEUEN Checkout
        // startet, wird von Shopify nicht mit dem alten verknuepft -> die
        // echte Rueckkehr-Quote liegt tendenziell hoeher (Untergrenze).
        if (n.completedAt) {
          // Recovery je A/B-Bucket zaehlen (unabhaengig vom Deal-Filter), damit
          // die A/B-Auswertung Test vs. Control vergleichen kann.
          const rAbVal = (n.customAttributes || []).find((x) => x.key === AB_ATTR)?.value;
          a.recAb[rAbVal === 'test' || rAbVal === 'control' ? rAbVal : 'none']++;
          // Recovery-KACHEL nur fuer Deal-Warenkoerbe (Wunsch Alina, 13.08.2026):
          // Ein zurueckgeholter Warenkorb ohne angezeigten Deal sagt nichts
          // ueber die Wirkung des Deals aus -> nur zaehlen, wenn der Deal
          // in diesem Checkout angezeigt wurde (_sevn_upsell_shown gesetzt).
          const dealShown = (n.customAttributes || []).some((x) => x.key === SHOWN_ATTR);
          if (dealShown) {
            a.recovered++;
            a.recoveredRevenue = round2(a.recoveredRevenue + num(n.totalPriceSet?.shopMoney?.amount));
            a.recoveredList.push({
              name: n.name || '',
              order: matchOrder(n.completedAt, num(n.totalPriceSet?.shopMoney?.amount)),
              created: n.createdAt,
              completed: n.completedAt,
              value: num(n.totalPriceSet?.shopMoney?.amount),
            });
          }
          continue; // NICHT als offenen Abbruch zaehlen (auch ohne Deal)
        }
        a.total++;
        a.revenue = round2(a.revenue + num(n.totalPriceSet?.shopMoney?.amount));
        const attrs = n.customAttributes || [];
        if (attrs.some((x) => x.key === SHOWN_ATTR)) a.shown++;
        if (attrs.some((x) => x.key === ACTIVATED_ATTR)) a.activated++;
        const abVal = attrs.find((x) => x.key === AB_ATTR)?.value;
        a.ab[abVal === 'test' || abVal === 'control' ? abVal : 'none']++;
      }
      if (!conn.pageInfo.hasNextPage) break;
      aCursor = conn.pageInfo.endCursor;
    }
  } catch (e) {
    abandonedAvailable = false;
    console.error('WARNUNG: Abgebrochene Checkouts nicht verfuegbar:', e.message);
  }

  // --- Shop-Sessions fuer die Conversion-Rate (18.08.2026) ------------------
  // ShopifyQL (Shopify Analytics): Sessions pro Tag, gleiche Zahl wie im
  // Shopify-Admin unter Analytics. Braucht ggf. zusaetzlichen Scope
  // (read_reports) -> defensiv, Dashboard zeigt sonst einen Hinweis.
  let sessionsAvailable = true;
  try {
    const sq = `FROM sessions SHOW sessions GROUP BY day SINCE ${SINCE} UNTIL today ORDER BY day ASC`;
    const data = await gql(
      `query SevnSessions($sq: String!) { shopifyqlQuery(query: $sq) { parseErrors tableData { rows } } }`,
      { sq },
    );
    const rows = data.shopifyqlQuery?.tableData?.rows || [];
    for (const r of rows) {
      const date = String(r.day).slice(0, 10);
      days[date] ??= emptyDay();
      days[date].sessions = parseInt(r.sessions || '0', 10) || 0;
    }
    if (!rows.length) sessionsAvailable = false;
  } catch (e) {
    sessionsAvailable = false;
    console.error('WARNUNG: Sessions (Conversion) nicht verfuegbar:', e.message);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    since: SINCE,
    currency,
    abandonedAvailable,
    sessionsAvailable,
    journeyAvailable,
    days: Object.entries(days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({
        date,
        ...d,
        totalRevenue: round2(d.totalRevenue),
        ab: Object.fromEntries(
          Object.entries(d.ab).map(([k, v]) => [
            k,
            { ...v, revenue: round2(v.revenue) },
          ]),
        ),
      })),
  };

  const totalOrders = out.days.reduce((s, d) => s + d.orders, 0);
  const totalUpsell = out.days.reduce((s, d) => s + d.upsellOrders, 0);
  const totalRev = round2(out.days.reduce((s, d) => s + d.upsellRevenue, 0));

  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/data.json', JSON.stringify(out, null, 1));
  const totalAbandoned = out.days.reduce((s, d) => s + (d.abandoned?.total || 0), 0);
  console.log(
    `OK: ${totalOrders} Bestellungen seit ${SINCE} an ${out.days.length} Tagen, davon ${totalUpsell} mit Upsell, Upsell-Umsatz ${totalRev} ${currency}. Abgebrochene Checkouts: ${abandonedAvailable ? totalAbandoned : 'nicht verfuegbar'}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
