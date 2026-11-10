// Orders: every paid order waiting to ship. Select, create DHL labels, print one PDF. Pickup booked automatically.
import { useLoaderData, useFetcher } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getSettings, pickupDay } from "../multiship/settings.server.js";
import { listOpenOrders, createLabelBatch, planForOrder } from "../multiship/shipments.server.js";

// Until DHL production access is live, real stores book by hand in MyDHL. Test labels stay on the dev store only.
const DEV_STORE = "siluet-multiship-test.myshopify.com";
const isLocked = (settings, shop) => settings.dhl.env !== "live" && shop !== DEV_STORE;

async function manualDetails(shop, order) {
  try {
    const plan = await planForOrder(shop, order);
    return plan.recipients.map((r, i) => {
      const a = r.address;
      const q = plan.quotes[r.id];
      const ddp = plan.ddpChoices?.[r.id] && q.ddp?.available;
      return {
        letter: plan.recipients.length > 1 ? String.fromCharCode(65 + i) : "",
        free: plan.quote?.freeRecipientId === r.id && plan.recipients.length > 1,
        lines: [a.name, a.company, a.address1, a.address2, [a.zip, a.city, a.provinceCode].filter(Boolean).join(" "), a.countryCode].filter(Boolean),
        phone: a.phone || "",
        items: r.lines.map((l) => `${l.quantity} x ${l.title || l.sku}`),
        parcels: q.internal.parcels.map((p) => `${p.length} x ${p.width} x ${p.height} cm, ${p.weight} kg`),
        service: q.internal.productCode === "N" ? "Domestic Express" : "Express Worldwide",
        duties: ddp ? "DDP (customer prepaid duties)" : "DAP",
      };
    });
  } catch (e) {
    return [{ error: e.message }];
  }
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const [settings, orders] = await Promise.all([getSettings(shop), listOpenOrders(admin)]);
  const ids = orders.map((o) => o.legacyResourceId);
  const shipments = await db.shipment.findMany({ where: { shop, orderId: { in: ids } } });
  const day = pickupDay();
  const pickup = await db.pickupBooking.findUnique({ where: { shop_date: { shop, date: day } } });
  const batches = await db.labelBatch.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, createdAt: true, summary: true, pickup: true, pdf: false } });
  const missingSender = !settings.sender.phone || !settings.sender.contactName;
  const locked = isLocked(settings, shop);
  const manual = locked ? Object.fromEntries(await Promise.all(orders.map(async (o) => [o.legacyResourceId, await manualDetails(shop, o)]))) : {};

  return {
    env: settings.dhl.env,
    locked,
    missingSender,
    day,
    pickup: pickup ? { confirmation: pickup.confirmation, error: pickup.error } : null,
    batches: batches.map((b) => ({ id: b.id, when: b.createdAt.toISOString().slice(0, 16).replace("T", " "), count: JSON.parse(b.summary).filter((x) => x.tracking && !x.already).length })),
    orders: orders.map((o) => {
      const multi = o.customAttributes.some((a) => a.key === "_multiship_id");
      const shipTo = multi
        ? [...new Set(o.lineItems.nodes.map((l) => l.customAttributes.find((c) => c.key === "Ship to")?.value).filter(Boolean))]
        : [`${o.shippingAddress?.name || ""}, ${o.shippingAddress?.city || ""} ${o.shippingAddress?.countryCodeV2 || ""}`];
      const mine = shipments.filter((s) => s.orderId === o.legacyResourceId);
      return {
        id: o.legacyResourceId,
        name: o.name,
        when: o.createdAt.slice(0, 10),
        multi,
        duties: Number(o.currentTotalDutiesSet?.shopMoney?.amount || 0) > 0,
        shipTo,
        pieces: o.lineItems.nodes.filter((l) => l.requiresShipping).reduce((n, l) => n + l.quantity, 0),
        manual: manual[o.legacyResourceId] || null,
        labels: mine.filter((s) => s.trackingNumber).map((s) => ({ letter: s.letter, tracking: s.trackingNumber, error: s.error })),
      };
    }),
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const orderIds = form.getAll("order").map(String);
  if (!orderIds.length) return { error: "Select at least one order." };
  const settings = await getSettings(session.shop);
  if (isLocked(settings, session.shop)) return { error: "Labels are switched off until DHL production access is live. Book these in MyDHL for now." };
  if (!settings.sender.phone) return { error: "Add your sender phone in Settings first. DHL needs it on every label." };
  return createLabelBatch({ admin, shop: session.shop, settings, orderIds });
};

function PdfButton({ batchId, children }) {
  const download = async () => {
    const res = await fetch(`/app/batch/${batchId}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `siluet-labels-${batchId.slice(-6)}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  return <s-button variant="primary" onClick={download}>{children}</s-button>;
}

export default function Orders() {
  const { orders, env, locked, day, pickup, batches, missingSender } = useLoaderData();
  const fetcher = useFetcher();
  const [picked, setPicked] = useState({});
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const toggle = (id) => setPicked((p) => ({ ...p, [id]: !p[id] }));
  const open = orders.filter((o) => !o.labels.length);
  const allOn = open.length > 0 && open.every((o) => picked[o.id]);

  return (
    <s-page heading="Orders to ship">
      {locked
        ? <s-banner tone="warning" heading="Book in MyDHL for now">DHL production access is not live yet, so labels are switched off. Each order below shows what to enter in MyDHL.</s-banner>
        : env !== "live" && <s-banner tone="warning" heading="DHL test mode">Labels are DHL sandbox labels and cannot be used to ship.</s-banner>}
      {missingSender && <s-banner tone="critical" heading="Sender details missing">Add your phone and contact name in Settings before printing labels.</s-banner>}

      {!locked && <s-section heading={`Pickup for ${day}`}>
        {pickup?.confirmation
          ? <s-paragraph>Booked with DHL. Confirmation {pickup.confirmation}.</s-paragraph>
          : pickup?.error
            ? <s-paragraph tone="critical">Pickup could not be booked: {pickup.error}</s-paragraph>
            : <s-paragraph>Not booked yet. It is booked automatically with the first labels of the day.</s-paragraph>}
      </s-section>}

      {result && (
        <s-section heading="Last batch">
          {result.error && <s-paragraph tone="critical">{result.error}</s-paragraph>}
          {result.summary?.map((s, i) => (
            <s-paragraph key={i}>
              {s.order}{s.letter ? `-${s.letter}` : ""} {s.name ? `· ${s.name}` : ""}: {s.tracking ? `DHL ${s.tracking}${s.already ? " (already labelled)" : ""}` : s.error}
              {s.fulfilError ? ` · Shopify: ${s.fulfilError}` : ""}
            </s-paragraph>
          ))}
          {result.pages > 0 && <PdfButton batchId={result.batchId}>Download {result.pages} labels to print</PdfButton>}
        </s-section>
      )}

      <s-section heading={`Waiting to ship (${orders.length})`}>
        <fetcher.Form method="post">
          <s-stack gap="base">
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={allOn} onChange={() => setPicked(allOn ? {} : Object.fromEntries(open.map((o) => [o.id, true])))} />
              <strong>Select all without labels</strong>
            </label>
            {orders.map((o) => (
              <s-box key={o.id} padding="base" borderWidth="base" borderRadius="base">
                <label style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <input type="checkbox" name="order" value={o.id} checked={!!picked[o.id]} onChange={() => toggle(o.id)} disabled={o.labels.length > 0 && !o.multi} />
                  <span>
                    <strong>{o.name}</strong> · {o.when} · {o.pieces} piece{o.pieces === 1 ? "" : "s"} · {o.multi ? `${o.shipTo.length} addresses` : "1 address"}{o.duties ? " · duties paid (DDP)" : ""}
                    <br />
                    {o.shipTo.join(" · ")}
                    {o.manual?.map((m, i) => m.error
                      ? <span key={i}><br /><em>{m.error}</em></span>
                      : (
                        <span key={i} style={{ display: "block", marginTop: 8, paddingLeft: 8, borderLeft: "2px solid #ccc" }}>
                          <strong>{m.letter ? `Shipment ${m.letter}` : "Shipment"}{m.free ? " (free shipping)" : ""}</strong> · {m.service} · {m.duties}<br />
                          {m.lines.join(", ")}{m.phone ? ` · ${m.phone}` : ""}<br />
                          {m.items.join(", ")}<br />
                          {m.parcels.map((p, j) => <span key={j}>Parcel {j + 1}: {p}<br /></span>)}
                        </span>
                      ))}
                    {o.labels.map((l) => <span key={l.tracking}><br />Label {l.letter !== "-" ? l.letter : ""} DHL {l.tracking}{l.error ? ` · ${l.error}` : ""}</span>)}
                  </span>
                </label>
              </s-box>
            ))}
            {orders.length === 0 && <s-paragraph>Nothing waiting. Lovely.</s-paragraph>}
            {!locked && <s-button type="submit" variant="primary" loading={busy || undefined} disabled={!Object.values(picked).some(Boolean) || undefined}>
              Create labels for selected
            </s-button>}
          </s-stack>
        </fetcher.Form>
      </s-section>

      {batches.length > 0 && (
        <s-section heading="Recent label batches">
          {batches.map((b) => (
            <s-stack key={b.id} direction="inline" gap="base">
              <s-text>{b.when} · {b.count} labels</s-text>
              {b.count > 0 && <PdfButton batchId={b.id}>Reprint</PdfButton>}
            </s-stack>
          ))}
        </s-section>
      )}
    </s-page>
  );
}
