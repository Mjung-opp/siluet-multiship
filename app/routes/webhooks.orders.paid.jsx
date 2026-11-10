// orders/paid: link a paid multi address order to its saved plan. Labels are created from the app page.
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  const attr = (payload.note_attributes || []).find((a) => a.name === "_multiship_id");
  if (!attr) return new Response(); // normal single address order

  const record = await db.multishipCheckout.findUnique({ where: { id: attr.value } });
  if (!record || record.shop !== shop) {
    console.warn(`[multiship] ${topic}: no plan ${attr.value} for ${shop}`);
    return new Response();
  }
  if (record.status !== "draft") return new Response(); // webhooks can arrive twice

  await db.multishipCheckout.update({
    where: { id: record.id },
    data: { status: "paid", orderId: String(payload.id), orderName: payload.name },
  });
  console.log(`[multiship] ${payload.name} paid, ready for DHL labels`);
  return new Response();
};
