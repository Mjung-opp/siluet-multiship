// Server side glue between Shopify, the rules engine and DHL.
import { dhlFor } from "./settings.server.js";
import { quoteMultiship, shippingTotal } from "./src/quote.js";

const AED_TO_USD = 1 / 3.6725; // AED is pegged to USD
const MAX_RECIPIENTS = 10;


export class InputError extends Error {}

/** Check and normalise what the cart block sends. */
export function parseRequest(body) {
  if (!body || !Array.isArray(body.recipients)) throw new InputError("Missing recipients");
  const recipients = body.recipients.slice(0, MAX_RECIPIENTS + 1);
  if (recipients.length < 2) throw new InputError("Add at least two addresses");
  if (recipients.length > MAX_RECIPIENTS) throw new InputError(`Up to ${MAX_RECIPIENTS} addresses per order`);

  const clean = recipients.map((r, i) => {
    const a = r.address || {};
    const need = { name: a.name, address1: a.address1, city: a.city, countryCode: a.countryCode, phone: a.phone };
    for (const [k, v] of Object.entries(need)) {
      if (!v || !String(v).trim()) throw new InputError(`Address ${i + 1}: ${k} is missing`);
    }
    const lines = (r.lines || [])
      .map((l) => ({ variantId: String(l.variantId), quantity: Math.floor(Number(l.quantity)) }))
      .filter((l) => l.quantity > 0);
    if (!lines.length) throw new InputError(`Address ${i + 1} has no items`);
    if (lines.some((l) => !/^\d+$/.test(l.variantId) || l.quantity > 50)) throw new InputError("Invalid item");
    return {
      id: String(r.id || `r${i + 1}`).slice(0, 20),
      address: {
        name: String(a.name).trim().slice(0, 45),
        phone: String(a.phone || "").trim().slice(0, 30),
        address1: String(a.address1).trim().slice(0, 100),
        address2: String(a.address2 || "").trim().slice(0, 100),
        city: String(a.city).trim().slice(0, 60),
        provinceCode: String(a.provinceCode || "").trim().toUpperCase().slice(0, 10),
        zip: String(a.zip || "").trim().slice(0, 20),
        countryCode: String(a.countryCode).trim().toUpperCase().slice(0, 2),
      },
      lines,
    };
  });

  const currency = String(body.currency || "USD").toUpperCase().slice(0, 3);
  const rate = Number(body.rate) > 0 ? Number(body.rate) : 1;
  const ddpChoices = typeof body.ddp === "object" && body.ddp ? body.ddp : {};
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 120) : "";
  return { recipients: clean, currency, rate, ddpChoices, email };
}

/** Look up SKU, title and price (shop currency) for every variant. Never trust prices from the browser. */
export async function loadVariants(admin, variantIds) {
  const ids = [...new Set(variantIds)].map((id) => `gid://shopify/ProductVariant/${id}`);
  const res = await admin.graphql(
    `#graphql
    query MultishipVariants($ids: [ID!]!) {
      shop { currencyCode }
      nodes(ids: $ids) {
        ... on ProductVariant { id sku price displayName }
      }
    }`,
    { variables: { ids } },
  );
  const { data } = await res.json();
  const map = {};
  for (const n of data.nodes || []) {
    if (n?.id) map[n.id.split("/").pop()] = { sku: n.sku, price: Number(n.price), title: n.displayName };
  }
  return { variants: map, shopCurrency: data.shop.currencyCode };
}

/** Full quote. Returns the engine result plus the enriched recipients. */
export async function quote(admin, parsed, settings) {
  const allIds = parsed.recipients.flatMap((r) => r.lines.map((l) => l.variantId));
  const { variants, shopCurrency } = await loadVariants(admin, allIds);

  const recipients = parsed.recipients.map((r) => ({
    ...r,
    lines: r.lines.map((l) => {
      const v = variants[l.variantId];
      if (!v) throw new InputError("An item in your cart is no longer available");
      return { ...l, sku: v.sku, title: v.title, unitPrice: v.price };
    }),
  }));

  const result = await quoteMultiship({
    shopCurrency,
    dhlCurrency: "AED",
    dhlFx: { [`AED->${shopCurrency}`]: shopCurrency === "AED" ? 1 : AED_TO_USD },
    presentment: { currency: parsed.currency, rate: parsed.rate },
    recipients: recipients.map((r) => ({
      id: r.id,
      address: { countryCode: r.address.countryCode, city: r.address.city, postalCode: r.address.zip, provinceCode: r.address.provinceCode },
      lines: r.lines,
    })),
  }, dhlFor(settings));

  return { result, recipients, shopCurrency };
}

/** What the browser is allowed to see (no DHL costs). */
export function publicQuote(result) {
  return {
    freeRecipientId: result.freeRecipientId,
    quotes: result.quotes.map((q) => ({
      id: q.id,
      itemCount: q.itemCount,
      free: q.free,
      shipping: q.shipping,
      ddp: q.ddp,
    })),
  };
}

export { shippingTotal };
