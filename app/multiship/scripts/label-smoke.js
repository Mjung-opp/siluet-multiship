// Sandbox only: create DHL test labels for the latest paid plan, with test phone numbers. Saves PDFs to /tmp.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { createShipmentsForPlan } from "../shipments.server.js";

const db = new PrismaClient();
const rec = await db.multishipCheckout.findFirst({ where: { orderName: { not: null } }, orderBy: { createdAt: "desc" } });
const plan = JSON.parse(rec.payload);
plan.recipients.forEach((r) => { r.address.phone ||= "+447700900000"; }); // sandbox test numbers only
const out = await createShipmentsForPlan({ order: { name: rec.orderName }, plan });
for (const s of out) {
  console.log(s.letter, s.name, s.country, s.trackingNumber || "FAILED", s.error || "", s.detail ? JSON.stringify(s.detail).slice(0, 600) : "");
  (s.documents || []).forEach((d) => { const f = `/tmp/${rec.orderName.replace("#", "")}-${s.letter}-${d.typeCode}.pdf`; fs.writeFileSync(f, Buffer.from(d.content, "base64")); console.log("  saved", f); });
}
await db.$disconnect();
