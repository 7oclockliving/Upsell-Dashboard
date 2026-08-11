/**
 * ============================================================================
 * fetch_data.mjs – Datenabruf für das SEVN Upsell-Dashboard (7 o'clock)
 *
 * Läuft täglich in GitHub Actions (siehe .github/workflows/update.yml) und
 * schreibt docs/data.json, das von docs/index.html (GitHub Pages) geladen
 * wird.
 *
 * Datenquelle: Shopify Admin GraphQL API (2026-07).
 * Erkennung der Upsell-Käufe: Line-Item-Attribut "_sevn_upsell"
 *   (Wert = Szenario-/Mapping-Handle, z.B. "geschirr-matt").
 * A/B-Zuordnung: Order-Attribut "_sevn_ab_upsell" ("test" | "control").
 *
 * Env-Variablen (GitHub Secrets):
 *   SHOPIFY_SHOP        z.B. "7oclock-de.myshopify.com"
 *   SEVN_CLIENT_ID      Client-ID der App "sevn-checkout-upsell" (Dev Dashboard)
 *   SEVN_CLIENT_SECRET  Client-Secret derselben App
 *   (alternativ SHOPIFY_TOKEN = fertiger Admin-Token shpat_… mit read_orders)
 *
 * Auth: Client-Credentials-Grant der eigenen App (Tokens sind kurzlebig und
 * werden pro Lauf frisch geholt) – die App braucht dafür den Scope
 * read_orders (ab Version 17, Reinstall im Dev Dashboard nötig).
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

if (!TOKEN && (!CLIENT_ID || !CLIENT_SECRET)) {
  console.error(
    'Secrets fehlen: SEVN_CLIENT_ID + SEVN_CLIENT_SECRET (oder SHOPIFY_TOKEN).',
  );
  process.exit(1);
}

/** Kurzlebigen Admin-Token via Client-Credentials-Grant holen (einmal pro Lauf) */
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
        name
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
            product { id }
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

async function main() {
  const orders = [];
  let cursor = null;
  const q = `created_at:>=${SINCE}`;
  for (let page = 0; page < 60; page++) {
    const data = await gql(ORDERS_QUERY, { cursor, q });
    const conn = data.orders;
    orders.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  const products = {}; // key: title
  const scenarios = {}; // key: group
  const daily = {}; // key: yyyy-mm-dd
  const ab = {
    test: { orders: 0, upsellOrders: 0, revenue: 0 },
    control: { orders: 0, upsellOrders: 0, revenue: 0 },
    none: { orders: 0, upsellOrders: 0, revenue: 0 },
  };
  let upsellRevenue = 0;
  let upsellUnits = 0;
  let upsellOrderCount = 0;
  let currency = 'EUR';

  for (const o of orders) {
    const day = o.createdAt.slice(0, 10);
    daily[day] ??= { orders: 0, upsellOrders: 0, upsellRevenue: 0 };
    daily[day].orders++;

    const abVal =
      (o.customAttributes || []).find((a) => a.key === AB_ATTR)?.value || 'none';
    const bucket = ab[abVal] ? abVal : 'none';
    ab[bucket].orders++;
    ab[bucket].revenue += num(o.totalPriceSet?.shopMoney?.amount);
    currency = o.totalPriceSet?.shopMoney?.currencyCode || currency;

    let orderHasUpsell = false;
    for (const li of o.lineItems.nodes) {
      const marker = (li.customAttributes || []).find(
        (a) => a.key === UPSELL_ATTR,
      )?.value;
      if (!marker) continue;
      orderHasUpsell = true;

      const gross = num(li.originalTotalSet?.shopMoney?.amount);
      const paid = num(li.discountedTotalSet?.shopMoney?.amount);

      products[li.title] ??= {
        title: li.title,
        units: 0,
        orders: 0,
        revenue: 0,
        discountGiven: 0,
        scenarios: {},
      };
      const p = products[li.title];
      p.units += li.quantity;
      p.orders++;
      p.revenue += paid;
      p.discountGiven += Math.max(0, gross - paid);
      p.scenarios[scenarioGroup(marker)] =
        (p.scenarios[scenarioGroup(marker)] || 0) + li.quantity;

      const g = scenarioGroup(marker);
      scenarios[g] ??= { name: g, upsellOrders: 0, units: 0, revenue: 0 };
      scenarios[g].units += li.quantity;
      scenarios[g].revenue += paid;

      upsellRevenue += paid;
      upsellUnits += li.quantity;
      daily[day].upsellRevenue += paid;
    }
    if (orderHasUpsell) {
      upsellOrderCount++;
      daily[day].upsellOrders++;
      ab[bucket].upsellOrders++;
      // Ein Order zählt je Szenario nur einmal:
      const seen = new Set();
      for (const li of o.lineItems.nodes) {
        const marker = (li.customAttributes || []).find(
          (a) => a.key === UPSELL_ATTR,
        )?.value;
        if (!marker) continue;
        const g = scenarioGroup(marker);
        if (!seen.has(g)) {
          seen.add(g);
          scenarios[g].upsellOrders++;
        }
      }
    }
  }

  const round2 = (x) => Math.round(x * 100) / 100;
  const out = {
    generatedAt: new Date().toISOString(),
    since: SINCE,
    currency,
    totals: {
      orders: orders.length,
      upsellOrders: upsellOrderCount,
      takeRatePct: orders.length
        ? round2((upsellOrderCount / orders.length) * 100)
        : 0,
      upsellUnits,
      upsellRevenue: round2(upsellRevenue),
    },
    ab: Object.fromEntries(
      Object.entries(ab).map(([k, v]) => [
        k,
        {
          orders: v.orders,
          upsellOrders: v.upsellOrders,
          takeRatePct: v.orders ? round2((v.upsellOrders / v.orders) * 100) : 0,
          aov: v.orders ? round2(v.revenue / v.orders) : 0,
        },
      ]),
    ),
    products: Object.values(products)
      .map((p) => ({ ...p, revenue: round2(p.revenue), discountGiven: round2(p.discountGiven) }))
      .sort((a, b) => b.revenue - a.revenue),
    scenarios: Object.values(scenarios)
      .map((s) => ({ ...s, revenue: round2(s.revenue) }))
      .sort((a, b) => b.revenue - a.revenue),
    daily: Object.entries(daily)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v, upsellRevenue: round2(v.upsellRevenue) })),
  };

  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/data.json', JSON.stringify(out, null, 2));
  console.log(
    `OK: ${orders.length} Bestellungen seit ${SINCE}, davon ${upsellOrderCount} mit Upsell (${out.totals.takeRatePct} %), Upsell-Umsatz ${out.totals.upsellRevenue} ${currency}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
