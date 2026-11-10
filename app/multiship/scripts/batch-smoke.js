// Dev store + DHL sandbox only: create a single address order, then run a label batch for it and the
// latest multi address order. Uses a test sender phone that is never saved.
import fs from "node:fs";
import db from "../../db.server.js";
import { getSettings } from "../settings.server.js";
import { createLabelBatch, listOpenOrders } from "../shipments.server.js";

const url = process.argv[2];
const admin = { graphql: (query, { variables } = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) }) };
const gql = async (q, v) => (await admin.graphql(q, { variables: v })).json();

// 1. A single address US order (2 x Paris Gold, 1 x Delhi)
const variants = await gql(`{ productVariants(first: 10) { nodes { id sku } } }`);
const bySku = Object.fromEntries(variants.data.productVariants.nodes.map((v) => [v.sku, v.id]));
const d = await gql(`mutation($i: DraftOrderInput!) { draftOrderCreate(input: $i) { draftOrder { id } userErrors { message } } }`, { i: {
  email: "test.buyer@example.com",
  lineItems: [{ variantId: bySku["SGD-PARIS"], quantity: 2 }, { variantId: bySku["MMB-DELHI"], quantity: 1 }],
  shippingAddress: { firstName: "Lisa", lastName: "Grant", address1: "200 Congress Ave", city: "Austin", provinceCode: "TX", zip: "78701", countryCode: "US", phone: "+15125550123" },
  shippingLine: { title: "Standard", priceWithCurrency: { amount: "0.00", currencyCode: "USD" } },
} });
const c = await gql(`mutation($id: ID!) { draftOrderComplete(id: $id, paymentPending: false) { draftOrder { order { name legacyResourceId } } userErrors { message } } }`, { id: d.data.draftOrderCreate.draftOrder.id });
const single = c.data.draftOrderComplete.draftOrder.order;
console.log("single order", single.name);

// 2. Pick it plus the latest multi address order still open
const open = await listOpenOrders(admin);
const multi = open.find((o) => o.customAttributes.some((a) => a.key === "_multiship_id"));
const ids = [single.legacyResourceId, ...(multi ? [multi.legacyResourceId] : [])];
console.log("batch for", open.filter((o) => ids.includes(o.legacyResourceId)).map((o) => o.name).join(", "));

const settings = await getSettings("siluet-multiship-test.myshopify.com");
settings.sender.phone ||= "+97140000000"; // sandbox test only, not saved
settings.sender.contactName ||= "Siluet Studio";
const out = await createLabelBatch({ admin, shop: "siluet-multiship-test.myshopify.com", settings, orderIds: ids });
console.log(JSON.stringify({ ...out, summary: out.summary }, null, 1));
const b = await db.labelBatch.findUnique({ where: { id: out.batchId } });
if (b.pdf) { fs.writeFileSync("/tmp/batch.pdf", Buffer.from(b.pdf, "base64")); console.log("saved /tmp/batch.pdf"); }
const st = await gql(`query($id: ID!) { order(id: $id) { displayFulfillmentStatus fulfillments { trackingInfo { number url } } } }`, { id: `gid://shopify/Order/${single.legacyResourceId}` });
console.log(JSON.stringify(st.data.order));
