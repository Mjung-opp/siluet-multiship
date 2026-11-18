// Operations parcel service: one DHL shipment per parcel packed in Operations (POST /internal/parcels).
//
// Status machine (Parcel.status):
//   pending ──DHL ok──> label_created ──Shopify fulfilment──> fulfilled
//   pending ──DHL timeout / network / 5xx (outcome unknown)──> needs_reconciliation
//   pending ──DHL 4xx (DHL refused, nothing booked)──> rejected
//   pending older than STALE_MS ──> needs_reconciliation (never resent automatically)
//   needs_reconciliation ──late DHL result──> label_created
//   needs_reconciliation ──admin reconcile dhl_shipment_found──> label_created ──> fulfilled
//   needs_reconciliation ──admin reconcile no_dhl_shipment (claim ≥ 180 s old)──> rejected
//   rejected ──late DHL result──> stays rejected, late label kept, duplicate_shipment_suspected alert
// "locked" is returned (not stored) while real labels are switched off (isLocked).
//
// The label and tracking number are saved BEFORE the Shopify fulfilment, so a crash after DHL never loses
// a label and a replay never books DHL twice. The DHL request is built once, stored, and never rebuilt.
import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import db from "../db.server";
import { buildShipmentRequest, customsMode, getOrder, planForOrder, uaeCity } from "./shipments.server.js";
import { itemKeyFromSku } from "./src/config.js";
import { pickupDay } from "./settings.server.js";
import { SHIPMENT_TIMEOUT_MS } from "./src/dhl.js";

export const STALE_MS = 120_000; // > 60 s DHL timeout + 30 s processing margin
export const RECONCILE_MIN_AGE_MS = 180_000; // 60 s DHL timeout + 120 s for in-flight retries and clock skew

/** Minimum claim age before no_dhl_shipment: PARCEL_NO_SHIPMENT_MIN_AGE_SECONDS, never below 180 s. */
export function noShipmentMinAgeMs(env = process.env) {
  const s = Number(env.PARCEL_NO_SHIPMENT_MIN_AGE_SECONDS);
  return Number.isFinite(s) && s * 1000 > RECONCILE_MIN_AGE_MS ? Math.round(s * 1000) : RECONCILE_MIN_AGE_MS;
}
export const RETENTION_MS = 90 * 24 * 3600 * 1000;
export const ALERT_WINDOW_MS = 30 * 24 * 3600 * 1000;
export const DUPLICATE_WINDOW_MS = 90 * 24 * 3600 * 1000;
export const DUPLICATE_LINECHECK_RECENT_MS = 7 * 24 * 3600 * 1000; // Shopify line check only for recent parcels
export const DUPLICATE_LINECHECK_CONCURRENCY = 4;
export const DUPLICATE_LINECHECK_MAX = 50;
const ACTIVE = ["pending", "needs_reconciliation", "label_created"];
// Parcels whose items count against a Shopify snapshot: active ones, and fulfilled ones the snapshot predates
// (their tracking number is not yet on a fulfilment in that snapshot).
const HOLDING = [...ACTIVE, "fulfilled"];
const FULFIL_ATTEMPTS = 3;

export class ParcelError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/** DHL product codes Operations may book. Owner answer Q5: P and N only, unless an admin widens it. */
export function allowedProductCodes(settings, env = process.env) {
  const fromSettings = settings?.parcel?.allowedProductCodes;
  if (Array.isArray(fromSettings) && fromSettings.length) return fromSettings.map(String);
  const fromEnv = (env.PARCEL_ALLOWED_PRODUCT_CODES || "").split(",").map((s) => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : ["P", "N"];
}

// ---------- Input ----------

const legacyOrderId = (v) => {
  const m = String(v ?? "").match(/^(?:gid:\/\/shopify\/Order\/)?(\d{1,20})$/);
  if (!m) throw new ParcelError("bad_request", "orderId must be a Shopify order ID");
  return m[1];
};
const lineItemGid = (v) => {
  const m = String(v ?? "").match(/^(?:gid:\/\/shopify\/LineItem\/)?(\d{1,20})$/);
  if (!m) throw new ParcelError("bad_request", "lineItemId must be a Shopify line item ID");
  return `gid://shopify/LineItem/${m[1]}`;
};

export function parsePieces(pieces) {
  if (!Array.isArray(pieces) || pieces.length < 1 || pieces.length > 20) throw new ParcelError("bad_request", "pieces must list 1 to 20 pieces");
  return pieces.map((p, i) => {
    const out = {};
    for (const [f, max] of [["weight", 70], ["length", 300], ["width", 300], ["height", 300]]) {
      const n = Number(p?.[f]);
      if (!Number.isFinite(n) || n <= 0 || n > max) throw new ParcelError("bad_request", `piece ${i + 1}: ${f} must be above 0 and at most ${max}`);
      out[f] = n;
    }
    return out;
  });
}

function parseCreate(input) {
  const parcelId = String(input.parcelId ?? "");
  // DHL references are at most 35 characters; packages add "-NN".
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/.test(parcelId)) throw new ParcelError("bad_request", "parcelId must be 1 to 30 letters, digits, - or _");
  const recipientId = String(input.recipientId ?? "");
  if (!/^[\w-]{1,20}$/.test(recipientId)) throw new ParcelError("bad_request", "recipientId is missing");
  const productCode = String(input.productCode ?? "");
  if (!/^[A-Z0-9]{1,3}$/.test(productCode)) throw new ParcelError("bad_request", "productCode is missing");
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) throw new ParcelError("bad_request", "lines must list the items in this parcel");
  const lines = input.lines.map((l) => {
    const quantity = Number(l?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw new ParcelError("bad_request", "line quantity must be a whole number above 0");
    return { lineItemId: lineItemGid(l?.lineItemId), quantity };
  });
  if (new Set(lines.map((l) => l.lineItemId)).size !== lines.length) throw new ParcelError("bad_request", "a line item appears twice");
  lines.sort((a, b) => a.lineItemId.localeCompare(b.lineItemId));
  return {
    parcelId, recipientId, productCode, lines,
    orderId: legacyOrderId(input.orderId),
    pieces: parsePieces(input.pieces),
    quotedPrice: input.quotedPrice ?? null,
  };
}

const hashOf = (shop, c) => crypto.createHash("sha256").update(JSON.stringify({
  shop, orderId: c.orderId, recipientId: c.recipientId, productCode: c.productCode,
  quotedPrice: c.quotedPrice, pieces: c.pieces, lines: c.lines,
})).digest("hex");

// ---------- Shopify ----------

const FO_QUERY = `#graphql
  query ParcelFOs($id: ID!) {
    order(id: $id) {
      fulfillments(first: 100) { id trackingInfo(first: 10) { number } }
      fulfillmentOrders(first: 20) {
        nodes { id status lineItems(first: 100) { nodes { id remainingQuantity lineItem { id requiresShipping customAttributes { key value } } } } }
      }
    }
  }`;

async function fulfilmentState(admin, orderId) {
  const res = await admin.graphql(FO_QUERY, { variables: { id: `gid://shopify/Order/${orderId}` } });
  const order = (await res.json()).data?.order;
  if (!order) throw new ParcelError("not_found", "Order not found", 404);
  const tracking = new Set(order.fulfillments.flatMap((f) => (f.trackingInfo || []).map((t) => t.number)));
  const fulfillmentIds = new Set(order.fulfillments.map((f) => f.id).filter(Boolean));
  const fulfillmentByTracking = new Map(order.fulfillments.flatMap((f) => (f.trackingInfo || []).map((t) => [t.number, f.id])));
  const open = order.fulfillmentOrders.nodes.filter((f) => ["OPEN", "IN_PROGRESS"].includes(f.status));
  // One entry per fulfilment-order line item that can still ship.
  const items = open.flatMap((fo) => fo.lineItems.nodes
    .filter((li) => li.remainingQuantity > 0 && li.lineItem.requiresShipping)
    .map((li) => ({
      fulfillmentOrderId: fo.id, id: li.id, lineItemId: li.lineItem.id, remainingQuantity: li.remainingQuantity,
      recipient: li.lineItem.customAttributes.find((c) => c.key === "_recipient")?.value || null,
    })));
  return { tracking, fulfillmentIds, fulfillmentByTracking, items };
}

const ownerOf = (plan, item) => (plan.type === "single" ? plan.recipients[0].id : item.recipient);

/**
 * True when the Shopify snapshot already deducted this parcel's items: its fulfilment ID is in the snapshot
 * (survives a tracking number removed or edited in Shopify), else, for rows without an ID, its tracking number.
 */
function inSnapshot(p, state) {
  if (p.shopifyFulfillmentId) return state.fulfillmentIds.has(p.shopifyFulfillmentId);
  return Boolean(p.trackingNumber && state.tracking.has(p.trackingNumber));
}

/** Quantities held by parcels of this order that the Shopify snapshot does not show yet. */
async function reserved(shop, orderId, state) {
  const rows = await db.parcel.findMany({ where: { shop, orderId, status: { in: HOLDING } } });
  const out = {};
  for (const p of rows) {
    if (inSnapshot(p, state)) continue;
    for (const l of JSON.parse(p.lines)) out[l.lineItemId] = (out[l.lineItemId] || 0) + l.quantity;
  }
  return out;
}

const remainingByLine = (items) => items.reduce((m, it) => ({ ...m, [it.lineItemId]: (m[it.lineItemId] || 0) + it.remainingQuantity }), {});

// ---------- State changes ----------

const now = (ctx) => (ctx.now ? ctx.now() : new Date());

/** pending claims older than STALE_MS become needs_reconciliation (conditional, never resent). */
export async function markStaleClaims(ctx) {
  const cutoff = new Date(now(ctx).getTime() - STALE_MS);
  return db.parcel.updateMany({
    where: { shop: ctx.shop, status: "pending", claimedAt: { lt: cutoff } },
    data: { status: "needs_reconciliation", error: "No DHL answer in time. Search MyDHL for this parcel reference before deciding." },
  });
}

async function mergeLabels(contents) {
  if (contents.length <= 1) return contents[0] || null;
  const merged = await PDFDocument.create();
  for (const c of contents) {
    const src = await PDFDocument.load(Buffer.from(c, "base64"));
    (await merged.copyPages(src, src.getPageIndices())).forEach((pg) => merged.addPage(pg));
  }
  return Buffer.from(await merged.save()).toString("base64");
}

async function alert(ctx, parcelId, type, detail) {
  (ctx.log || console).error(`[parcels] ${type} parcel=${parcelId}`);
  await db.parcelAlert.create({ data: { shop: ctx.shop, parcelId, type, detail: JSON.stringify(detail) } });
}

/**
 * Save what DHL returned, raw, in one conditional write, before any PDF work (A5).
 * If that write fails the caller gets needs_reconciliation; the log carries only the parcelId.
 */
async function saveDhlResult(ctx, parcel, res) {
  const docs = res.documents || [];
  const tn = String(res.shipmentTrackingNumber || "");
  const labels = docs.filter((d) => d.typeCode === "label").map((d) => d.content).filter(Boolean);
  // Only non-PLT shipments carry a printed invoice; under PLT the invoice goes to DHL electronically.
  const invoice = parcel.customsPaperRequired ? docs.find((d) => d.typeCode === "invoice")?.content || null : null;
  const pieceTrackingNumbers = JSON.stringify((res.packages || []).map((p) => p.trackingNumber).filter(Boolean));

  let r;
  try {
    if (!tn) throw new Error("DHL returned no tracking number");
    r = await db.parcel.updateMany({
      where: { id: parcel.id, status: { in: ["pending", "needs_reconciliation"] }, trackingNumber: null },
      data: {
        status: "label_created", trackingNumber: tn, pieceTrackingNumbers, labelDocuments: JSON.stringify(labels),
        label: labels.length === 1 ? labels[0] : null, invoice, error: null,
      },
    });
  } catch {
    (ctx.log || console).error(`[parcels] dhl_result_not_saved parcel=${parcel.id} tracking=${tn || "none"}`); // no recipient data
    const error = "DHL answered but the result could not be saved. Search MyDHL for this parcel reference before deciding.";
    try {
      await db.parcel.updateMany({ where: { id: parcel.id, status: "pending" }, data: { status: "needs_reconciliation", error } });
    } catch { /* the stale sweep moves it to needs_reconciliation after 120 s */ }
    return { ...parcel, status: "needs_reconciliation", error, trackingNumber: tn || null };
  }
  const cur = await db.parcel.findUnique({ where: { id: parcel.id } });
  if (r.count === 0 && cur.trackingNumber !== tn) {
    // Late result after the parcel moved on (rejected, or reconciled with another shipment). Never discarded.
    const lateLabel = labels.length === 1 ? labels[0] : JSON.stringify(labels);
    await db.parcel.update({ where: { id: parcel.id }, data: { lateTrackingNumber: tn, lateLabel, lateAt: now(ctx) } });
    await alert(ctx, parcel.id, "duplicate_shipment_suspected", { status: cur.status, trackingNumber: cur.trackingNumber, lateTrackingNumber: tn });
    return db.parcel.findUnique({ where: { id: parcel.id } });
  }
  return cur;
}

/** Several label documents become one PDF. A failure keeps label_created, the raw documents and an error. */
async function ensureLabel(ctx, parcel) {
  if (parcel.label || !parcel.labelDocuments) return parcel;
  try {
    const label = await mergeLabels(JSON.parse(parcel.labelDocuments));
    await db.parcel.updateMany({ where: { id: parcel.id, label: null }, data: { label, error: null } });
  } catch (e) {
    await db.parcel.updateMany({ where: { id: parcel.id }, data: { error: `Label PDF could not be prepared (${String(e?.message || e).slice(0, 120)}). The DHL documents are kept; retry.` } });
  }
  return db.parcel.findUnique({ where: { id: parcel.id } });
}

/** After a label exists: prepare the PDF, then fulfil. Nothing reaches Shopify without a printable label. */
async function afterLabel(ctx, parcel) {
  if (parcel.status !== "label_created") return parcel;
  parcel = await ensureLabel(ctx, parcel);
  if (!parcel.label && parcel.labelDocuments) return parcel;
  return fulfilParcel(ctx, parcel);
}

async function sendToDhl(ctx, parcel) {
  let res;
  try {
    res = await ctx.getDhl().createShipment(JSON.parse(parcel.requestJson), { timeoutMs: SHIPMENT_TIMEOUT_MS });
  } catch (e) {
    // A DHL 4xx means DHL refused the request: nothing was booked. Anything else (timeout, network, 5xx) is unknown.
    const refused = e.status >= 400 && e.status < 500 && e.status !== 408;
    await db.parcel.updateMany({
      where: { id: parcel.id, status: "pending" },
      data: refused
        ? { status: "rejected", error: e.message, closedAt: now(ctx) }
        : { status: "needs_reconciliation", error: `DHL outcome unknown (${e.name === "TimeoutError" ? "timeout" : e.message}). Search MyDHL for this parcel reference before deciding.` },
    });
    return db.parcel.findUnique({ where: { id: parcel.id } });
  }
  return saveDhlResult(ctx, parcel, res);
}

/** Shipment row so the tracking page (link in Shopify's shipping email) knows this tracking number. */
async function recordShipment(parcel) {
  if (await db.shipment.findFirst({ where: { shop: parcel.shop, trackingNumber: parcel.trackingNumber } })) return;
  const req = JSON.parse(parcel.requestJson);
  const receiver = req.customerDetails?.receiverDetails || {};
  await db.shipment.create({ data: {
    shop: parcel.shop, orderId: parcel.orderId, orderName: parcel.orderName || "", recipientId: parcel.recipientId, letter: "-",
    name: receiver.contactInformation?.fullName || "", country: receiver.postalAddress?.countryCode || "",
    trackingNumber: parcel.trackingNumber, fulfilled: false,
  } });
}

/** Fulfil exactly this parcel's lines with its one tracking number. Safe to repeat. */
async function fulfilParcel(ctx, parcel) {
  const markFulfilled = async (shopifyFulfillmentId) => {
    await db.parcel.updateMany({
      where: { id: parcel.id, status: "label_created" },
      data: { status: "fulfilled", error: null, closedAt: now(ctx), shopifyFulfillmentId: shopifyFulfillmentId || null },
    });
    await db.shipment.updateMany({ where: { shop: parcel.shop, trackingNumber: parcel.trackingNumber }, data: { fulfilled: true, error: null } });
    return db.parcel.findUnique({ where: { id: parcel.id } });
  };
  const fail = async (message) => {
    await db.parcel.updateMany({ where: { id: parcel.id, status: "label_created" }, data: { error: `Shopify: ${message}` } });
    return db.parcel.findUnique({ where: { id: parcel.id } });
  };

  await recordShipment(parcel);
  const admin = await ctx.getAdmin();
  const settings = ctx.settings;
  const url = `${settings.tracking.baseUrl.replace(/\/$/, "")}/apps/multiship/track?t=${parcel.trackingNumber}`;
  let lastError;
  for (let attempt = 1; attempt <= FULFIL_ATTEMPTS; attempt++) {
    try {
      const state = await fulfilmentState(admin, parcel.orderId);
      // Already fulfilled with this tracking number (an earlier attempt reached Shopify): never twice.
      if (state.tracking.has(parcel.trackingNumber)) return markFulfilled(state.fulfillmentByTracking.get(parcel.trackingNumber));
      const byFo = {};
      for (const l of JSON.parse(parcel.lines)) {
        let left = l.quantity;
        for (const it of state.items.filter((x) => x.lineItemId === l.lineItemId)) {
          const q = Math.min(left, it.remainingQuantity);
          if (q > 0) (byFo[it.fulfillmentOrderId] ||= []).push({ id: it.id, quantity: q });
          left -= q;
        }
        if (left > 0) return fail(`line ${l.lineItemId} has less left to ship than this parcel holds`);
      }
      const r = await admin.graphql(
        `#graphql
        mutation ParcelFulfil($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { message } } }`,
        { variables: { f: {
          lineItemsByFulfillmentOrder: Object.entries(byFo).map(([fulfillmentOrderId, items]) => ({ fulfillmentOrderId, fulfillmentOrderLineItems: items })),
          notifyCustomer: true, // owner answer Q6: Shopify sends its shipping email
          trackingInfo: { company: "DHL Express", number: parcel.trackingNumber, url },
        } } },
      );
      const created = (await r.json()).data?.fulfillmentCreate;
      const errs = created?.userErrors || [];
      if (errs.length) return fail(errs.map((e) => e.message).join("; "));
      return markFulfilled(created?.fulfillment?.id);
    } catch (e) {
      if (e instanceof ParcelError) throw e;
      lastError = e;
      if (attempt < FULFIL_ATTEMPTS) await (ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(500 * attempt);
    }
  }
  return fail(lastError?.message || "fulfilment failed");
}

const view = (p) => ({
  parcelId: p.id,
  status: p.status,
  trackingNumber: p.trackingNumber || null,
  pieceTrackingNumbers: p.pieceTrackingNumbers ? JSON.parse(p.pieceTrackingNumbers) : [],
  customsPaperRequired: p.customsPaperRequired,
  error: p.error || null,
  ...(p.lateTrackingNumber ? { lateTrackingNumber: p.lateTrackingNumber } : {}),
});

async function findOwn(ctx, parcelId) {
  const p = await db.parcel.findUnique({ where: { id: String(parcelId ?? "") } });
  if (!p || p.shop !== ctx.shop) throw new ParcelError("not_found", "Parcel not found", 404);
  return p;
}

// ---------- Ops ----------

/** City DHL gets for this address: the emirate for UAE addresses (uaeCity, as the shipment builder does), else the city. */
function dhlCityOf(address) {
  if (address.countryCode !== "AE") return address.city;
  try { return uaeCity(address); } catch { return null; } // create will refuse it (bad_address)
}

/**
 * Why a recipient cannot ship through the parcel service: a line whose SKU has no customs data (City Lights,
 * unknown SKUs). Nothing is invented for such lines. null when every shipping line is supported.
 */
function unsupportedReason(plan, order, recipientId) {
  const mine = order.lineItems.nodes.filter((l) => l.requiresShipping && l.quantity > 0 &&
    (plan.type === "single" || l.customAttributes?.some((a) => a.key === "_recipient" && a.value === recipientId)));
  for (const l of mine) {
    try { itemKeyFromSku(l.sku); } catch { return `No customs data for SKU ${l.sku || "(none)"}`; }
  }
  if (plan.type === "single" && !plan.quotes[recipientId]?.internal?.parcels) return "No customs data for this order";
  return null;
}

export async function planOrder(ctx, input) {
  const orderId = legacyOrderId(input.orderId);
  const admin = await ctx.getAdmin();
  const order = await getOrder(admin, orderId);
  if (!order) throw new ParcelError("not_found", "Order not found", 404);
  const plan = await planForOrder(ctx.shop, order, { allowUnsupported: true }).catch((e) => { throw new ParcelError("unsupported_order", e.message, 422); });
  const state = await fulfilmentState(admin, orderId);
  const held = await reserved(ctx.shop, orderId, state);
  const byId = Object.fromEntries(order.lineItems.nodes.map((l) => [l.id, l]));
  const recipients = plan.recipients.map((r) => {
    const q = plan.quotes[r.id];
    const mine = state.items.filter((it) => ownerOf(plan, it) === r.id);
    const remaining = remainingByLine(mine);
    const reason = unsupportedReason(plan, order, r.id);
    return {
      recipientId: r.id,
      name: r.address.name,
      city: r.address.city,
      dhlCity: dhlCityOf(r.address),
      countryCode: r.address.countryCode,
      productCode: q.internal.productCode,
      ddp: q.internal.productCode !== "N" && Boolean(plan.ddpChoices?.[r.id] && q.ddp?.available),
      supported: !reason,
      ...(reason ? { reason } : {}),
      lines: Object.entries(remaining).map(([lineItemId, n]) => {
        const li = byId[lineItemId];
        const money = li?.originalUnitPriceSet?.shopMoney;
        return {
          lineItemId, sku: li?.sku || "", title: li?.title || "",
          quantity: li?.quantity || 0, remainingQuantity: Math.max(0, n - (held[lineItemId] || 0)),
          unitPrice: money ? String(money.amount) : null, currency: money?.currencyCode || null,
        };
      }),
    };
  });
  const parcels = await db.parcel.findMany({ where: { shop: ctx.shop, orderId } });
  return {
    orderId, orderName: order.name, locked: Boolean(ctx.locked),
    ddp: recipients.some((r) => r.ddp),
    recipients,
    parcels: parcels.map((p) => ({ recipientId: p.recipientId, ...view(p) })),
  };
}

export async function parcelRates(ctx, input) {
  const d = input.destination || {};
  const countryCode = String(d.countryCode || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode) || !d.city) throw new ParcelError("bad_request", "destination needs countryCode and city");
  const allowed = allowedProductCodes(ctx.settings);
  const dhl = ctx.getDhl();
  const services = await dhl.rates({
    address: { countryCode, city: String(d.city), postalCode: d.postalCode ? String(d.postalCode) : "", provinceCode: d.provinceCode ? String(d.provinceCode) : "" },
    parcels: parsePieces(input.pieces),
    declaredValue: Number(input.declaredValue) || 0,
    currency: String(input.currency || "USD").toUpperCase().slice(0, 3),
    ddp: Boolean(input.ddp),
  }).catch((e) => {
    const msg = String(e?.message || "DHL rates failed").replace(/\s+/g, " ").slice(0, 300);
    if (e?.status >= 400 && e?.status < 500) throw new ParcelError("dhl_rates_refused", msg, 422);
    throw new ParcelError("dhl_unavailable", "DHL rates are not available right now", 502);
  });
  return { services: services.filter((s) => allowed.includes(s.productCode)) };
}

const ORDER_LOCKS = new Map();

/** Serialises check-and-claim per (shop, order) inside this process. */
async function withOrderLock(ctx, orderId, fn) {
  const locks = ctx.orderLocks || ORDER_LOCKS;
  const key = `${ctx.shop}:${orderId}`;
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  locks.set(key, chain);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}

/**
 * Insert order of this order's parcels, from SQLite's implicit rowid (read-only, parameterised). SQLite has a
 * single writer and each claim is its own committed insert, so rowid order is commit order: a claim that is not
 * yet visible to a check always gets a larger rowid than the claim doing the check. The application clock
 * (claimedAt) cannot give that guarantee, so it is not used for ordering.
 */
async function insertOrder(shop, orderId) {
  const rows = await db.$queryRaw`SELECT "id", rowid AS "seq" FROM "Parcel" WHERE "shop" = ${shop} AND "orderId" = ${orderId}`;
  return new Map(rows.map((r) => [r.id, Number(r.seq)]));
}

/**
 * After the insert: another active claim holds its lines when it was inserted before this one, when its insert
 * position is unknown, or when it already went past pending (DHL booked). Only claims inserted later and still
 * pending are ignored: their own check sees this one as earlier and rejects them. If this parcel does not fit,
 * it is rejected before DHL is called and holds nothing.
 */
async function assertClaimFits(ctx, parcel, state) {
  // Rows first, insert order second: every row read is already committed, so its rowid is in the map.
  const rows = await db.parcel.findMany({ where: { shop: ctx.shop, orderId: parcel.orderId, status: { in: HOLDING } } });
  const order = await insertOrder(ctx.shop, parcel.orderId);
  const mine = order.get(parcel.id);
  const holding = rows.filter((p) => {
    if (p.id === parcel.id || inSnapshot(p, state)) return false;
    const seq = order.get(p.id);
    if (mine === undefined || seq === undefined || p.status !== "pending") return true;
    return seq < mine;
  });
  const held = {};
  for (const p of holding) for (const l of JSON.parse(p.lines)) held[l.lineItemId] = (held[l.lineItemId] || 0) + l.quantity;
  const open = remainingByLine(state.items);
  const fits = JSON.parse(parcel.lines).every((l) => l.quantity <= (open[l.lineItemId] || 0) - (held[l.lineItemId] || 0));
  if (fits) return;
  await db.parcel.updateMany({
    where: { id: parcel.id, status: "pending", trackingNumber: null },
    data: { status: "rejected", closedAt: now(ctx), error: "quantity_conflict: another parcel claimed these items first. Pack again with a new parcel ID." },
  });
  throw new ParcelError("quantity_conflict", "Another parcel claimed these items first", 409, { parcelId: parcel.id, status: "rejected" });
}

export async function createParcel(ctx, input) {
  const c = parseCreate(input);
  const requestHash = hashOf(ctx.shop, c);

  const existing = await db.parcel.findUnique({ where: { id: c.parcelId } });
  if (existing) return replay(ctx, existing, requestHash);

  if (ctx.locked) throw new ParcelError("locked", "Real DHL labels are switched off until DHL Production is enabled by the owner", 423, { parcelId: c.parcelId, status: "locked" });
  const allowed = allowedProductCodes(ctx.settings);
  if (!allowed.includes(c.productCode)) throw new ParcelError("product_not_allowed", `DHL service ${c.productCode} is not allowed`, 422);

  const admin = await ctx.getAdmin();
  const order = await getOrder(admin, c.orderId);
  if (!order) throw new ParcelError("not_found", "Order not found", 404);
  const plan = await planForOrder(ctx.shop, order, { allowUnsupported: true }).catch((e) => { throw new ParcelError("unsupported_order", e.message, 422); });
  const index = plan.recipients.findIndex((r) => r.id === c.recipientId);
  if (index < 0) throw new ParcelError("unknown_recipient", "This order has no such recipient", 422);
  const recipient = plan.recipients[index];
  const unsupported = unsupportedReason(plan, order, c.recipientId);
  if (unsupported) throw new ParcelError("unsupported_recipient", unsupported, 422);
  if (plan.quotes[recipient.id].internal.productCode !== c.productCode) {
    throw new ParcelError("product_mismatch", `This recipient ships with DHL ${plan.quotes[recipient.id].internal.productCode}`, 422);
  }

  // Check, build and claim under a per-order lock. The lock only serialises requests inside one process; across
  // processes, assertClaimFits orders claims by database insert order (rowid) after the insert.
  const claimed = await withOrderLock(ctx, c.orderId, async () => {
    const legacy = await db.shipment.findMany({ where: { shop: ctx.shop, orderId: c.orderId, recipientId: c.recipientId, trackingNumber: { not: null } } });
    for (const sh of legacy) {
      if (!(await db.parcel.findFirst({ where: { shop: ctx.shop, trackingNumber: sh.trackingNumber } }))) {
        throw new ParcelError("legacy_label_exists", "This recipient already has a DHL label from the Multiship batch. Ship that one, or void it in MyDHL first.", 409);
      }
    }

    // Lines: each must belong to this recipient and fit in what is still open, minus other active parcels.
    const state = await fulfilmentState(admin, c.orderId);
    const held = await reserved(ctx.shop, c.orderId, state);
    const byId = Object.fromEntries(order.lineItems.nodes.map((l) => [l.id, l]));
    const dhlLines = c.lines.map((l) => {
      const items = state.items.filter((it) => it.lineItemId === l.lineItemId);
      if (!items.length || !byId[l.lineItemId]) throw new ParcelError("line_not_open", `Line ${l.lineItemId} has nothing left to ship`, 422);
      if (items.some((it) => ownerOf(plan, it) !== c.recipientId)) throw new ParcelError("line_other_recipient", `Line ${l.lineItemId} belongs to another recipient`, 422);
      const open = remainingByLine(items)[l.lineItemId];
      if (l.quantity > open) throw new ParcelError("quantity_above_remaining", `Line ${l.lineItemId}: ${l.quantity} asked, ${open} left to ship`, 422);
      if (l.quantity > open - (held[l.lineItemId] || 0)) {
        throw new ParcelError("quantity_conflict", `Line ${l.lineItemId}: another parcel already holds part of it`, 409);
      }
      const li = byId[l.lineItemId];
      return { sku: li.sku, title: li.title, quantity: l.quantity, barcode: li.variant?.barcode || "", unitPrice: Number(li.originalUnitPriceSet.shopMoney.amount) };
    });

    // Built once with the certified builder, stored, never rebuilt.
    const parcelRecipient = { ...recipient, lines: dhlLines };
    const { domestic, plt } = customsMode({ plan, recipient: parcelRecipient });
    let body;
    try {
      body = buildShipmentRequest({
        settings: ctx.settings, orderName: order.name, plan, recipient: parcelRecipient,
        letter: plan.type === "multi" ? String.fromCharCode(65 + index) : "A",
        day: pickupDay(now(ctx)), pieces: c.pieces, customerReference: c.parcelId, invoiceImage: !plt,
      });
    } catch (e) {
      throw new ParcelError(e.code === "PIECES_TOO_LIGHT" ? "pieces_too_light" : "bad_address", e.message, 422);
    }

    let parcel;
    try {
      parcel = await db.parcel.create({ data: {
        id: c.parcelId, shop: ctx.shop, orderId: c.orderId, orderName: order.name, recipientId: c.recipientId,
        productCode: c.productCode, quotedPrice: JSON.stringify(c.quotedPrice), pieces: JSON.stringify(c.pieces),
        lines: JSON.stringify(c.lines), requestHash, requestJson: JSON.stringify(body), status: "pending",
        claimedAt: now(ctx), customsPaperRequired: !domestic && !plt,
      } });
    } catch (e) {
      if (e?.code !== "P2002") throw e;
      return { replayOf: await db.parcel.findUnique({ where: { id: c.parcelId } }) };
    }
    await assertClaimFits(ctx, parcel, state);
    return { parcel };
  });
  if (claimed.replayOf) return replay(ctx, claimed.replayOf, requestHash);
  let parcel = claimed.parcel;
  parcel = await sendToDhl(ctx, parcel);
  parcel = await afterLabel(ctx, parcel);
  return view(parcel);
}

async function replay(ctx, parcel, requestHash) {
  if (parcel.shop !== ctx.shop || parcel.requestHash !== requestHash) {
    throw new ParcelError("parcel_id_conflict", "This parcelId was already used for a different parcel", 409, { parcelId: parcel.id, status: "rejected" });
  }
  if (parcel.status === "pending") {
    await markStaleClaims(ctx);
    parcel = await db.parcel.findUnique({ where: { id: parcel.id } });
  }
  parcel = await afterLabel(ctx, parcel);
  return view(parcel);
}

export async function parcelStatus(ctx, input) {
  return view(await findOwn(ctx, input.parcelId));
}

export async function parcelLabel(ctx, input) {
  let p = await findOwn(ctx, input.parcelId);
  if (!p.label && p.labelDocuments) p = await ensureLabel(ctx, p);
  if (!p.label && p.labelDocuments) {
    throw new ParcelError("label_merge_failed", p.error || "Label PDF could not be prepared", 502, { status: p.status, labelDocumentsBase64: JSON.parse(p.labelDocuments) });
  }
  if (!p.label) throw new ParcelError("no_label", "No DHL label stored for this parcel", 404, { status: p.status });
  return {
    parcelId: p.id,
    pdfBase64: p.label,
    customsPaperRequired: p.customsPaperRequired,
    ...(p.customsPaperRequired && p.invoice ? { invoicePdfBase64: p.invoice } : {}),
  };
}

export async function reconcileParcel(ctx, input) {
  const actor = input.actor;
  if (!actor || actor.role !== "admin") throw new ParcelError("forbidden", "Only an admin can reconcile a parcel", 403);
  const who = String(actor.email || actor.id || "admin").slice(0, 120);
  await markStaleClaims(ctx);
  const p = await findOwn(ctx, input.parcelId);
  if (p.status !== "needs_reconciliation") throw new ParcelError("invalid_state", `Parcel is ${p.status}, not needs_reconciliation`, 409, { status: p.status });

  if (input.decision === "no_dhl_shipment") {
    const minAge = noShipmentMinAgeMs(ctx.env);
    if (now(ctx).getTime() - new Date(p.claimedAt).getTime() < minAge) {
      throw new ParcelError("too_early", `Wait at least ${Math.round(minAge / 1000)} s after the claim before declaring no DHL shipment`, 409, { status: p.status });
    }
    await db.parcel.updateMany({
      where: { id: p.id, status: "needs_reconciliation", trackingNumber: null },
      data: { status: "rejected", closedAt: now(ctx), reconciledBy: who, reconciledAt: now(ctx), error: "No DHL shipment (admin). Pack again with a new parcel ID." },
    });
    return view(await db.parcel.findUnique({ where: { id: p.id } }));
  }
  if (input.decision === "dhl_shipment_found") {
    const tn = String(input.trackingNumber ?? "").trim();
    if (!/^[A-Za-z0-9]{6,40}$/.test(tn)) throw new ParcelError("bad_request", "trackingNumber is required");
    const taken = (await db.parcel.findFirst({ where: { trackingNumber: tn } })) || (await db.parcel.findFirst({ where: { lateTrackingNumber: tn } }));
    if (taken && taken.id !== p.id) throw new ParcelError("tracking_in_use", "This tracking number already belongs to another parcel", 409);
    const r = await db.parcel.updateMany({
      where: { id: p.id, status: "needs_reconciliation" },
      data: { status: "label_created", trackingNumber: tn, reconciledBy: who, reconciledAt: now(ctx), error: null },
    });
    let cur = await db.parcel.findUnique({ where: { id: p.id } });
    if (r.count) cur = await afterLabel(ctx, cur);
    return view(cur);
  }
  throw new ParcelError("bad_request", "decision must be no_dhl_shipment or dhl_shipment_found");
}

const redactRequest = (req) => {
  const receiver = req.customerDetails?.receiverDetails;
  if (!receiver) return req;
  return {
    ...req,
    customerDetails: {
      ...req.customerDetails,
      receiverDetails: { postalAddress: { countryCode: receiver.postalAddress?.countryCode }, typeCode: receiver.typeCode, redacted: true },
    },
  };
};

/** Redacts recipient data 90 days after a parcel closes, and returns recent alerts. */
export async function auditParcels(ctx) {
  await markStaleClaims(ctx);
  const t = now(ctx);
  const old = await db.parcel.findMany({
    where: { shop: ctx.shop, status: { in: ["fulfilled", "rejected"] }, closedAt: { lt: new Date(t.getTime() - RETENTION_MS) }, redactedAt: null },
  });
  for (const p of old) {
    await db.parcel.updateMany({ where: { id: p.id, redactedAt: null }, data: { requestJson: JSON.stringify(redactRequest(JSON.parse(p.requestJson))), redactedAt: t } });
  }
  const alerts = await db.parcelAlert.findMany({ where: { shop: ctx.shop, createdAt: { gte: new Date(t.getTime() - ALERT_WINDOW_MS) } }, orderBy: { createdAt: "desc" }, take: 100 });
  const open = await db.parcel.findMany({ where: { shop: ctx.shop, status: "needs_reconciliation" } });
  const dup = await duplicateOrders(ctx, t);
  return {
    redacted: old.length,
    alerts: alerts.map((a) => ({ id: a.id, parcelId: a.parcelId, type: a.type, detail: a.detail ? JSON.parse(a.detail) : null, createdAt: a.createdAt })),
    needsReconciliation: open.map((p) => ({ parcelId: p.id, orderId: p.orderId, claimedAt: p.claimedAt, error: p.error })),
    duplicateOrders: dup.list,
    ...(dup.truncated ? { truncated: true } : {}),
  };
}

/**
 * Recipients whose items are covered by more than one live DHL shipment, across Parcel rows (label_created or
 * fulfilled) and legacy batch Shipment rows (tracking not owned by a parcel), created in the last DUPLICATE_WINDOW_MS.
 * Rejected parcels are left out (a late label after a reject is already an alert); the same tracking number seen
 * twice counts once. legacy_and_parcel and several_legacy_labels need no Shopify call and cover the full window.
 * Several parcels for one recipient are normal (separate parcels), so parcels alone are only flagged when, for some
 * line, their quantities add up to more than the order line. That needs the Shopify order, so it runs only for
 * recipients with a parcel created in the last DUPLICATE_LINECHECK_RECENT_MS, at most DUPLICATE_LINECHECK_MAX of them
 * (most recent first; `truncated` when more were waiting), DUPLICATE_LINECHECK_CONCURRENCY lookups at a time.
 * reason: legacy_and_parcel | several_legacy_labels | line_over_covered | line_check_failed (Shopify unreachable).
 */
async function duplicateOrders(ctx, t) {
  const since = new Date(t.getTime() - DUPLICATE_WINDOW_MS);
  const recentSince = t.getTime() - DUPLICATE_LINECHECK_RECENT_MS;
  const parcels = await db.parcel.findMany({ where: { shop: ctx.shop, status: { in: ["label_created", "fulfilled"] }, trackingNumber: { not: null }, createdAt: { gte: since } } });
  const shipments = await db.shipment.findMany({ where: { shop: ctx.shop, trackingNumber: { not: null }, createdAt: { gte: since } } });
  const owned = new Set((await db.parcel.findMany({ where: { shop: ctx.shop, trackingNumber: { not: null } } })).map((p) => p.trackingNumber));
  const groups = new Map();
  const group = (orderId, recipientId) => {
    const k = `${orderId} ${recipientId}`;
    if (!groups.has(k)) groups.set(k, { orderId, recipientId, parcels: [], legacy: [], reason: null });
    return groups.get(k);
  };
  for (const p of parcels) group(p.orderId, p.recipientId).parcels.push(p);
  for (const sh of shipments) if (!owned.has(sh.trackingNumber)) group(sh.orderId, sh.recipientId).legacy.push(sh);

  const lineChecks = [];
  for (const g of groups.values()) {
    const legacyTracking = new Set(g.legacy.map((x) => x.trackingNumber));
    const parcelTracking = new Set(g.parcels.map((x) => x.trackingNumber));
    if (legacyTracking.size && [...parcelTracking].some((tn) => !legacyTracking.has(tn))) g.reason = "legacy_and_parcel";
    else if (legacyTracking.size > 1) g.reason = "several_legacy_labels";
    else if (parcelTracking.size > 1) {
      g.newest = Math.max(...g.parcels.map((p) => new Date(p.createdAt).getTime()));
      if (g.newest >= recentSince) lineChecks.push(g);
    }
  }
  lineChecks.sort((a, b) => b.newest - a.newest);
  const truncated = lineChecks.length > DUPLICATE_LINECHECK_MAX;
  const toCheck = lineChecks.slice(0, DUPLICATE_LINECHECK_MAX);

  if (toCheck.length) {
    let admin = null;
    try { admin = await ctx.getAdmin(); } catch { /* every check below reports line_check_failed */ }
    const checkOne = async (g) => {
      const claimed = {};
      for (const p of g.parcels) for (const l of JSON.parse(p.lines)) claimed[l.lineItemId] = (claimed[l.lineItemId] || 0) + l.quantity;
      try {
        if (!admin) throw new Error("Shopify unavailable");
        const order = await getOrder(admin, g.orderId);
        const ordered = Object.fromEntries((order?.lineItems?.nodes || []).map((l) => [l.id, l.quantity]));
        if (Object.entries(claimed).some(([id, q]) => q > (ordered[id] ?? 0))) g.reason = "line_over_covered";
      } catch {
        g.reason = "line_check_failed";
      }
    };
    let next = 0;
    const worker = async () => { while (next < toCheck.length) await checkOne(toCheck[next++]); };
    await Promise.all(Array.from({ length: Math.min(DUPLICATE_LINECHECK_CONCURRENCY, toCheck.length) }, worker));
  }

  const list = [...groups.values()].filter((g) => g.reason).map((g) => ({
    orderId: g.orderId,
    recipientId: g.recipientId,
    trackingNumbers: [...new Set([...g.parcels, ...g.legacy].map((x) => x.trackingNumber))],
    parcelIds: g.parcels.map((p) => p.id),
    legacyShipmentIds: g.legacy.map((x) => x.id),
    reason: g.reason,
  }));
  return { list, truncated };
}

const OPS = { plan: planOrder, rates: parcelRates, create: createParcel, status: parcelStatus, label: parcelLabel, reconcile: reconcileParcel, audit: auditParcels };

/** One signed request from Operations. ctx: {shop, settings, locked, getAdmin, getDhl, now?, sleep?, log?}. */
export async function handleParcelOp(body, ctx) {
  const op = OPS[body?.op];
  if (!op || !Object.hasOwn(OPS, body.op)) throw new ParcelError("bad_request", "op must be one of plan, rates, create, status, label, reconcile, audit");
  if (body.op !== "rates") await markStaleClaims(ctx);
  return op(ctx, body);
}
