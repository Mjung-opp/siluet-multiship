// Dev store only: create labels for the latest paid plan and add per-address tracking in Shopify,
// using the CLI GraphiQL proxy as the admin client.
import { PrismaClient } from "@prisma/client";
import { createShipmentsForPlan, fulfillInShopify } from "../shipments.server.js";

const url = process.argv[2];
const admin = { graphql: (query, { variables } = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) }) };
const db = new PrismaClient();
const rec = await db.multishipCheckout.findFirst({ where: { orderName: { not: null } }, orderBy: { updatedAt: "desc" } });
const plan = JSON.parse(rec.payload);
let shipments = await createShipmentsForPlan({ order: { name: rec.orderName }, plan });
shipments = await fulfillInShopify(admin, rec.orderId, shipments);
for (const s of shipments) console.log(rec.orderName, s.letter, s.country, s.trackingNumber || s.error, "fulfilled:", s.fulfilled, s.fulfilError || "");
const r = await admin.graphql(`query($id: ID!){ order(id:$id){ displayFulfillmentStatus fulfillments{ trackingInfo{ number } fulfillmentLineItems(first:10){ nodes{ lineItem{ title } quantity } } } } }`, { variables: { id: `gid://shopify/Order/${rec.orderId}` } });
console.log(JSON.stringify((await r.json()).data, null, 1));
await db.$disconnect();
