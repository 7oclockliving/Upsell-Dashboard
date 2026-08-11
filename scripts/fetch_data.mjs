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

const ORDERS_QUERY = `
  query SevnOrders($cursor: String, $q: String!) {
    orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        createdAt
        totalPriceSet { shopMoney { amount currencyCode } }
        customAttributes { key value }
        lineItems(first: 100) {
          nodes {
            title
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
  const orders = [];
  let cursor = null;
  const q = `created_at:>=${SINCE}`;
  for (let page = 0; page < 100; page++) {
    const data = await gql(ORDERS_QUERY, { cursor, q });
    const conn = data.orders;
    orders.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
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
    shown: {}, // Szenario-Gruppe -> {shown, converted} (Anzeige-Tracking, ab App v18)
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
    d.orders++;
    d.totalRevenue += num(o.totalPriceSet?.shopMoney?.amount);
    currency = o.totalPriceSet?.shopMoney?.currencyCode || currency;

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

    let orderHasUpsell = false;
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
    }
    if (orderHasUpsell) {
      d.upsellOrders++;
      d.upsellOrdersRevenue = round2(d.upsellOrdersRevenue + num(o.totalPriceSet?.shopMoney?.amount));
      d.ab[bucket].upsellOrders++;
      if (shownGroup) d.shown[shownGroup].converted++;
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    since: SINCE,
    currency,
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
  console.log(
    `OK: ${totalOrders} Bestellungen seit ${SINCE} an ${out.days.length} Tagen, davon ${totalUpsell} mit Upsell, Upsell-Umsatz ${totalRev} ${currency}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
