// Smoke test of the app's server flow with a fake Shopify admin and the real DHL sandbox.
import { parseRequest, quote, publicQuote } from "../server.js";
import { buildDecOrders } from "../dec.server.js";

const catalog = {
  "111": { sku: "LMB-ABU DHABI", price: "245.00", displayName: "Abu Dhabi - Large / No" },
  "222": { sku: "SGD-PARIS", price: "125.00", displayName: "Paris Gold - Small" },
  "333": { sku: "GPAUH3040LB", price: "165.00", displayName: "Abu Dhabi Tracks - Black" },
};
const admin = {
  async graphql(_q, { variables }) {
    const nodes = variables.ids.map((gid) => {
      const id = gid.split("/").pop();
      return catalog[id] ? { id: gid, ...catalog[id] } : null;
    });
    return { json: async () => ({ data: { shop: { currencyCode: "USD" }, nodes } }) };
  },
};

const body = {
  currency: "GBP", rate: 0.78, ddp: { b: true },
  recipients: [
    { id: "a", address: { name: "Ana Silva", address1: "1 Sheikh Zayed Rd", city: "Dubai", countryCode: "AE", phone: "+971500000000" }, lines: [{ variantId: "333", quantity: 2 }] },
    { id: "b", address: { name: "Tom Hart", address1: "10 Downing St", city: "London", zip: "SW1A 2AA", countryCode: "GB" }, lines: [{ variantId: "111", quantity: 1 }, { variantId: "222", quantity: 1 }] },
    { id: "c", address: { name: "Joe Bloggs", address1: "350 5th Ave", city: "New York", zip: "10118", provinceCode: "NY", countryCode: "US" }, lines: [{ variantId: "222", quantity: 1 }] },
  ],
};

const parsed = parseRequest(body);
const { result, recipients } = await quote(admin, parsed);
console.log(JSON.stringify(publicQuote(result), null, 1));
const decs = buildDecOrders({ order: { name: "#9999", created_at: new Date().toISOString(), currency: "GBP", email: "test@example.com" }, plan: { recipients, ddpChoices: parsed.ddpChoices, quote: result } });
for (const d of decs) console.log(d.order.order_number, d.order.carrier_service_code, d.order.incoterm, d.order.destination.country, d.order.packages.length, "pkg");
