// Siluet tracking page: siluet.co/apps/multiship/track
// ?t=<DHL tracking number> (link in Shopify shipping emails) or order number + email.
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getSettings, dhlFor } from "../multiship/settings.server.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS = {
  delivered: "Delivered",
  transit: "On its way",
  "pre-transit": "Label created, waiting for DHL",
  failure: "Delivery problem, DHL is on it",
  unknown: "Waiting for DHL's first scan",
};

async function trackOne(dhl, tn) {
  try {
    const res = await dhl.track(tn);
    const s = res.shipments?.[0] || {};
    const events = (s.events || []).map((e) => ({
      when: `${e.date || ""} ${e.time || ""}`.trim(),
      what: e.description || e.typeCode || "",
      where: e.serviceArea?.[0]?.description || "",
    }));
    const latest = s.status || {};
    const code = latest.statusCode || (events.length ? "transit" : "unknown");
    return { tn, status: STATUS[code] || latest.description || STATUS.transit, eta: s.estimatedDeliveryDate || s.estimatedTimeOfDelivery || "", events };
  } catch {
    return { tn, status: STATUS.unknown, events: [] };
  }
}

function page(body) {
  return `
<style>
  .sl-track{max-width:640px;margin:48px auto;padding:0 16px;color:#1c2841}
  .sl-track h1{font-size:1.75rem;margin:0 0 8px}
  .sl-track p{line-height:1.5}
  .sl-track form{display:grid;gap:12px;margin:24px 0}
  .sl-track input{min-height:48px;padding:10px 12px;border:1px solid #c9ccd6;font:inherit;font-size:16px}
  .sl-track button{min-height:48px;background:#1c2841;color:#faf8f4;border:0;font:inherit;font-weight:600;letter-spacing:.04em;cursor:pointer}
  .sl-card{border:1px solid #e3e4ea;background:#faf8f4;padding:16px;margin:16px 0}
  .sl-card h2{font-size:1.1rem;margin:0 0 4px}
  .sl-status{font-weight:600;margin:4px 0 12px}
  .sl-events{list-style:none;padding:0;margin:0;border-left:2px solid #1c2841}
  .sl-events li{padding:0 0 14px 14px;position:relative}
  .sl-events li:before{content:"";position:absolute;left:-6px;top:6px;width:10px;height:10px;border-radius:50%;background:#1c2841}
  .sl-muted{opacity:.7;font-size:.875em}
</style>
<div class="sl-track">${body}</div>`;
}

function cards(results) {
  return results.map((r) => `
    <div class="sl-card">
      <h2>${esc(r.label)}</h2>
      <div class="sl-muted">DHL Express ${esc(r.tn)}</div>
      <div class="sl-status">${esc(r.status)}${r.eta ? ` · expected ${esc(String(r.eta).slice(0, 10))}` : ""}</div>
      ${r.events.length ? `<ul class="sl-events">${r.events.map((e) => `<li><strong>${esc(e.what)}</strong><br><span class="sl-muted">${esc(e.when)}${e.where ? ` · ${esc(e.where)}` : ""}</span></li>`).join("")}</ul>` : ""}
    </div>`).join("");
}

const form = (msg = "") => `
  <h1>Track your Siluet</h1>
  <p>Enter your order number and the email you used at checkout.</p>
  ${msg ? `<p><strong>${esc(msg)}</strong></p>` : ""}
  <form method="get">
    <input name="order" placeholder="Order number, e.g. #1234" required>
    <input name="email" type="email" placeholder="Email" required>
    <button type="submit">Track</button>
  </form>`;

export const loader = async ({ request }) => {
  const { liquid, admin, session } = await authenticate.public.appProxy(request);
  if (!session) return liquid(page(form("Tracking is not available right now.")));
  const url = new URL(request.url);
  const settings = await getSettings(session.shop);
  const dhl = dhlFor(settings);

  const t = (url.searchParams.get("t") || "").replace(/\D/g, "");
  if (t) {
    const s = await db.shipment.findFirst({ where: { shop: session.shop, trackingNumber: t } });
    if (!s) return liquid(page(form("We could not find that tracking number.")));
    const r = await trackOne(dhl, t);
    return liquid(page(`<h1>Your Siluet is on its way</h1><p>Order ${esc(s.orderName)}</p>${cards([{ ...r, label: s.letter !== "-" ? `Parcel ${s.letter}` : "Your parcel" }])}`));
  }

  const orderNo = (url.searchParams.get("order") || "").trim();
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  if (!orderNo || !email) return liquid(page(form()));

  const name = orderNo.startsWith("#") ? orderNo : `#${orderNo}`;
  const rows = await db.shipment.findMany({ where: { shop: session.shop, orderName: name, trackingNumber: { not: null } } });
  if (!rows.length) return liquid(page(form("No parcels found yet. If you ordered recently, your Siluet may still be in the workshop.")));
  const res = await admin.graphql(`#graphql
    query($id: ID!) { order(id: $id) { email } }`, { variables: { id: `gid://shopify/Order/${rows[0].orderId}` } });
  const orderEmail = ((await res.json()).data?.order?.email || "").toLowerCase();
  if (!orderEmail || orderEmail !== email) return liquid(page(form("That order number and email don't match.")));

  const results = await Promise.all(rows.map(async (s) => ({
    ...(await trackOne(dhl, s.trackingNumber)),
    label: rows.length > 1 ? `To ${s.name.split(" ")[0]} · ${s.country}` : "Your parcel",
  })));
  return liquid(page(`<h1>Your Siluet</h1><p>Order ${esc(name)}</p>${cards(results)}`));
};
