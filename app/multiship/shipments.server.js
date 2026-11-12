// Labels for every order (single or multi address) through MyDHL, Shopify fulfillments with tracking,
// one printable PDF per batch, and the day's DHL pickup.
import { PDFDocument } from "pdf-lib";
import db from "../db.server";
import { ITEMS, itemKeyFromSku, DDP_SERVICE_CODE, SHIPPER } from "./src/config.js";
import { buildParcels, itemCount } from "./src/parcels.js";
import { dhlFor, pickupDay, dubaiDateTime } from "./settings.server.js";

const DESCRIPTIONS = {
  CS: "Decorative wall art, laser cut acrylic plastic, with mounting nails",
  GP: "UV printed picture on acrylic, in MDF frame",
};
const LETTERS = "ABCDEFGHIJ";
const PLT_SERVICE_CODE = "WY"; // paperless trade: commercial invoice sent to DHL electronically

// ---------- Orders ----------

const ORDER_FIELDS = `
  id legacyResourceId name createdAt email phone
  displayFulfillmentStatus
  customAttributes { key value }
  currentTotalDutiesSet { shopMoney { amount } }
  shippingAddress { name firstName lastName address1 address2 city provinceCode zip countryCodeV2 phone company }
  lineItems(first: 100) {
    nodes { id sku title quantity requiresShipping originalUnitPriceSet { shopMoney { amount currencyCode } } customAttributes { key value } }
  }`;

/** Paid orders still waiting to ship (last 60 days). */
export async function listOpenOrders(admin) {
  const res = await admin.graphql(
    `#graphql
    query OpenOrders {
      orders(first: 100, sortKey: CREATED_AT, reverse: true,
        query: "financial_status:paid AND (fulfillment_status:unfulfilled OR fulfillment_status:partial) AND -status:cancelled") {
        nodes { ${ORDER_FIELDS} }
      }
    }`,
  );
  const { data } = await res.json();
  return data.orders.nodes;
}

async function getOrder(admin, legacyId) {
  const res = await admin.graphql(
    `#graphql
    query OneOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
    { variables: { id: `gid://shopify/Order/${legacyId}` } },
  );
  return (await res.json()).data.order;
}

/**
 * A shipping plan for any order. Multi address orders use the plan saved at checkout.
 * Single address orders: one recipient, DDP when the customer paid duties at checkout.
 */
export async function planForOrder(shop, order) {
  const msId = order.customAttributes.find((a) => a.key === "_multiship_id")?.value;
  if (msId) {
    const rec = await db.multishipCheckout.findUnique({ where: { id: msId } });
    if (rec && rec.shop === shop) {
      const plan = JSON.parse(rec.payload);
      return { type: "multi", ...plan, quotes: Object.fromEntries(plan.quote.quotes.map((q) => [q.id, q])) };
    }
  }
  const a = order.shippingAddress;
  if (!a) throw new Error("No shipping address");
  const lines = order.lineItems.nodes
    .filter((l) => l.requiresShipping && l.quantity > 0)
    .map((l) => ({ sku: l.sku, title: l.title, quantity: l.quantity, unitPrice: Number(l.originalUnitPriceSet.shopMoney.amount) }));
  const parcels = buildParcels(lines); // throws for City Lights or unknown SKUs
  const domestic = a.countryCodeV2 === SHIPPER.countryCode;
  const duties = Number(order.currentTotalDutiesSet?.shopMoney?.amount || 0);
  const r = {
    id: "r1",
    address: {
      name: a.name || `${a.firstName || ""} ${a.lastName || ""}`.trim(),
      phone: a.phone || order.phone || "",
      address1: a.address1, address2: a.address2 || "", city: a.city,
      provinceCode: a.provinceCode || "", zip: a.zip || "", countryCode: a.countryCodeV2,
    },
    lines,
  };
  return {
    type: "single",
    recipients: [r],
    shopCurrency: order.lineItems.nodes[0]?.originalUnitPriceSet.shopMoney.currencyCode || "USD",
    ddpChoices: { r1: !domestic && duties > 0 },
    quotes: { r1: { id: "r1", itemCount: itemCount(lines), ddp: { available: !domestic }, internal: { productCode: domestic ? "N" : "P", parcels } } },
  };
}

// ---------- DHL shipment ----------

function shipper(settings) {
  const s = settings.sender;
  return {
    postalAddress: {
      postalCode: s.postalCode, cityName: s.city, countryCode: s.countryCode,
      addressLine1: s.addressLine1, ...(s.addressLine2 ? { addressLine2: s.addressLine2 } : {}),
    },
    contactInformation: { companyName: s.companyName, fullName: s.contactName || s.companyName, phone: s.phone, email: s.email },
    typeCode: "business",
  };
}

// DHL only accepts the emirate as the city for UAE addresses ("Dubai", not "Business Bay" or a PO box number).
const EMIRATES = { AZ: "Abu Dhabi", AJ: "Ajman", DU: "Dubai", FU: "Fujairah", RK: "Ras Al Khaimah", SH: "Sharjah", UQ: "Umm Al Quwain" };
export function uaeCity(a) {
  if (EMIRATES[a.provinceCode]) return EMIRATES[a.provinceCode];
  const text = `${a.city || ""} ${a.address2 || ""} ${a.address1 || ""}`.toLowerCase().replace(/[^a-z ]/g, " ");
  const hit = Object.values(EMIRATES).find((e) => text.includes(e.toLowerCase())) || (/\brak\b/.test(text) ? "Ras Al Khaimah" : null);
  if (!hit) throw new Error(`UAE address needs its emirate (Dubai, Abu Dhabi, Sharjah...). The city says "${a.city}". Fix the shipping address in Shopify, then try again.`);
  return hit;
}

export function buildShipmentRequest({ settings, orderName, plan, recipient, letter, day }) {
  const quote = plan.quotes[recipient.id];
  const a = recipient.address;
  const domestic = quote.internal.productCode === "N";
  const ddp = !domestic && Boolean(plan.ddpChoices?.[recipient.id] && quote.ddp?.available);
  const currency = plan.shopCurrency || "USD";
  const declaredValue = Math.round(recipient.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0) * 100) / 100;
  const incoterm = ddp ? "DDP" : "DAP";
  const vas = [...(ddp ? [{ serviceCode: DDP_SERVICE_CODE }] : []), ...(domestic ? [] : [{ serviceCode: PLT_SERVICE_CODE }])];

  return {
    plannedShippingDateAndTime: dubaiDateTime(day, settings.pickup.readyTime),
    pickup: { isRequested: false },
    productCode: quote.internal.productCode,
    accounts: [{ typeCode: "shipper", number: settings.dhl.accountNumber }],
    ...(vas.length ? { valueAddedServices: vas } : {}),
    outputImageProperties: {
      encodingFormat: "pdf",
      imageOptions: [
        { typeCode: "label", templateName: settings.label.template },
        ...(domestic ? [] : [{ typeCode: "invoice", templateName: "COMMERCIAL_INVOICE_P_10", isRequested: true, invoiceType: "commercial" }]),
      ],
    },
    customerReferences: [{ value: `${orderName}-${letter}`, typeCode: "CU" }],
    customerDetails: {
      shipperDetails: shipper(settings),
      receiverDetails: {
        postalAddress: a.countryCode === "AE"
          ? (() => {
              const city = uaeCity(a);
              const extra = [a.address2, a.city && a.city.toLowerCase() !== city.toLowerCase() ? a.city : ""].filter(Boolean).join(", ");
              return { postalCode: "", cityName: city, countryCode: "AE", addressLine1: a.address1, ...(extra ? { addressLine2: extra.slice(0, 45) } : {}) };
            })()
          : {
              postalCode: a.zip || "", cityName: a.city, countryCode: a.countryCode,
              ...(a.provinceCode ? { provinceCode: a.provinceCode } : {}),
              addressLine1: a.address1, ...(a.address2 ? { addressLine2: a.address2 } : {}),
            },
        contactInformation: { fullName: a.name, companyName: a.name, phone: a.phone || settings.sender.phone },
        typeCode: "private",
      },
    },
    content: {
      packages: quote.internal.parcels.map((p, i) => ({
        weight: p.weight,
        dimensions: { length: p.length, width: p.width, height: p.height },
        customerReferences: [{ value: `${orderName}-${letter}-${i + 1}`, typeCode: "CU" }],
      })),
      isCustomsDeclarable: !domestic,
      description: "Wall art",
      incoterm,
      unitOfMeasurement: "metric",
      ...(domestic ? {} : {
        declaredValue,
        declaredValueCurrency: currency,
        exportDeclarations: [{
          lineItems: recipient.lines.map((l, i) => {
            const item = ITEMS[itemKeyFromSku(l.sku)];
            const inbound = item.importCodes?.[a.countryCode];
            return {
              number: i + 1,
              description: DESCRIPTIONS[item.line],
              price: l.unitPrice,
              quantity: { value: l.quantity, unitOfMeasurement: "PCS" },
              commodityCodes: [{ typeCode: "outbound", value: item.hsCode }, ...(inbound ? [{ typeCode: "inbound", value: inbound }] : [])],
              exportReasonType: "permanent",
              manufacturerCountry: "AE",
              weight: { netValue: item.declaredWeightKg, grossValue: item.declaredWeightKg },
            };
          }),
          invoice: { number: `${orderName.replace("#", "")}-${letter}`, date: day },
          exportReason: "Sale",
          shipmentType: "personal",
          incoterm,
        }],
      }),
    },
  };
}

// ---------- Shopify fulfillment ----------

async function fulfil(admin, orderGid, recipientId, single, trackingNumber, trackingUrl) {
  const res = await admin.graphql(
    `#graphql
    query FOs($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 20) {
          nodes { id status lineItems(first: 100) { nodes { id remainingQuantity lineItem { requiresShipping customAttributes { key value } } } } }
        }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const fos = (await res.json()).data.order.fulfillmentOrders.nodes.filter((f) => ["OPEN", "IN_PROGRESS"].includes(f.status));
  const mine = (li) => li.remainingQuantity > 0 && li.lineItem.requiresShipping &&
    (single || li.lineItem.customAttributes.some((c) => c.key === "_recipient" && c.value === recipientId));
  const byFo = fos.map((fo) => ({
    fulfillmentOrderId: fo.id,
    fulfillmentOrderLineItems: fo.lineItems.nodes.filter(mine).map((li) => ({ id: li.id, quantity: li.remainingQuantity })),
  })).filter((x) => x.fulfillmentOrderLineItems.length);
  if (!byFo.length) return { ok: true };

  const r = await admin.graphql(
    `#graphql
    mutation Fulfil($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { message } } }`,
    { variables: { f: { lineItemsByFulfillmentOrder: byFo, notifyCustomer: true, trackingInfo: { company: "DHL Express", number: trackingNumber, url: trackingUrl } } } },
  );
  const errs = (await r.json()).data?.fulfillmentCreate?.userErrors || [];
  return errs.length ? { ok: false, error: errs.map((e) => e.message).join("; ") } : { ok: true };
}

// Lines with nothing to ship (duties prepaid lines) are closed once everything else has shipped.
async function closeNonShippingLines(admin, orderGid) {
  const res = await admin.graphql(
    `#graphql
    query FOs2($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status lineItems(first: 100) { nodes { id remainingQuantity lineItem { requiresShipping } } } } } } }`,
    { variables: { id: orderGid } },
  );
  const fos = (await res.json()).data.order.fulfillmentOrders.nodes.filter((f) => ["OPEN", "IN_PROGRESS"].includes(f.status));
  const all = fos.flatMap((fo) => fo.lineItems.nodes.map((li) => ({ fo: fo.id, li })));
  if (all.some((x) => x.li.remainingQuantity > 0 && x.li.lineItem.requiresShipping)) return;
  const byFo = fos.map((fo) => ({
    fulfillmentOrderId: fo.id,
    fulfillmentOrderLineItems: fo.lineItems.nodes.filter((li) => li.remainingQuantity > 0).map((li) => ({ id: li.id, quantity: li.remainingQuantity })),
  })).filter((x) => x.fulfillmentOrderLineItems.length);
  if (byFo.length) {
    await admin.graphql(
      `#graphql
      mutation Close($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { userErrors { message } } }`,
      { variables: { f: { lineItemsByFulfillmentOrder: byFo, notifyCustomer: false } } },
    );
  }
}

// ---------- Pickup ----------

async function ensurePickup(shop, settings, day, plans) {
  const existing = await db.pickupBooking.findUnique({ where: { shop_date: { shop, date: day } } });
  if (existing?.confirmation) return existing;
  const p = plans[0];
  const q = Object.values(p.quotes)[0];
  const body = {
    plannedPickupDateAndTime: dubaiDateTime(day, settings.pickup.readyTime),
    closeTime: settings.pickup.closeTime,
    location: settings.pickup.location || "reception",
    locationType: "business",
    accounts: [{ typeCode: "shipper", number: settings.dhl.accountNumber }],
    ...(settings.pickup.instructions ? { specialInstructions: [{ value: settings.pickup.instructions, typeCode: "TBD" }] } : {}),
    customerDetails: { shipperDetails: shipper(settings) },
    shipmentDetails: [{
      productCode: q.internal.productCode,
      isCustomsDeclarable: q.internal.productCode !== "N",
      declaredValue: Math.round(p.recipients[0].lines.reduce((t, l) => t + l.unitPrice * l.quantity, 0) * 100) / 100 || 1,
      declaredValueCurrency: p.shopCurrency || "USD",
      unitOfMeasurement: "metric",
      accounts: [{ typeCode: "shipper", number: settings.dhl.accountNumber }],
      packages: q.internal.parcels.map((x) => ({ weight: x.weight, dimensions: { length: x.length, width: x.width, height: x.height } })),
    }],
  };
  try {
    const res = await dhlFor(settings).createPickup(body);
    const confirmation = (res.dispatchConfirmationNumbers || []).join(", ");
    return db.pickupBooking.upsert({
      where: { shop_date: { shop, date: day } },
      create: { shop, date: day, confirmation },
      update: { confirmation, error: null },
    });
  } catch (e) {
    return db.pickupBooking.upsert({
      where: { shop_date: { shop, date: day } },
      create: { shop, date: day, error: e.message },
      update: { error: e.message },
    });
  }
}

// ---------- Batch ----------

/**
 * Create labels for the selected orders, fulfil them in Shopify, merge all labels into one PDF,
 * and make sure today's (or the next working day's) pickup is booked.
 */
export async function createLabelBatch({ admin, shop, settings, orderIds }) {
  const day = pickupDay();
  const dhl = dhlFor(settings);
  const merged = await PDFDocument.create();
  const summary = [];
  const plansUsed = [];

  for (const legacyId of orderIds) {
    const order = await getOrder(admin, legacyId);
    if (!order) { summary.push({ orderId: legacyId, error: "Order not found" }); continue; }
    let plan;
    try { plan = await planForOrder(shop, order); } catch (e) { summary.push({ order: order.name, error: e.message }); continue; }
    plansUsed.push(plan);

    for (const [i, r] of plan.recipients.entries()) {
      const letter = plan.type === "multi" ? LETTERS[i] : "";
      const done = await db.shipment.findFirst({ where: { shop, orderId: String(legacyId), recipientId: r.id, trackingNumber: { not: null } } });
      if (done) { summary.push({ order: order.name, letter, tracking: done.trackingNumber, already: true }); continue; }

      const ref = letter ? `${order.name}-${letter}` : order.name;
      try {
        const res = await dhl.createShipment(buildShipmentRequest({ settings, orderName: order.name, plan, recipient: r, letter: letter || "A", day }));
        const label = (res.documents || []).find((d) => d.typeCode === "label")?.content;
        const tn = res.shipmentTrackingNumber;
        const url = `${settings.tracking.baseUrl.replace(/\/$/, "")}/apps/multiship/track?t=${tn}`;
        const f = await fulfil(admin, order.id, r.id, plan.type === "single", tn, url);
        await db.shipment.create({ data: {
          shop, orderId: String(legacyId), orderName: order.name, recipientId: r.id, letter: letter || "-",
          name: r.address.name, country: r.address.countryCode, trackingNumber: tn, label,
          fulfilled: f.ok, error: f.ok ? null : `Shopify: ${f.error}`,
        } });
        if (label) {
          const src = await PDFDocument.load(Buffer.from(label, "base64"));
          (await merged.copyPages(src, src.getPageIndices())).forEach((pg) => merged.addPage(pg));
        }
        summary.push({ order: order.name, letter, name: r.address.name, tracking: tn, fulfilError: f.ok ? undefined : f.error });
      } catch (e) {
        summary.push({ order: ref, name: r.address.name, error: e.message });
      }
    }
    await closeNonShippingLines(admin, order.id);
  }

  const labelled = summary.filter((x) => x.tracking && !x.already).length;
  const pickup = labelled && plansUsed.length ? await ensurePickup(shop, settings, day, plansUsed) : null;
  const pdf = merged.getPageCount() ? Buffer.from(await merged.save()).toString("base64") : null;
  const batch = await db.labelBatch.create({ data: {
    shop, pdf, summary: JSON.stringify(summary),
    pickup: pickup ? JSON.stringify({ date: day, confirmation: pickup.confirmation, error: pickup.error }) : null,
  } });
  return { batchId: batch.id, summary, pickup, day, pages: merged.getPageCount() };
}
