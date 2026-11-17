// In-memory stand-ins for Prisma, the Shopify Admin GraphQL client and the MyDHL client.
// Nothing here talks to a network: global fetch is replaced so a stray real call fails loudly.
import { PDFDocument } from 'pdf-lib';

globalThis.fetch = async () => { throw new Error('network disabled in tests'); };

// ---------- Prisma subset ----------

function matches(row, where = {}) {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (cond && typeof cond === 'object') {
      if ('in' in cond && !cond.in.includes(v)) return false;
      if ('not' in cond && (cond.not === null ? v === null || v === undefined : v === cond.not)) return false;
      if ('lt' in cond && !(v instanceof Date && v < cond.lt)) return false;
      if ('gte' in cond && !(v instanceof Date && v >= cond.gte)) return false;
      return true;
    }
    return v === cond;
  });
}

function model(defaults = {}, { clock, idPrefix = 'id' } = {}) {
  const rows = new Map();
  const rowids = new Map(); // SQLite implicit rowid: assigned at insert, in insert order
  let seq = 0;
  let rowid = 0;
  const copy = (r) => (r ? structuredClone(r) : null);
  const t = () => (clock ? clock.now() : new Date());
  return {
    rows,
    rowids,
    beforeInsert: null, // async hook (data) => {} run before the row becomes visible
    afterInsert: null, // async hook (row) => {} run after the row is visible, before create returns
    async findUnique({ where }) { return copy(rows.get(where.id)); },
    async findFirst({ where } = {}) { return copy([...rows.values()].find((r) => matches(r, where))); },
    async findMany({ where, orderBy, take } = {}) {
      let out = [...rows.values()].filter((r) => matches(r, where));
      if (orderBy) {
        const [[k, dir]] = Object.entries(orderBy);
        out.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      return out.slice(0, take ?? out.length).map(copy);
    },
    async create({ data }) {
      if (this.beforeInsert) await this.beforeInsert(data);
      const id = data.id ?? `${idPrefix}${++seq}`;
      if (rows.has(id)) throw Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' });
      const row = { ...defaults, ...structuredClone(data), id, createdAt: t(), updatedAt: t() };
      rows.set(id, row);
      rowids.set(id, ++rowid);
      if (this.afterInsert) await this.afterInsert(copy(row));
      return copy(row);
    },
    async update({ where, data }) {
      const row = rows.get(where.id);
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      Object.assign(row, structuredClone(data), { updatedAt: t() });
      return copy(row);
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const row of rows.values()) {
        if (!matches(row, where)) continue;
        Object.assign(row, structuredClone(data), { updatedAt: t() });
        count++;
      }
      return { count };
    },
  };
}

export function fakeDb(clock) {
  const db = {
    // Only the one raw query the parcel service runs: the insert order (rowid) of an order's parcels.
    async $queryRaw(strings, ...values) {
      const sql = strings.join('?');
      if (!/SELECT "id", rowid AS "seq" FROM "Parcel" WHERE "shop" = \? AND "orderId" = \?/.test(sql)) throw new Error(`fake db: unexpected SQL ${sql}`);
      const [shop, orderId] = values;
      return [...db.parcel.rows.values()].filter((r) => r.shop === shop && r.orderId === orderId).map((r) => ({ id: r.id, seq: BigInt(db.parcel.rowids.get(r.id)) }));
    },
    parcel: model({
      status: 'pending', trackingNumber: null, pieceTrackingNumbers: null, label: null, labelDocuments: null, invoice: null, error: null,
      customsPaperRequired: false, lateTrackingNumber: null, lateLabel: null, lateAt: null, reconciledBy: null,
      reconciledAt: null, closedAt: null, shopifyFulfillmentId: null, redactedAt: null, orderName: null, quotedPrice: null,
    }, { clock }),
    parcelAlert: model({ detail: null }, { clock, idPrefix: 'alert' }),
    shipment: model({ label: null, error: null, fulfilled: false, batchId: null }, { clock, idPrefix: 'shp' }),
    labelBatch: model({ pdf: null, pickup: null }, { clock, idPrefix: 'batch' }),
    multishipCheckout: model({}, { clock }),
    shopSetting: { row: null, async findUnique() { return this.row; } },
    pickupBooking: model({}, { clock }),
  };
  return db;
}

export function fakeClock(start = '2026-11-17T08:00:00Z') {
  let ms = new Date(start).getTime();
  return { now: () => new Date(ms), advance: (s) => { ms += s * 1000; } };
}

// ---------- Shopify Admin GraphQL ----------

/**
 * order: { id: numeric string, name, lines: [{ id, sku, quantity, unitPrice, recipient?, barcode? }], address, type }
 * Fault injection: shop.failNext[opName] = Error to throw once (before or after the effect, see failAfter).
 */
export function fakeShopify({ orderId = '1001', name = '#1001', address, lines, multi = false, currency = 'USD' }) {
  const shop = {
    calls: [],
    fulfillments: [],
    failNext: {},
    failAfter: {},
    down: false, // every call throws
    beforeFulfil: null, // called with the fulfilment input before it is applied
    userErrorsNext: null,
    remaining: Object.fromEntries(lines.map((l) => [l.id, l.quantity])),
  };
  const lineGid = (id) => `gid://shopify/LineItem/${id}`;
  const order = {
    id: `gid://shopify/Order/${orderId}`, legacyResourceId: orderId, name, createdAt: '2026-11-15T10:00:00Z', email: 'buyer@example.com', phone: '',
    displayFulfillmentStatus: 'UNFULFILLED',
    customAttributes: multi ? [{ key: '_multiship_id', value: 'ms1' }] : [],
    currentTotalDutiesSet: { shopMoney: { amount: '0' } },
    shippingAddress: address && {
      name: address.name, firstName: '', lastName: '', address1: address.address1, address2: address.address2 || '', city: address.city,
      provinceCode: address.provinceCode || '', zip: address.zip || '', countryCodeV2: address.countryCode, phone: address.phone || '', company: '',
    },
    lineItems: { nodes: lines.map((l) => ({
      id: lineGid(l.id), sku: l.sku, title: l.title || l.sku, quantity: l.quantity, requiresShipping: true,
      variant: { barcode: l.barcode || '' }, originalUnitPriceSet: { shopMoney: { amount: String(l.unitPrice), currencyCode: currency } },
      customAttributes: l.recipient ? [{ key: '_recipient', value: l.recipient }] : [],
    })) },
  };
  const respond = (data) => ({ json: async () => ({ data }) });
  shop.order = order;
  shop.admin = {
    async graphql(query, { variables } = {}) {
      const op = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
      shop.calls.push(op);
      const fail = (when) => {
        const map = when === 'before' ? shop.failNext : shop.failAfter;
        if (map[op]) { const e = map[op]; delete map[op]; throw e; }
      };
      if (shop.down) throw new Error('Shopify unreachable');
      fail('before');
      if (op === 'OneOrder') return respond({ order: variables.id === order.id ? order : null });
      if (op === 'ParcelFOs') {
        if (shop.foBarrier) await shop.foBarrier();
        return respond({ order: {
          fulfillments: shop.fulfillments.map((f) => ({ id: f.id, trackingInfo: f.trackingInfo.number ? [{ number: f.trackingInfo.number }] : [] })),
          fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/1', status: 'OPEN', lineItems: { nodes: lines.map((l) => ({
            id: `gid://shopify/FulfillmentOrderLineItem/${l.id}`, remainingQuantity: shop.remaining[l.id],
            lineItem: { id: lineGid(l.id), requiresShipping: true, customAttributes: l.recipient ? [{ key: '_recipient', value: l.recipient }] : [] },
          })) } }] },
        } });
      }
      if (op === 'ParcelFulfil') {
        if (shop.userErrorsNext) { const m = shop.userErrorsNext; shop.userErrorsNext = null; return respond({ fulfillmentCreate: { fulfillment: null, userErrors: [{ message: m }] } }); }
        const f = variables.f;
        if (shop.beforeFulfil) await shop.beforeFulfil(f);
        for (const g of f.lineItemsByFulfillmentOrder) {
          for (const li of g.fulfillmentOrderLineItems) {
            const id = li.id.split('/').pop();
            if (li.quantity > shop.remaining[id]) return respond({ fulfillmentCreate: { fulfillment: null, userErrors: [{ message: 'quantity above remaining' }] } });
            shop.remaining[id] -= li.quantity;
          }
        }
        const fid = `gid://shopify/Fulfillment/${shop.fulfillments.length + 1}`;
        shop.fulfillments.push({ id: fid, ...structuredClone(f) });
        fail('after'); // the fulfilment happened in Shopify but the answer was lost
        return respond({ fulfillmentCreate: { fulfillment: { id: fid }, userErrors: [] } });
      }
      throw new Error(`fake Shopify: unexpected operation ${op}`);
    },
  };
  return shop;
}

// ---------- MyDHL ----------

export async function pdfWithTitle(title, pages = 1) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  for (let i = 0; i < pages; i++) doc.addPage([288, 432]);
  return Buffer.from(await doc.save()).toString('base64');
}

export async function fakeDhl({ alwaysInvoice = false } = {}) {
  const label = await pdfWithTitle('DHL LABEL');
  const invoice = await pdfWithTitle('COMMERCIAL INVOICE');
  const dhl = {
    calls: [],
    label,
    invoice,
    failNext: null, // Error thrown on the next createShipment (after the call is counted)
    hold: null, // a promise the next createShipment waits for (late completion)
    onCall: null, // runs when DHL receives a shipment (inject faults that start after the claim)
    callOptions: [],
    labels: null, // override the label documents' contents
    async createShipment(body, options) {
      dhl.calls.push(structuredClone(body));
      dhl.callOptions.push(options);
      const n = dhl.calls.length;
      if (dhl.onCall) dhl.onCall(body);
      if (dhl.failNext) { const e = dhl.failNext; dhl.failNext = null; throw e; }
      if (dhl.hold) { const h = dhl.hold; dhl.hold = null; await h; }
      const wantsInvoice = body.outputImageProperties.imageOptions.some((o) => o.typeCode === 'invoice');
      return {
        shipmentTrackingNumber: `90000000${n}`,
        packages: body.content.packages.map((_, i) => ({ referenceNumber: i + 1, trackingNumber: `JD0146000${n}${i + 1}` })),
        documents: [...(dhl.labels || [label]).map((content) => ({ typeCode: 'label', imageFormat: 'PDF', content })), ...(wantsInvoice || alwaysInvoice ? [{ typeCode: 'invoice', imageFormat: 'PDF', content: invoice }] : [])],
      };
    },
    rateCalls: [],
    async rates(args) {
      dhl.rateCalls.push(args);
      return [
        { productCode: 'P', name: 'EXPRESS WORLDWIDE', price: 210.5, currency: 'AED', estimatedDelivery: '2026-11-20T23:59:00' },
        { productCode: 'U', name: 'EXPRESS WORLDWIDE EU', price: 190, currency: 'AED', estimatedDelivery: '2026-11-21T23:59:00' },
        { productCode: 'Y', name: 'EXPRESS 12:00', price: 320, currency: 'AED', estimatedDelivery: '2026-11-20T12:00:00' },
      ];
    },
  };
  return dhl;
}
