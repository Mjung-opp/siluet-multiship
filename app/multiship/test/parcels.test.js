// Operations parcel service (plan T6′ / T6b). Fakes only: no DHL, Shopify or database is touched.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { useTestDb } from './helpers/server-modules.js';
import { fakeDb, fakeClock, fakeShopify, fakeDhl } from './helpers/fakes.js';
import { SETTINGS } from './fixtures/shipment-cases.js';
import { buildParcels } from '../src/parcels.js';
import fs from 'node:fs';

const svc = await import('../parcel-shipping.server.js');
const { createDhlClient, SHIPMENT_TIMEOUT_MS } = await import('../src/dhl.js');
const { signParcelRequest, verifyParcelRequest } = await import('../parcel-auth.js');
const { isLocked } = await import('../lock.js');
const { createLabelBatch } = await import('../shipments.server.js');

const SHOP = 'test-shop.myshopify.com';
const ADDR = {
  DE: { name: 'Test Recipient', phone: '+10000000000', address1: 'Teststrasse 1', city: 'Berlin', zip: '10115', countryCode: 'DE' },
  TR: { name: 'Test Recipient', phone: '+10000000000', address1: 'Test Sokak 1', city: 'Istanbul', zip: '34000', countryCode: 'TR' },
  AE: { name: 'Test Recipient', phone: '+971000000001', address1: 'Test Tower 1', city: 'Business Bay', provinceCode: 'DU', countryCode: 'AE' },
  AE_NO_EMIRATE: { name: 'Test Recipient', phone: '+971000000001', address1: 'Test Tower 1', city: 'Somewhere', countryCode: 'AE' },
};
const LINES = [
  { id: '11', sku: 'SMB-BERLIN', quantity: 1, unitPrice: 135, barcode: '0000000000017' },
  { id: '12', sku: 'MGD-PARIS', quantity: 2, unitPrice: 165 },
];
const TWO_PIECES = [{ weight: 1.2, length: 93, width: 15.5, height: 4 }, { weight: 2.1, length: 93, width: 15.5, height: 6 }];
const ADMIN = { role: 'admin', email: 'admin@example.com' };

async function setup({ country = 'DE', lines = LINES, alwaysInvoice = false, locked = false, multi = false } = {}) {
  const clock = fakeClock();
  const db = useTestDb(fakeDb(clock));
  const shopify = fakeShopify({ address: ADDR[country], lines, multi });
  const dhl = await fakeDhl({ alwaysInvoice });
  const logs = [];
  const ctx = {
    shop: SHOP, settings: structuredClone(SETTINGS), locked,
    getAdmin: async () => shopify.admin, getDhl: () => dhl,
    now: clock.now, sleep: async () => {}, log: { error: (m) => logs.push(m) },
  };
  const op = (body) => svc.handleParcelOp({ shop: SHOP, ...body }, ctx);
  return { clock, db, shopify, dhl, ctx, op, logs };
}

const createBody = (over = {}) => ({
  op: 'create', orderId: '1001', recipientId: 'r1', parcelId: 'PCL-1', productCode: 'P',
  quotedPrice: { amount: 210.5, currency: 'AED' }, pieces: TWO_PIECES,
  lines: [{ lineItemId: '11', quantity: 1 }, { lineItemId: '12', quantity: 2 }], ...over,
});

const rejects = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code); return true; });
const row = (db, id = 'PCL-1') => db.parcel.rows.get(id);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const pdfTitle = async (b64) => (await PDFDocument.load(Buffer.from(b64, 'base64'))).getTitle();

// ---------- Create, replay, fulfilment ----------

test('multiPieceCreateSendsNPackagesOneTracking', async () => {
  const { op, dhl, shopify } = await setup();
  const res = await op(createBody());
  assert.equal(dhl.calls.length, 1);
  assert.equal(dhl.calls[0].content.packages.length, 2);
  assert.equal(res.status, 'fulfilled');
  assert.equal(res.trackingNumber, '900000001');
  assert.equal(res.pieceTrackingNumbers.length, 2);
  assert.equal(shopify.fulfillments.length, 1);
  assert.equal(shopify.fulfillments[0].trackingInfo.number, '900000001');
  assert.equal(shopify.fulfillments[0].trackingInfo.company, 'DHL Express');
});

test('customerReferenceIsParcelId', async () => {
  const { op, dhl } = await setup();
  await op(createBody());
  const r = dhl.calls[0];
  assert.deepEqual(r.customerReferences, [{ value: 'PCL-1', typeCode: 'CU' }]);
  assert.deepEqual(r.content.packages.map((p) => p.customerReferences[0].value), ['PCL-1-1', 'PCL-1-2']);
});

test('createReplaySameHashNoSecondDhlCall', async () => {
  const { op, dhl, shopify } = await setup();
  const first = await op(createBody());
  const again = await op(createBody({ lines: [{ lineItemId: 'gid://shopify/LineItem/12', quantity: 2 }, { lineItemId: '11', quantity: 1 }] }));
  assert.equal(dhl.calls.length, 1);
  assert.deepEqual(again, first);
  assert.equal(shopify.fulfillments.length, 1);
});

test('replayUsesStoredRequestJson', async () => {
  const { op, dhl, db, shopify, ctx } = await setup();
  dhl.onCall = () => { shopify.down = true; }; // label created, fulfilment pending
  const first = await op(createBody());
  assert.equal(first.status, 'label_created');
  const stored = row(db).requestJson;
  assert.equal(stored, JSON.stringify(dhl.calls[0]));
  // Settings and the order change afterwards: the replay must not rebuild or re-read anything.
  ctx.settings.sender.phone = '+971999999999';
  shopify.order.shippingAddress.address1 = 'Changed Street 9';
  shopify.down = false;
  shopify.calls.length = 0;
  const res = await op(createBody());
  assert.equal(res.status, 'fulfilled');
  assert.equal(row(db).requestJson, stored);
  assert.ok(!shopify.calls.includes('OneOrder'), 'replay did not reload the order');
  assert.equal(dhl.calls.length, 1);
});

test('different request under the same parcelId is rejected and changes nothing', async () => {
  const { op, dhl, db } = await setup();
  await op(createBody({ lines: [{ lineItemId: '11', quantity: 1 }] }));
  const before = structuredClone(row(db));
  await assert.rejects(op(createBody({ lines: [{ lineItemId: '12', quantity: 1 }] })), (e) => {
    assert.equal(e.code, 'parcel_id_conflict');
    assert.equal(e.status, 409);
    assert.equal(e.extra.status, 'rejected');
    return true;
  });
  assert.deepEqual(row(db), before);
  assert.equal(dhl.calls.length, 1);
});

test('testParcelFulfilment: separate parcels fulfil exactly their own lines, notifyCustomer true, no pickup', async () => {
  const { op, shopify, dhl, db } = await setup();
  await op(createBody({ parcelId: 'PCL-A', pieces: [TWO_PIECES[0]], lines: [{ lineItemId: '11', quantity: 1 }, { lineItemId: '12', quantity: 1 }] }));
  await op(createBody({ parcelId: 'PCL-B', pieces: [TWO_PIECES[1]], lines: [{ lineItemId: '12', quantity: 1 }] }));
  assert.equal(dhl.calls.length, 2);
  assert.equal(shopify.fulfillments.length, 2);
  assert.deepEqual(shopify.fulfillments[0].lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems,
    [{ id: 'gid://shopify/FulfillmentOrderLineItem/11', quantity: 1 }, { id: 'gid://shopify/FulfillmentOrderLineItem/12', quantity: 1 }]);
  assert.deepEqual(shopify.fulfillments[1].lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems,
    [{ id: 'gid://shopify/FulfillmentOrderLineItem/12', quantity: 1 }]);
  assert.ok(shopify.fulfillments.every((f) => f.notifyCustomer === true));
  assert.notEqual(shopify.fulfillments[0].trackingInfo.number, shopify.fulfillments[1].trackingInfo.number);
  assert.ok(dhl.calls.every((c) => c.pickup.isRequested === false));
  assert.equal(db.pickupBooking.rows.size, 0);
  // The tracking page link in Shopify's email resolves through a Shipment row.
  assert.equal(db.shipment.rows.size, 2);
});

test('crashAfterDhlBeforeFulfilmentKeepsLabel (label and tracking saved before fulfillmentCreate)', async () => {
  const { op, db, shopify, dhl } = await setup();
  let seenAtFulfil;
  shopify.beforeFulfil = () => { seenAtFulfil = structuredClone(row(db)); };
  dhl.onCall = () => { shopify.down = true; };
  const res = await op(createBody());
  assert.equal(res.status, 'label_created');
  assert.match(res.error, /^Shopify: /);
  assert.equal(row(db).label, dhl.label);
  assert.equal(row(db).trackingNumber, '900000001');
  shopify.down = false;
  const again = await op(createBody());
  assert.equal(again.status, 'fulfilled');
  assert.equal(seenAtFulfil.status, 'label_created');
  assert.equal(seenAtFulfil.label, dhl.label);
  assert.equal(dhl.calls.length, 1);
});

test('fulfilmentReplayNoDuplicate: Shopify fulfilled but the answer was lost', async () => {
  const { op, shopify, dhl } = await setup();
  shopify.failAfter.ParcelFulfil = new Error('connection reset');
  const res = await op(createBody());
  assert.equal(res.status, 'fulfilled');
  await op(createBody());
  assert.equal(shopify.fulfillments.length, 1);
  assert.equal(dhl.calls.length, 1);
});

test('testShopifyRetry: a throttled Shopify call is retried, one fulfilment', async () => {
  const { op, shopify, dhl } = await setup();
  dhl.onCall = () => { shopify.failNext.ParcelFOs = Object.assign(new Error('Throttled'), { code: 'THROTTLED' }); };
  const res = await op(createBody());
  assert.equal(res.status, 'fulfilled');
  assert.equal(shopify.fulfillments.length, 1);
});

test('Shopify userErrors keep label_created with the error; a replay fulfils', async () => {
  const { op, shopify, dhl } = await setup();
  shopify.userErrorsNext = 'Fulfillment order is on hold';
  const res = await op(createBody());
  assert.equal(res.status, 'label_created');
  assert.equal(res.error, 'Shopify: Fulfillment order is on hold');
  assert.equal((await op(createBody())).status, 'fulfilled');
  assert.equal(dhl.calls.length, 1);
});

// ---------- Lines ----------

test('lines: quantity above remaining is refused', async () => {
  const { op, dhl } = await setup();
  await rejects(op(createBody({ lines: [{ lineItemId: '12', quantity: 3 }] })), 'quantity_above_remaining');
  assert.equal(dhl.calls.length, 0);
});

test('lines: quantity held by another active parcel counts against remaining', async () => {
  const { op, shopify, dhl } = await setup();
  dhl.onCall = () => { shopify.down = true; };
  assert.equal((await op(createBody({ parcelId: 'PCL-A', lines: [{ lineItemId: '12', quantity: 2 }] }))).status, 'label_created');
  shopify.down = false;
  dhl.onCall = null;
  await rejects(op(createBody({ parcelId: 'PCL-B', lines: [{ lineItemId: '12', quantity: 1 }] })), 'quantity_conflict');
});

test('lines: a line of another recipient is refused (multi address order)', async () => {
  const lines = [
    { id: '21', sku: 'SMB-BERLIN', quantity: 1, unitPrice: 135, recipient: 'r1' },
    { id: '22', sku: 'MGD-PARIS', quantity: 1, unitPrice: 165, recipient: 'r2' },
  ];
  const { op, db, dhl } = await setup({ lines, multi: true });
  const rec = (id, address, ls) => ({ id, address: { ...address, address2: '', provinceCode: '' }, lines: ls });
  const r1 = rec('r1', ADDR.DE, [{ sku: 'SMB-BERLIN', quantity: 1, unitPrice: 135 }]);
  const r2 = rec('r2', { ...ADDR.DE, city: 'Hamburg', zip: '20095' }, [{ sku: 'MGD-PARIS', quantity: 1, unitPrice: 165 }]);
  await db.multishipCheckout.create({ data: { id: 'ms1', shop: SHOP, payload: JSON.stringify({
    recipients: [r1, r2], shopCurrency: 'USD', ddpChoices: {},
    quote: { freeRecipientId: 'r1', quotes: [r1, r2].map((r) => ({ id: r.id, ddp: { available: true }, internal: { productCode: 'P', parcels: buildParcels(r.lines) } })) },
  }) } });
  await rejects(op(createBody({ recipientId: 'r1', lines: [{ lineItemId: '22', quantity: 1 }] })), 'line_other_recipient');
  const ok = await op(createBody({ recipientId: 'r2', pieces: [TWO_PIECES[0]], lines: [{ lineItemId: '22', quantity: 1 }] }));
  assert.equal(ok.status, 'fulfilled');
  assert.equal(dhl.calls[0].customerDetails.receiverDetails.postalAddress.cityName, 'Hamburg');
  assert.equal(dhl.calls[0].content.exportDeclarations[0].invoice.number, 'PCL-1'); // parcel path: invoice number = parcelId
});

test('plan: recipients with line IDs, remaining quantities, DDP flag and lock', async () => {
  const { op, shopify } = await setup({ locked: true });
  shopify.down = false;
  const plan = await op({ op: 'plan', orderId: '1001' });
  assert.equal(plan.locked, true);
  assert.equal(plan.ddp, false);
  assert.deepEqual(plan.recipients.map((r) => [r.recipientId, r.productCode, r.countryCode]), [['r1', 'P', 'DE']]);
  assert.deepEqual(plan.recipients[0].lines.map((l) => [l.lineItemId, l.remainingQuantity]),
    [['gid://shopify/LineItem/11', 1], ['gid://shopify/LineItem/12', 2]]);
});

// ---------- Timeouts, stale claims, reconciliation ----------

test('dhlCreateTimesOutAt60s (parcel path only; legacy createShipment keeps no timeout)', async () => {
  assert.equal(SHIPMENT_TIMEOUT_MS, 60_000);
  const timeouts = [];
  const real = AbortSignal.timeout.bind(AbortSignal);
  const spy = mock.method(AbortSignal, 'timeout', (ms) => { timeouts.push(ms); return real(ms); });
  try {
    const seen = [];
    const client = createDhlClient({ apiKey: 'k', apiSecret: 's', accountNumber: '1', fetchImpl: async (url, init) => {
      seen.push(init.signal);
      return { ok: true, json: async () => ({ shipmentTrackingNumber: '1' }) };
    } });
    await client.createShipment({}); // legacy batch call: unchanged, no signal
    assert.equal(seen[0], undefined);
    assert.deepEqual(timeouts, []);
    await client.createShipment({}, { timeoutMs: SHIPMENT_TIMEOUT_MS });
    assert.deepEqual(timeouts, [60_000]);
    assert.ok(seen[1] instanceof AbortSignal);
  } finally {
    spy.mock.restore();
  }
  // A hung DHL call is aborted (shortened timeout so the test is fast).
  const hung = createDhlClient({ apiKey: 'k', apiSecret: 's', accountNumber: '1', fetchImpl: (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }) });
  await assert.rejects(hung.createShipment({}, { timeoutMs: 20 }), (e) => e.name === 'TimeoutError');

  // The parcel service passes 60 s.
  const svcRun = await setup();
  await svcRun.op(createBody());
  assert.deepEqual(svcRun.dhl.callOptions, [{ timeoutMs: 60_000 }]);

  // The service treats a timeout as an unknown outcome: needs_reconciliation, never resent.
  const { op, dhl, shopify } = await setup();
  dhl.failNext = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const res = await op(createBody());
  assert.equal(res.status, 'needs_reconciliation');
  assert.equal((await op(createBody())).status, 'needs_reconciliation');
  assert.equal(dhl.calls.length, 1);
  assert.equal(shopify.fulfillments.length, 0);
});

test('DHL 4xx: DHL refused, nothing booked, parcel rejected with the DHL message', async () => {
  const { op, dhl } = await setup();
  dhl.failNext = Object.assign(new Error('DHL /shipments 422: Invalid postal code'), { status: 422 });
  const res = await op(createBody());
  assert.equal(res.status, 'rejected');
  assert.match(res.error, /422/);
  assert.equal((await op(createBody())).status, 'rejected');
  assert.equal(dhl.calls.length, 1);
});

test('pendingTimeoutBecomesNeedsReconciliation and lateCompletionAfterNeedsReconciliationSavesLabel', async () => {
  const { op, dhl, clock, db, shopify } = await setup();
  const gate = deferred();
  dhl.hold = gate.promise;
  const inflight = op(createBody());
  await new Promise((r) => setImmediate(r));
  assert.equal((await op({ op: 'status', parcelId: 'PCL-1' })).status, 'pending');
  clock.advance(119);
  assert.equal((await op({ op: 'status', parcelId: 'PCL-1' })).status, 'pending');
  clock.advance(2);
  assert.equal((await op({ op: 'status', parcelId: 'PCL-1' })).status, 'needs_reconciliation');
  assert.equal((await op(createBody())).status, 'needs_reconciliation'); // replay never resends
  assert.equal(dhl.calls.length, 1);
  gate.resolve();
  const late = await inflight;
  assert.equal(late.status, 'fulfilled');
  assert.equal(row(db).label, dhl.label);
  assert.equal(shopify.fulfillments.length, 1);
});

async function needsReconciliation() {
  const s = await setup();
  s.dhl.failNext = new Error('fetch failed');
  assert.equal((await s.op(createBody())).status, 'needs_reconciliation');
  return s;
}

test('reconcileAdminOnly', async () => {
  const { op } = await needsReconciliation();
  const body = { op: 'reconcile', parcelId: 'PCL-1', decision: 'dhl_shipment_found', trackingNumber: '1234567890' };
  await rejects(op(body), 'forbidden');
  await rejects(op({ ...body, actor: { role: 'staff', email: 'packer@example.com' } }), 'forbidden');
  assert.equal((await op({ ...body, actor: ADMIN })).status, 'fulfilled');
});

test('reconcile dhl_shipment_found stores the tracking number and fulfils with it', async () => {
  const { op, shopify, db } = await needsReconciliation();
  const res = await op({ op: 'reconcile', parcelId: 'PCL-1', decision: 'dhl_shipment_found', trackingNumber: '1234567890', actor: ADMIN });
  assert.equal(res.trackingNumber, '1234567890');
  assert.equal(shopify.fulfillments[0].trackingInfo.number, '1234567890');
  assert.equal(row(db).reconciledBy, 'admin@example.com');
  await rejects(op({ op: 'label', parcelId: 'PCL-1' }), 'no_label'); // the label is in MyDHL, not here
});

test('reconcileNoShipmentTooEarlyBefore180s', async () => {
  const { op, clock } = await needsReconciliation();
  const body = { op: 'reconcile', parcelId: 'PCL-1', decision: 'no_dhl_shipment', actor: ADMIN };
  clock.advance(179);
  await rejects(op(body), 'too_early');
  clock.advance(1);
  assert.equal((await op(body)).status, 'rejected');
});

test('reconcileNoShipmentRejectsParcelId', async () => {
  const { op, clock, dhl } = await needsReconciliation();
  clock.advance(180);
  await op({ op: 'reconcile', parcelId: 'PCL-1', decision: 'no_dhl_shipment', actor: ADMIN });
  assert.equal((await op(createBody())).status, 'rejected'); // same parcelId: never resent
  await rejects(op(createBody({ pieces: [TWO_PIECES[0]] })), 'parcel_id_conflict');
  assert.equal(dhl.calls.length, 1);
  // Only needs_reconciliation can be reconciled.
  await rejects(op({ op: 'reconcile', parcelId: 'PCL-1', decision: 'no_dhl_shipment', actor: ADMIN }), 'invalid_state');
});

test('lateCompletionAfterRejectRaisesDuplicateAlert', async () => {
  const { op, dhl, clock, db, logs, shopify } = await setup();
  const gate = deferred();
  dhl.hold = gate.promise;
  const inflight = op(createBody());
  await new Promise((r) => setImmediate(r));
  clock.advance(181);
  await op({ op: 'reconcile', parcelId: 'PCL-1', decision: 'no_dhl_shipment', actor: ADMIN });
  gate.resolve();
  const res = await inflight;
  assert.equal(res.status, 'rejected');
  assert.equal(res.lateTrackingNumber, '900000001');
  assert.equal(row(db).lateLabel, dhl.label); // never discarded
  assert.equal(shopify.fulfillments.length, 0);
  const audit = await op({ op: 'audit' });
  assert.equal(audit.alerts.length, 1);
  assert.equal(audit.alerts[0].type, 'duplicate_shipment_suspected');
  assert.equal(audit.alerts[0].parcelId, 'PCL-1');
  assert.ok(logs.some((l) => l.includes('duplicate_shipment_suspected') && l.includes('PCL-1')));
});

// ---------- Fault injection: Operations-like caller, process dies after DHL ----------

async function faultInjection(parcels) {
  const s = await setup();
  // First run: DHL succeeds, then the process dies before Shopify is reached.
  for (const p of parcels) {
    s.ctx.getAdmin = async () => s.shopify.admin;
    s.dhl.onCall = () => { s.ctx.getAdmin = async () => { throw new Error('process killed'); }; };
    await assert.rejects(s.op(createBody(p)), /process killed/);
  }
  s.dhl.onCall = null;
  assert.equal(s.dhl.calls.length, parcels.length);
  for (const p of parcels) assert.equal(row(s.db, p.parcelId).status, 'label_created');
  // Restart: Operations retries every parcel with the same parcelId.
  s.ctx.getAdmin = async () => s.shopify.admin;
  for (const p of parcels) assert.equal((await s.op(createBody(p))).status, 'fulfilled');
  assert.equal(s.dhl.calls.length, parcels.length, 'exactly one DHL call per parcel');
  assert.equal(s.shopify.fulfillments.length, parcels.length);
  for (const p of parcels) {
    const label = await s.op({ op: 'label', parcelId: p.parcelId });
    assert.equal(label.pdfBase64, s.dhl.label, 'label kept');
  }
}

test('faultInjectionKillAfterDhlMultiPiece', () => faultInjection([{ parcelId: 'PCL-M' }]));

test('faultInjectionKillAfterDhlSeparate', () => faultInjection([
  { parcelId: 'PCL-S1', pieces: [TWO_PIECES[0]], lines: [{ lineItemId: '11', quantity: 1 }] },
  { parcelId: 'PCL-S2', pieces: [TWO_PIECES[1]], lines: [{ lineItemId: '12', quantity: 2 }] },
]));

// ---------- Customs paper (T6b) ----------

test('noInvoiceInParcelLabelPdfWhenPlt', async () => {
  const { op, dhl } = await setup({ alwaysInvoice: true }); // even if DHL sent one anyway
  await op(createBody());
  const req = dhl.calls[0];
  assert.ok(req.valueAddedServices.some((v) => v.serviceCode === 'WY'));
  assert.ok(!req.outputImageProperties.imageOptions.some((o) => o.typeCode === 'invoice'));
  const label = await op({ op: 'label', parcelId: 'PCL-1' });
  assert.equal(label.customsPaperRequired, false);
  assert.equal(label.invoicePdfBase64, undefined);
  assert.equal(await pdfTitle(label.pdfBase64), 'DHL LABEL');
  assert.equal((await PDFDocument.load(Buffer.from(label.pdfBase64, 'base64'))).getPageCount(), 1);
});

test('nonPltFlagsCustomsPaperRequired', async () => {
  const lines = [{ id: '31', sku: 'GPIST3040LB', quantity: 2, unitPrice: 120 }];
  const { op, dhl } = await setup({ country: 'TR', lines });
  const res = await op(createBody({ lines: [{ lineItemId: '31', quantity: 2 }] }));
  assert.equal(res.customsPaperRequired, true);
  const req = dhl.calls[0];
  assert.ok(!req.valueAddedServices.some((v) => v.serviceCode === 'WY'));
  assert.ok(req.outputImageProperties.imageOptions.some((o) => o.typeCode === 'invoice'));
  const label = await op({ op: 'label', parcelId: 'PCL-1' });
  assert.equal(label.customsPaperRequired, true);
  assert.equal(await pdfTitle(label.pdfBase64), 'DHL LABEL');
  assert.equal(await pdfTitle(label.invoicePdfBase64), 'COMMERCIAL INVOICE');
});

// ---------- Retention ----------

test('requestJsonPiiRedactedAfter90Days', async () => {
  const { op, db, clock } = await setup();
  await op(createBody());
  const before = JSON.parse(row(db).requestJson);
  const hash = row(db).requestHash;
  clock.advance(89 * 86400);
  assert.equal((await op({ op: 'audit' })).redacted, 0);
  clock.advance(2 * 86400);
  assert.equal((await op({ op: 'audit' })).redacted, 1);
  const after = JSON.parse(row(db).requestJson);
  assert.equal(row(db).requestHash, hash);
  assert.deepEqual(after.customerDetails.receiverDetails, { postalAddress: { countryCode: 'DE' }, typeCode: 'private', redacted: true });
  assert.ok(!row(db).requestJson.includes('Test Recipient') && !row(db).requestJson.includes('Teststrasse') && !row(db).requestJson.includes('+10000000000'));
  assert.deepEqual(after.content, before.content);
  assert.deepEqual(after.customerReferences, before.customerReferences);
  assert.equal((await op({ op: 'audit' })).redacted, 0); // once
});

// ---------- Legacy batch ----------

test('legacyBatchSkipsOrdersWithParcels', async () => {
  const { op, shopify, db, dhl } = await setup();
  await op(createBody());
  const out = await createLabelBatch({ admin: shopify.admin, shop: SHOP, settings: SETTINGS, orderIds: ['1001'] });
  assert.match(out.summary[0].error, /Operations/);
  assert.equal(out.pages, 0);
  assert.equal(out.pickup, null);
  assert.equal(dhl.calls.length, 1); // only the parcel's own call
  assert.equal(db.shipment.rows.size, 1); // the parcel's tracking row, nothing from the batch
});

// ---------- Rates and lock ----------

test('ratesReturnsAllAllowedServicesWithEta', async () => {
  const { op, dhl } = await setup();
  const res = await op({ op: 'rates', destination: { countryCode: 'de', city: 'Berlin', postalCode: '10115' }, declaredValue: 300, currency: 'usd', pieces: TWO_PIECES });
  assert.deepEqual(res.services, [{ productCode: 'P', name: 'EXPRESS WORLDWIDE', price: 210.5, currency: 'AED', estimatedDelivery: '2026-11-20T23:59:00' }]);
  assert.equal(dhl.rateCalls[0].address.countryCode, 'DE');
  assert.equal(dhl.rateCalls[0].currency, 'USD');
  assert.equal(dhl.rateCalls[0].parcels.length, 2);

  assert.deepEqual(svc.allowedProductCodes({}, {}), ['P', 'N']);
  assert.deepEqual(svc.allowedProductCodes({}, { PARCEL_ALLOWED_PRODUCT_CODES: 'P, N, Y' }), ['P', 'N', 'Y']);
  assert.deepEqual(svc.allowedProductCodes({ parcel: { allowedProductCodes: ['P'] } }, {}), ['P']);
});

test('dhl.rates() asks for every product and maps price and ETA (MyDHL v2 field names)', async () => {
  let sent;
  const dhl = createDhlClient({ apiKey: 'k', apiSecret: 's', accountNumber: '1', now: () => new Date('2026-11-17T08:00:00Z'), fetchImpl: async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ products: [
      { productName: 'EXPRESS WORLDWIDE', productCode: 'P', totalPrice: [{ currencyType: 'BILLC', priceCurrency: 'AED', price: 210.5 }, { currencyType: 'PULCL', priceCurrency: 'EUR', price: 50 }],
        deliveryCapabilities: { estimatedDeliveryDateAndTime: '2026-11-20T23:59:00', totalTransitDays: '3' } },
      { productName: 'EXPRESS 12:00', productCode: 'Y', totalPrice: [{ currencyType: 'BILLC', priceCurrency: 'AED', price: 320 }] },
      { productName: 'NO PRICE', productCode: 'Z', totalPrice: [] },
    ] }) };
  } });
  const services = await dhl.rates({ address: { countryCode: 'DE', city: 'Berlin', postalCode: '10115' }, parcels: TWO_PIECES, declaredValue: 300, currency: 'USD' });
  assert.match(sent.url, /\/rates$/);
  assert.equal(sent.body.productCode, undefined);
  assert.equal(sent.body.packages.length, 2);
  assert.deepEqual(services, [
    { productCode: 'P', name: 'EXPRESS WORLDWIDE', price: 210.5, currency: 'AED', estimatedDelivery: '2026-11-20T23:59:00' },
    { productCode: 'Y', name: 'EXPRESS 12:00', price: 320, currency: 'AED', estimatedDelivery: null },
  ]);
});

test('lockedStoreRefusesCreateButRates', async () => {
  const locked = isLocked(SETTINGS, SHOP, {});
  assert.equal(locked, true); // test mode and not certified
  assert.equal(isLocked({ dhl: { env: 'live' } }, SHOP, { DHL_SHIPMENTS_CERTIFIED: '1' }), false);
  const { op, dhl, db } = await setup({ locked });
  const rates = await op({ op: 'rates', destination: { countryCode: 'DE', city: 'Berlin' }, pieces: TWO_PIECES });
  assert.equal(rates.services.length, 1);
  await assert.rejects(op(createBody()), (e) => {
    assert.equal(e.code, 'locked');
    assert.equal(e.extra.status, 'locked');
    return true;
  });
  assert.equal(dhl.calls.length, 0);
  assert.equal(db.parcel.rows.size, 0);
});

test('product codes outside P and N are refused, and must match the recipient', async () => {
  const { op } = await setup();
  await rejects(op(createBody({ productCode: 'Y' })), 'product_not_allowed');
  await rejects(op(createBody({ productCode: 'N' })), 'product_mismatch');
});

// ---------- Auth ----------

test('hmacRejectsStaleOrForged', () => {
  const key = 'test-only-key';
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const body = JSON.stringify({ op: 'status', shop: SHOP, parcelId: 'PCL-1' });
  const sig = signParcelRequest(key, ts, body);
  assert.match(sig, /^[0-9a-f]{64}$/);
  const check = (o) => verifyParcelRequest({ key, timestamp: ts, signature: sig, rawBody: body, now, ...o });
  assert.deepEqual(check({}), { ok: true });
  assert.equal(check({ rawBody: body.replace('PCL-1', 'PCL-2') }).code, 'bad_signature');
  assert.equal(check({ signature: sig.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }).code, 'bad_signature');
  assert.equal(check({ signature: sig.toUpperCase() }).code, 'bad_signature');
  assert.equal(check({ signature: sig.slice(2) }).code, 'bad_signature');
  assert.equal(check({ signature: undefined }).code, 'bad_signature');
  assert.equal(check({ key: 'other-key' }).code, 'bad_signature');
  assert.equal(check({ now: now + 301_000 }).code, 'stale_request');
  assert.equal(check({ now: now - 301_000 }).code, 'stale_request');
  assert.deepEqual(check({ now: now + 300_000 }), { ok: true });
  assert.equal(check({ timestamp: 'abc' }).code, 'bad_timestamp');
  const missing = check({ key: undefined });
  assert.equal(missing.code, 'service_key_missing');
  assert.equal(missing.status, 503);
  assert.equal(check({ key: '' }).status, 503);
});

test('unknown op is refused', async () => {
  const { op } = await setup();
  await rejects(op({ op: 'constructor' }), 'bad_request');
  await rejects(op({ op: 'delete' }), 'bad_request');
});

// ---------- Route: the wire format Operations signs against ----------

test('route /internal/parcels: fail closed without a key, HMAC headers, JSON errors {error, code}', async () => {
  const route = await import('../../routes/internal.parcels.jsx');
  const { shopify, dhl } = await setup();
  globalThis.__multishipTestShopify = { [SHOP]: shopify.admin };
  const send = (body, { key, ts = Math.floor(Date.now() / 1000), headers = {} } = {}) => {
    const raw = JSON.stringify(body);
    const h = { 'Content-Type': 'application/json', 'X-Siluet-Timestamp': String(ts), ...(key ? { 'X-Siluet-Signature': signParcelRequest(key, String(ts), raw) } : {}), ...headers };
    return route.action({ request: new Request('https://multiship.example/internal/parcels', { method: 'POST', headers: h, body: raw }) });
  };
  const saved = process.env.OPERATIONS_SERVICE_KEY;
  const savedShops = process.env.PARCEL_SHOPS;
  try {
    delete process.env.OPERATIONS_SERVICE_KEY;
    let res = await send({ op: 'status', shop: SHOP, parcelId: 'PCL-1' }, { key: 'anything' });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'Parcel service is not configured', code: 'service_key_missing' });

    process.env.OPERATIONS_SERVICE_KEY = 'route-test-key';
    process.env.PARCEL_SHOPS = SHOP;
    res = await send({ op: 'status', shop: SHOP, parcelId: 'PCL-1' });
    assert.equal(res.status, 401);
    res = await send({ op: 'status', shop: SHOP, parcelId: 'PCL-1' }, { key: 'wrong-key' });
    assert.equal((await res.json()).code, 'bad_signature');
    res = await send({ op: 'status', shop: SHOP, parcelId: 'PCL-1' }, { key: 'route-test-key', ts: Math.floor(Date.now() / 1000) - 301 });
    assert.equal((await res.json()).code, 'stale_request');

    res = await send({ op: 'status', shop: SHOP, parcelId: 'PCL-1' }, { key: 'route-test-key' });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Parcel not found', code: 'not_found' });

    res = await send({ op: 'status', shop: 'evil.example.com', parcelId: 'PCL-1' }, { key: 'route-test-key' });
    assert.equal(res.status, 400);

    // Test-mode settings: real labels are locked, so create answers 423 locked without calling DHL.
    res = await send({ ...createBody(), shop: SHOP }, { key: 'route-test-key' });
    assert.equal(res.status, 423);
    assert.deepEqual(await res.json(), { error: 'Real DHL labels are switched off until DHL Production is enabled by the owner', code: 'locked', parcelId: 'PCL-1', status: 'locked' });
    assert.equal(dhl.calls.length, 0);

    res = await send({ op: 'plan', shop: SHOP, orderId: '1001' }, { key: 'route-test-key' });
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.equal(plan.locked, true);
    assert.equal(plan.recipients[0].lines.length, 2);

    res = await route.loader();
    assert.equal(res.status, 405);
  } finally {
    if (saved === undefined) delete process.env.OPERATIONS_SERVICE_KEY; else process.env.OPERATIONS_SERVICE_KEY = saved;
    if (savedShops === undefined) delete process.env.PARCEL_SHOPS; else process.env.PARCEL_SHOPS = savedShops;
    delete globalThis.__multishipTestShopify;
  }
});


// ---------- Fix round: concurrency, legacy labels, persist-first, limits ----------

test('concurrent creates for the same lines (one process): one DHL call, the other quantity_conflict', async () => {
  const { op, dhl, db } = await setup();
  const both = await Promise.allSettled([
    op(createBody({ parcelId: 'PCL-A', lines: [{ lineItemId: '12', quantity: 2 }] })),
    op(createBody({ parcelId: 'PCL-B', lines: [{ lineItemId: '12', quantity: 2 }] })),
  ]);
  assert.equal(dhl.calls.length, 1);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = both.find((r) => r.status === 'rejected');
  assert.equal(lost.reason.code, 'quantity_conflict');
  assert.equal(lost.reason.status, 409);
  assert.equal([...db.parcel.rows.values()].filter((p) => p.trackingNumber).length, 1);
});

// Two processes (separate in-process locks). Process A reads the clock first (earlier claimedAt) but its insert
// only becomes visible after process B has inserted, checked, booked DHL and fulfilled. Ordering by claimedAt
// would let A pass too (two labels); ordering by insert order (rowid) rejects A before DHL.
async function twoProcessRace({ qtyEach, stock }) {
  const lines = [{ id: '41', sku: 'SMB-BERLIN', quantity: stock, unitPrice: 135 }];
  const s = await setup({ lines });
  let arrived = 0;
  let bothRead;
  const readGate = new Promise((r) => { bothRead = r; });
  s.shopify.foBarrier = async () => { if (++arrived === 2) bothRead(); await readGate; }; // both pre-checks see no claim
  let releaseA;
  const aHeld = new Promise((r) => { releaseA = r; });
  s.db.parcel.beforeInsert = async (data) => { if (data.id === 'PCL-A') await aHeld; };
  const t0 = s.clock.now().getTime();
  const procA = { ...s.ctx, orderLocks: new Map(), now: () => new Date(t0) }; // earlier clock
  const procB = { ...s.ctx, orderLocks: new Map(), now: () => new Date(t0 + 1000) };
  const body = (id) => ({ shop: SHOP, ...createBody({ parcelId: id, pieces: [TWO_PIECES[0]], lines: [{ lineItemId: '41', quantity: qtyEach }] }) });
  // B's DHL call is held open, so B is still pending when A finally inserts and checks.
  let releaseB;
  s.dhl.hold = new Promise((r) => { releaseB = r; });
  s.dhl.onCall = () => { s.dhl.onCall = null; s.shopify.foBarrier = null; releaseA(); }; // A's insert lands only after B's check
  const a = svc.handleParcelOp(body('PCL-A'), procA);
  const b = svc.handleParcelOp(body('PCL-B'), procB);
  const [ra] = await Promise.allSettled([a]);
  releaseB();
  const [rb] = await Promise.allSettled([b]);
  return { s, ra, rb };
}

test('concurrent creates from two processes: insert order, not the clock, decides; never two labels for overlapping lines', async () => {
  const { s, ra, rb } = await twoProcessRace({ qtyEach: 2, stock: 3 });
  assert.equal(rb.status, 'fulfilled');
  assert.equal(rb.value.status, 'fulfilled');
  assert.equal(ra.reason?.code, 'quantity_conflict');
  assert.equal(s.dhl.calls.length, 1, 'exactly one label for overlapping lines');
  assert.equal(row(s.db, 'PCL-A').status, 'rejected'); // inserted, then rejected by the post-insert check, before DHL
  assert.ok(row(s.db, 'PCL-A').claimedAt < row(s.db, 'PCL-B').claimedAt, 'A had the earlier clock and still lost');
  // The rejected claim holds nothing: the last unit is still available.
  const c = await s.op(createBody({ parcelId: 'PCL-C', pieces: [TWO_PIECES[0]], lines: [{ lineItemId: '41', quantity: 1 }] }));
  assert.equal(c.status, 'fulfilled');
  assert.equal(s.dhl.calls.length, 2);
});

test('concurrent creates from two processes that do not overlap both ship', async () => {
  const { s, ra, rb } = await twoProcessRace({ qtyEach: 1, stock: 2 });
  assert.equal(rb.value.status, 'fulfilled');
  assert.equal(ra.value.status, 'fulfilled');
  assert.equal(s.dhl.calls.length, 2);
});

test('a second create arriving between the first claim and its DHL result is refused without DHL', async () => {
  const { op, dhl } = await setup();
  const gate = deferred();
  dhl.hold = gate.promise;
  const first = op(createBody({ parcelId: 'PCL-A', lines: [{ lineItemId: '12', quantity: 2 }] }));
  await new Promise((r) => setImmediate(r));
  await rejects(op(createBody({ parcelId: 'PCL-B', lines: [{ lineItemId: '12', quantity: 1 }] })), 'quantity_conflict');
  gate.resolve();
  assert.equal((await first).status, 'fulfilled');
  assert.equal(dhl.calls.length, 1);
});

test('legacy_label_exists: a recipient labelled by the old batch is not labelled again', async () => {
  const { op, dhl, db } = await setup();
  await db.shipment.create({ data: { shop: SHOP, orderId: '1001', orderName: '#1001', recipientId: 'r1', letter: '-', name: 'Test Recipient', country: 'DE', trackingNumber: '5550001111', fulfilled: false } });
  await assert.rejects(op(createBody()), (e) => { assert.equal(e.code, 'legacy_label_exists'); assert.equal(e.status, 409); return true; });
  assert.equal(dhl.calls.length, 0);
  assert.equal(db.parcel.rows.size, 0);
});

test('pdf-lib failure: tracking and raw label documents kept, label_created with an error, nothing sent to Shopify', async () => {
  const { op, dhl, db, shopify } = await setup();
  dhl.labels = [dhl.label, Buffer.from('not a pdf').toString('base64')];
  const res = await op(createBody());
  assert.equal(res.status, 'label_created');
  assert.equal(res.trackingNumber, '900000001');
  assert.match(res.error, /Label PDF could not be prepared/);
  assert.deepEqual(JSON.parse(row(db).labelDocuments), dhl.labels);
  assert.equal(shopify.fulfillments.length, 0);
  await assert.rejects(op({ op: 'label', parcelId: 'PCL-1' }), (e) => {
    assert.equal(e.code, 'label_merge_failed');
    assert.deepEqual(e.extra.labelDocumentsBase64, dhl.labels);
    return true;
  });
  assert.equal(dhl.calls.length, 1);
});

test('two good label documents are merged into one PDF before fulfilment', async () => {
  const { op, dhl, db } = await setup();
  dhl.labels = [dhl.label, dhl.label];
  assert.equal((await op(createBody())).status, 'fulfilled');
  assert.equal((await PDFDocument.load(Buffer.from(row(db).label, 'base64'))).getPageCount(), 2);
});

test('fault injection: process dies between the DHL response and the DB write', async () => {
  const s = await setup();
  const realUpdateMany = s.db.parcel.updateMany;
  s.dhl.onCall = () => { s.db.parcel.updateMany = async () => { throw new Error('process killed'); }; };
  const res = await s.op(createBody());
  assert.equal(res.status, 'needs_reconciliation');
  assert.equal(res.trackingNumber, '900000001');
  assert.deepEqual(s.logs, ['[parcels] dhl_result_not_saved parcel=PCL-1 tracking=900000001']); // no recipient data
  assert.equal(row(s.db).status, 'pending');
  assert.equal(row(s.db).trackingNumber, null);
  // Restart.
  s.db.parcel.updateMany = realUpdateMany;
  s.dhl.onCall = null;
  s.clock.advance(121);
  assert.equal((await s.op(createBody())).status, 'needs_reconciliation');
  assert.equal(s.dhl.calls.length, 1, 'never resent');
  const fixed = await s.op({ op: 'reconcile', parcelId: 'PCL-1', decision: 'dhl_shipment_found', trackingNumber: res.trackingNumber, actor: ADMIN });
  assert.equal(fixed.status, 'fulfilled');
  assert.equal(s.shopify.fulfillments.length, 1);
});

test('dhl_shipment_found refuses a tracking number that belongs to another parcel', async () => {
  const s = await setup();
  await s.op(createBody({ parcelId: 'PCL-A', pieces: [TWO_PIECES[0]], lines: [{ lineItemId: '11', quantity: 1 }] }));
  s.dhl.failNext = new Error('fetch failed');
  await s.op(createBody({ parcelId: 'PCL-B', pieces: [TWO_PIECES[0]], lines: [{ lineItemId: '12', quantity: 1 }] }));
  await rejects(s.op({ op: 'reconcile', parcelId: 'PCL-B', decision: 'dhl_shipment_found', trackingNumber: '900000001', actor: ADMIN }), 'tracking_in_use');
});

test('no_dhl_shipment minimum age: PARCEL_NO_SHIPMENT_MIN_AGE_SECONDS raises it, never below 180 s', async () => {
  assert.equal(svc.noShipmentMinAgeMs({}), 180_000);
  assert.equal(svc.noShipmentMinAgeMs({ PARCEL_NO_SHIPMENT_MIN_AGE_SECONDS: '60' }), 180_000);
  assert.equal(svc.noShipmentMinAgeMs({ PARCEL_NO_SHIPMENT_MIN_AGE_SECONDS: 'abc' }), 180_000);
  assert.equal(svc.noShipmentMinAgeMs({ PARCEL_NO_SHIPMENT_MIN_AGE_SECONDS: '600' }), 600_000);
  const s = await needsReconciliation();
  s.ctx.env = { PARCEL_NO_SHIPMENT_MIN_AGE_SECONDS: '600' };
  const body = { op: 'reconcile', parcelId: 'PCL-1', decision: 'no_dhl_shipment', actor: ADMIN };
  s.clock.advance(599);
  await rejects(s.op(body), 'too_early');
  s.clock.advance(1);
  assert.equal((await s.op(body)).status, 'rejected');
});

test('rates: a DHL 4xx becomes 422 dhl_rates_refused with a truncated message; other failures 502', async () => {
  const { op, dhl } = await setup();
  dhl.rates = async () => { throw Object.assign(new Error(`DHL /rates 400: ${'x'.repeat(1000)}`), { status: 400 }); };
  await assert.rejects(op({ op: 'rates', destination: { countryCode: 'GB', city: 'London' }, pieces: TWO_PIECES }), (e) => {
    assert.equal(e.code, 'dhl_rates_refused');
    assert.equal(e.status, 422);
    assert.ok(e.message.length <= 300);
    return true;
  });
  dhl.rates = async () => { throw new Error('fetch failed'); };
  await rejects(op({ op: 'rates', destination: { countryCode: 'GB', city: 'London' }, pieces: TWO_PIECES }), 'dhl_unavailable');
});

test('auth: the key is trimmed the same way when signing and verifying', () => {
  const ts = '1800000000';
  const sig = signParcelRequest('abc', ts, '{}');
  assert.equal(signParcelRequest(' abc\n', ts, '{}'), sig);
  assert.deepEqual(verifyParcelRequest({ key: 'abc \n', timestamp: ts, signature: sig, rawBody: '{}', now: 1_800_000_000_000 }), { ok: true });
  assert.equal(verifyParcelRequest({ key: '  ', timestamp: ts, signature: sig, rawBody: '{}', now: 1_800_000_000_000 }).status, 503);
});

// ---------- Route: shop allow-list, body cap, and the Operations rates contract ----------

async function withRoute(env, fn) {
  const route = await import('../../routes/internal.parcels.jsx');
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try {
    return await fn(route);
  } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const signed = (raw, key, extraHeaders = {}) => {
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request('https://multiship.example/internal/parcels', {
    method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Siluet-Timestamp': ts, 'X-Siluet-Signature': signParcelRequest(key, ts, raw), ...extraHeaders },
  });
};

test('route: PARCEL_SHOPS unset refuses every shop; unlisted shops and the dev store are refused', async () => {
  await setup();
  const raw = (shop) => JSON.stringify({ op: 'status', shop, parcelId: 'PCL-1' });
  await withRoute({ OPERATIONS_SERVICE_KEY: 'k1', PARCEL_SHOPS: undefined }, async (route) => {
    const res = await route.action({ request: signed(raw(SHOP), 'k1') });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'shops_not_configured');
  });
  await withRoute({ OPERATIONS_SERVICE_KEY: 'k1', PARCEL_SHOPS: 'wearesiluet-us.myshopify.com' }, async (route) => {
    for (const shop of [SHOP, 'siluet-multiship-test.myshopify.com']) {
      const res = await route.action({ request: signed(raw(shop), 'k1') });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).code, 'shop_not_allowed');
    }
  });
});

test('route: body cap is enforced in bytes before reading everything', async () => {
  await setup();
  await withRoute({ OPERATIONS_SERVICE_KEY: 'k1', PARCEL_SHOPS: SHOP }, async (route) => {
    // 100 000 three-byte characters: under 256 KB as characters, over it as bytes.
    const big = JSON.stringify({ op: 'status', shop: SHOP, parcelId: 'PCL-1', pad: '€'.repeat(100_000) });
    assert.ok(big.length < 256 * 1024 && Buffer.byteLength(big) > 256 * 1024);
    let res = await route.action({ request: signed(big, 'k1') });
    assert.equal(res.status, 413);
    res = await route.action({ request: signed('{}', 'k1', { 'Content-Length': String(10 * 1024 * 1024) }) });
    assert.equal(res.status, 413);
  });
});

test('Operations rates contract: the shared fixture runs through the real route and dhl.rates() with a fake DHL endpoint', async () => {
  const raw = fs.readFileSync(new URL('./fixtures/operations-rates-request.json', import.meta.url), 'utf8');
  const fixture = JSON.parse(raw);
  const { db } = await setup();
  db.shopSetting.row = { shop: fixture.shop, data: JSON.stringify({ dhl: { env: 'test', apiKey: 'fake-key', apiSecret: 'fake-secret', accountNumber: '000000000' } }) };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/express\.api\.dhl\.com\/mydhlapi\/test\/rates$/); // DHL test endpoint, never live
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ products: [
      { productName: 'EXPRESS WORLDWIDE', productCode: 'P', totalPrice: [{ currencyType: 'BILLC', priceCurrency: 'AED', price: 260.4 }], deliveryCapabilities: { estimatedDeliveryDateAndTime: '2026-11-20T23:59:00' } },
      { productName: 'EXPRESS 12:00', productCode: 'Y', totalPrice: [{ currencyType: 'BILLC', priceCurrency: 'AED', price: 340 }], deliveryCapabilities: { estimatedDeliveryDateAndTime: '2026-11-20T12:00:00' } },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await withRoute({ OPERATIONS_SERVICE_KEY: 'k1', PARCEL_SHOPS: fixture.shop }, async (route) => {
      const res = await route.action({ request: signed(raw, 'k1') });
      assert.equal(res.status, 200);
      const out = await res.json();
      assert.deepEqual(Object.keys(out), ['services']);
      assert.deepEqual(out.services, [{ productCode: 'P', name: 'EXPRESS WORLDWIDE', price: 260.4, currency: 'AED', estimatedDelivery: '2026-11-20T23:59:00' }]);
      for (const sv of out.services) assert.deepEqual(Object.keys(sv), ['productCode', 'name', 'price', 'currency', 'estimatedDelivery']);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].customerDetails.receiverDetails, { countryCode: 'GB', cityName: 'London', postalCode: 'SW1A 1AA' });
  assert.deepEqual(sent[0].packages, fixture.pieces.map((p) => ({ weight: p.weight, dimensions: { length: p.length, width: p.width, height: p.height } })));
  assert.deepEqual(sent[0].monetaryAmount, [{ typeCode: 'declaredValue', value: 450, currency: 'USD' }]);
});

test('Operations rates contract: the same fixture through handleParcelOp with the fake DHL client; domestic quote without value/currency', async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/operations-rates-request.json', import.meta.url), 'utf8'));
  const { ctx, dhl } = await setup();
  const out = await svc.handleParcelOp(fixture, { ...ctx, shop: fixture.shop });
  assert.deepEqual(out, { services: [{ productCode: 'P', name: 'EXPRESS WORLDWIDE', price: 210.5, currency: 'AED', estimatedDelivery: '2026-11-20T23:59:00' }] });
  assert.deepEqual(dhl.rateCalls[0], { address: { countryCode: 'GB', city: 'London', postalCode: 'SW1A 1AA', provinceCode: '' }, parcels: fixture.pieces, declaredValue: 450, currency: 'USD', ddp: false });
  const { declaredValue, currency, ...domestic } = { ...fixture, destination: { countryCode: 'AE', city: 'Dubai', provinceCode: 'DU' } };
  assert.ok(declaredValue && currency);
  await svc.handleParcelOp(domestic, { ...ctx, shop: fixture.shop });
  assert.equal(dhl.rateCalls[1].declaredValue, 0);
  assert.equal(dhl.rateCalls[1].address.provinceCode, 'DU');
});

// The Operations repo test (scripts/test-quotes.mjs) pins the same constant. Both must change together.
const OPERATIONS_RATES_FIXTURE_SHA256 = 'c3e183ab013cb977cce478139ffe075c118c83813a6fff1542d43c25dfffd83e';

test('Operations rates fixture checksum matches the constant pinned in both repos', async () => {
  const { createHash } = await import('node:crypto');
  const raw = fs.readFileSync(new URL('./fixtures/operations-rates-request.json', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(JSON.stringify(JSON.parse(raw))).digest('hex'), OPERATIONS_RATES_FIXTURE_SHA256);
});

// ---------- Snapshot rules: fulfilled parcels the snapshot predates, claims past pending, fulfilment IDs ----------

test('stale snapshot: a claim that read Shopify before another parcel was fulfilled is refused', async () => {
  const lines = [{ id: '12', sku: 'MGD-PARIS', quantity: 2, unitPrice: 165 }];
  const s = await setup({ lines });
  // Q's FIRST fulfilment-order answer is captured, then held while P runs all the way to fulfilled.
  let release;
  const gate = new Promise((r) => { release = r; });
  let first = true;
  let captured;
  const captureReached = new Promise((r) => { captured = r; });
  const qAdmin = { async graphql(query, opts) {
    const res = await s.shopify.admin.graphql(query, opts);
    if (first && /ParcelFOs/.test(query)) {
      first = false;
      const body = await res.json();
      captured();
      await gate;
      return { json: async () => body };
    }
    return res;
  } };
  const body = (id) => ({ shop: SHOP, ...createBody({ parcelId: id, pieces: [TWO_PIECES[0]], lines: [{ lineItemId: '12', quantity: 2 }] }) });
  const q = svc.handleParcelOp(body('Q'), { ...s.ctx, orderLocks: new Map(), getAdmin: async () => qAdmin });
  await captureReached;
  const p = await svc.handleParcelOp(body('P'), { ...s.ctx, orderLocks: new Map() });
  assert.equal(p.status, 'fulfilled');
  release();
  await assert.rejects(q, (e) => e.code === 'quantity_conflict');
  assert.equal(s.dhl.calls.length, 1);
});

test('a later-inserted claim that is already past pending still holds its quantity', async () => {
  const lines = [{ id: '12', sku: 'MGD-PARIS', quantity: 2, unitPrice: 165 }];
  const s = await setup({ lines });
  // Right after Q's insert, a row inserted later (higher rowid) that DHL already booked appears.
  s.db.parcel.afterInsert = async (row) => {
    if (row.id !== 'Q') return;
    s.db.parcel.afterInsert = null;
    await s.db.parcel.create({ data: {
      id: 'P', shop: SHOP, orderId: '1001', orderName: '#1001', recipientId: 'r1', productCode: 'P', pieces: '[]',
      lines: JSON.stringify([{ lineItemId: 'gid://shopify/LineItem/12', quantity: 2 }]), requestHash: 'x', requestJson: '{}',
      status: 'label_created', trackingNumber: '777000777', claimedAt: s.clock.now(),
    } });
  };
  await rejects(s.op(createBody({ parcelId: 'Q', pieces: [TWO_PIECES[0]], lines: [{ lineItemId: '12', quantity: 2 }] })), 'quantity_conflict');
  assert.equal(s.dhl.calls.length, 0);
  assert.ok(s.db.parcel.rowids.get('P') > s.db.parcel.rowids.get('Q'));
});

test('fulfilment ID: a fulfilled parcel whose tracking number was removed in Shopify no longer holds quantity', async () => {
  const lines = [{ id: '12', sku: 'MGD-PARIS', quantity: 3, unitPrice: 165 }];
  const s = await setup({ lines });
  await s.op(createBody({ parcelId: 'P', pieces: [TWO_PIECES[0]], lines: [{ lineItemId: '12', quantity: 2 }] }));
  assert.equal(row(s.db, 'P').shopifyFulfillmentId, 'gid://shopify/Fulfillment/1');
  s.shopify.fulfillments[0].trackingInfo.number = ''; // tracking removed in Shopify; the fulfilment stays
  const c = await s.op(createBody({ parcelId: 'C', pieces: [TWO_PIECES[0]], lines: [{ lineItemId: '12', quantity: 1 }] }));
  assert.equal(c.status, 'fulfilled');
  assert.equal(s.dhl.calls.length, 2);
});

test('fulfilment ID is also recorded when Shopify already had the fulfilment (answer lost)', async () => {
  const { op, shopify, db } = await setup();
  shopify.failAfter.ParcelFulfil = new Error('connection reset');
  assert.equal((await op(createBody())).status, 'fulfilled');
  assert.equal(row(db).shopifyFulfillmentId, 'gid://shopify/Fulfillment/1');
});


// ---------- M5: plan additions (dhlCity, line prices, unsupported recipients) and the duplicate audit ----------

test('plan: dhlCity is the city the shipment builder sends to DHL (UAE emirate), city stays as in Shopify', async () => {
  const { op, dhl } = await setup({ country: 'AE' });
  const plan = await op({ op: 'plan', orderId: '1001' });
  const r = plan.recipients[0];
  assert.equal(r.city, 'Business Bay');
  assert.equal(r.dhlCity, 'Dubai');
  await op(createBody({ productCode: 'N' }));
  assert.equal(dhl.calls[0].customerDetails.receiverDetails.postalAddress.cityName, r.dhlCity);

  const de = await setup();
  const dePlan = await de.op({ op: 'plan', orderId: '1001' });
  assert.equal(dePlan.recipients[0].dhlCity, 'Berlin');
  await de.op(createBody());
  assert.equal(de.dhl.calls[0].customerDetails.receiverDetails.postalAddress.cityName, dePlan.recipients[0].dhlCity);

  const none = await setup({ country: 'AE_NO_EMIRATE' });
  assert.equal((await none.op({ op: 'plan', orderId: '1001' })).recipients[0].dhlCity, null);
});

test('plan: lines carry unitPrice (decimal string) and currency from originalUnitPriceSet; create customs prices unchanged', async () => {
  const { op, dhl } = await setup();
  const plan = await op({ op: 'plan', orderId: '1001' });
  assert.deepEqual(plan.recipients[0].lines.map((l) => [l.lineItemId, l.unitPrice, l.currency]),
    [['gid://shopify/LineItem/11', '135', 'USD'], ['gid://shopify/LineItem/12', '165', 'USD']]);
  assert.equal(plan.recipients[0].supported, true);
  assert.equal(plan.recipients[0].reason, undefined);
  await op(createBody());
  assert.deepEqual(dhl.calls[0].content.exportDeclarations[0].lineItems.map((l) => l.price), [135, 165]);
  assert.equal(dhl.calls[0].content.declaredValue, 465);
});

test('plan: a recipient with a SKU that has no customs data is listed as unsupported; create refuses it before DHL', async () => {
  const lines = [{ id: '61', sku: 'LB-ST-DUBAI', quantity: 1, unitPrice: 300 }, { id: '62', sku: 'SMB-BERLIN', quantity: 1, unitPrice: 135 }];
  const { op, dhl, db } = await setup({ lines });
  const plan = await op({ op: 'plan', orderId: '1001' });
  const r = plan.recipients[0];
  assert.equal(r.supported, false);
  assert.equal(r.reason, 'No customs data for SKU LB-ST-DUBAI');
  assert.deepEqual(r.lines.map((l) => [l.lineItemId, l.remainingQuantity]), [['gid://shopify/LineItem/61', 1], ['gid://shopify/LineItem/62', 1]]);
  await assert.rejects(op(createBody({ lines: [{ lineItemId: '62', quantity: 1 }] })), (e) => {
    assert.equal(e.code, 'unsupported_recipient');
    assert.equal(e.status, 422);
    return true;
  });
  assert.equal(dhl.calls.length, 0);
  assert.equal(db.parcel.rows.size, 0);
});

const legacyRow = (db, tn, over = {}) => db.shipment.create({ data: {
  shop: SHOP, orderId: '1001', orderName: '#1001', recipientId: 'r1', letter: '-', name: 'Test Recipient', country: 'DE', trackingNumber: tn, fulfilled: true, ...over,
} });

test('audit duplicateOrders: a legacy batch label and a parcel label for the same recipient', async () => {
  const { op, db } = await setup();
  await op(createBody());
  const legacy = await legacyRow(db, '5550001111');
  const audit = await op({ op: 'audit' });
  assert.deepEqual(audit.duplicateOrders, [{
    orderId: '1001', recipientId: 'r1', trackingNumbers: ['900000001', '5550001111'],
    parcelIds: ['PCL-1'], legacyShipmentIds: [legacy.id], reason: 'legacy_and_parcel',
  }]);
  assert.deepEqual(Object.keys(audit), ['redacted', 'alerts', 'needsReconciliation', 'duplicateOrders']);
});

test('audit duplicateOrders: two legacy labels for one recipient', async () => {
  const { op, db } = await setup();
  const a = await legacyRow(db, '5550001111');
  const b = await legacyRow(db, '5550002222');
  const [d] = (await op({ op: 'audit' })).duplicateOrders;
  assert.equal(d.reason, 'several_legacy_labels');
  assert.deepEqual(d.legacyShipmentIds, [a.id, b.id]);
  assert.deepEqual(d.parcelIds, []);
});

test('audit duplicateOrders: separate parcels are normal; the same tracking twice counts once; late labels stay in alerts', async () => {
  const { op, db } = await setup();
  await op(createBody({ parcelId: 'PCL-A', pieces: [TWO_PIECES[0]], lines: [{ lineItemId: '11', quantity: 1 }, { lineItemId: '12', quantity: 1 }] }));
  await op(createBody({ parcelId: 'PCL-B', pieces: [TWO_PIECES[1]], lines: [{ lineItemId: '12', quantity: 1 }] }));
  assert.equal(db.shipment.rows.size, 2); // the parcels' own tracking rows (same tracking numbers)
  await db.parcel.create({ data: {
    id: 'PCL-R', shop: SHOP, orderId: '1001', recipientId: 'r1', productCode: 'P', pieces: '[]', lines: JSON.stringify([{ lineItemId: 'gid://shopify/LineItem/12', quantity: 2 }]),
    requestHash: 'x', requestJson: '{}', status: 'rejected', lateTrackingNumber: '900000099', claimedAt: new Date(),
  } });
  assert.deepEqual((await op({ op: 'audit' })).duplicateOrders, []);
});

test('audit duplicateOrders: parcels covering more of a line than the order has', async () => {
  const { op, db } = await setup();
  await op(createBody({ parcelId: 'PCL-A', lines: [{ lineItemId: '12', quantity: 2 }] }));
  await db.parcel.create({ data: {
    id: 'PCL-X', shop: SHOP, orderId: '1001', recipientId: 'r1', productCode: 'P', pieces: '[]', lines: JSON.stringify([{ lineItemId: 'gid://shopify/LineItem/12', quantity: 1 }]),
    requestHash: 'x', requestJson: '{}', status: 'label_created', trackingNumber: '900000077', claimedAt: new Date(),
  } });
  const [d] = (await op({ op: 'audit' })).duplicateOrders;
  assert.equal(d.reason, 'line_over_covered');
  assert.deepEqual(d.trackingNumbers, ['900000001', '900000077']);
  assert.deepEqual(d.parcelIds, ['PCL-A', 'PCL-X']);
});

// ---------- Duplicate audit cost: recent-only Shopify line check, bounded concurrency, cap ----------

let tnSeq = 0;
const trackedParcel = (db, orderId, id) => db.parcel.create({ data: {
  id, shop: SHOP, orderId, recipientId: 'r1', productCode: 'P', pieces: '[]',
  lines: JSON.stringify([{ lineItemId: 'gid://shopify/LineItem/1', quantity: 1 }]),
  requestHash: 'x', requestJson: '{}', status: 'fulfilled', trackingNumber: `8${String(++tnSeq).padStart(9, '0')}`, claimedAt: new Date(),
} });
const orderLookups = (shopify) => shopify.calls.filter((c) => c === 'OneOrder').length;

test('audit line check: only recipients with a parcel in the last 7 days hit Shopify; no-Shopify rules keep 90 days', async () => {
  assert.equal(svc.DUPLICATE_LINECHECK_RECENT_MS, 7 * 24 * 3600 * 1000);
  const { op, db, clock, shopify } = await setup();
  await trackedParcel(db, '3002', 'LEG-P'); // legacy + parcel, 30 days old: still reported without Shopify
  await legacyRow(db, '5550009999', { orderId: '3002' });
  clock.advance(22 * 86400);
  await trackedParcel(db, '3001', 'OLD-1'); // two parcel labels, 8 days old: not line-checked
  await trackedParcel(db, '3001', 'OLD-2');
  clock.advance(8 * 86400);
  await trackedParcel(db, '3003', 'NEW-1'); // recent: line-checked (the fake has no order 3003 → over covered)
  await trackedParcel(db, '3003', 'NEW-2');
  shopify.calls.length = 0;
  const audit = await op({ op: 'audit' });
  assert.equal(orderLookups(shopify), 1);
  assert.deepEqual(audit.duplicateOrders.map((d) => [d.orderId, d.reason]), [['3002', 'legacy_and_parcel'], ['3003', 'line_over_covered']]);
  assert.equal(audit.truncated, undefined);
});

test('audit line check: at most 4 Shopify lookups at a time, and they do run in parallel', async () => {
  assert.equal(svc.DUPLICATE_LINECHECK_CONCURRENCY, 4);
  const { op, db, shopify } = await setup();
  for (let i = 0; i < 10; i++) { await trackedParcel(db, `40${i}`, `C${i}-1`); await trackedParcel(db, `40${i}`, `C${i}-2`); }
  const real = shopify.admin.graphql;
  let inFlight = 0;
  let max = 0;
  shopify.admin.graphql = async (q, o) => {
    if (!/OneOrder/.test(q)) return real(q, o);
    inFlight++; max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    try { return await real(q, o); } finally { inFlight--; }
  };
  const audit = await op({ op: 'audit' });
  assert.equal(audit.duplicateOrders.length, 10);
  assert.equal(orderLookups(shopify), 10);
  assert.equal(max, 4);
});

test('audit line check: more than 50 recipients → the 50 most recent are checked and truncated is true', async () => {
  assert.equal(svc.DUPLICATE_LINECHECK_MAX, 50);
  const { op, db, clock, shopify } = await setup();
  for (let i = 0; i < 51; i++) {
    await trackedParcel(db, `5${String(i).padStart(3, '0')}`, `T${i}-1`);
    await trackedParcel(db, `5${String(i).padStart(3, '0')}`, `T${i}-2`);
    clock.advance(1);
  }
  shopify.calls.length = 0;
  const audit = await op({ op: 'audit' });
  assert.equal(audit.truncated, true);
  assert.equal(orderLookups(shopify), 50);
  assert.equal(audit.duplicateOrders.length, 50);
  assert.ok(!audit.duplicateOrders.some((d) => d.orderId === '5000'), 'the oldest recipient was the one left out');
});

// ---------- Stale signed creates (Operations releases a pending parcel after 7 minutes) ----------

test('route: a create signed more than 60 s ago is refused 409 stale_request before the claim; other ops keep 300 s', async () => {
  const { CREATE_MAX_AGE_SECONDS } = await import('../parcel-auth.js');
  assert.equal(CREATE_MAX_AGE_SECONDS, 60);
  const { shopify, dhl, db } = await setup();
  globalThis.__multishipTestShopify = { [SHOP]: shopify.admin };
  const at = (body, ageSeconds) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000) - ageSeconds);
    return new Request('https://multiship.example/internal/parcels', {
      method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'X-Siluet-Timestamp': ts, 'X-Siluet-Signature': signParcelRequest('k1', ts, raw) },
    });
  };
  try {
    await withRoute({ OPERATIONS_SERVICE_KEY: 'k1', PARCEL_SHOPS: SHOP }, async (route) => {
      // Live DHL settings are not configured here, so a fresh create stops at the lock (423), still before DHL.
      let res = await route.action({ request: at({ ...createBody(), shop: SHOP }, 61) });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: 'stale_request', code: 'stale_request' });
      assert.equal(dhl.calls.length, 0);
      assert.equal(db.parcel.rows.size, 0);

      res = await route.action({ request: at({ ...createBody(), shop: SHOP }, 59) });
      assert.notEqual((await res.json()).code, 'stale_request');
      assert.equal(res.status, 423); // accepted by the age check; refused only because test-mode labels are locked

      for (const body of [{ op: 'status', parcelId: 'PCL-9' }, { op: 'plan', orderId: '1001' }, { op: 'audit' }]) {
        res = await route.action({ request: at({ ...body, shop: SHOP }, 299) });
        assert.notEqual((await res.json()).code, 'stale_request', body.op);
      }
      res = await route.action({ request: at({ op: 'audit', shop: SHOP }, 301) });
      assert.equal((await res.json()).code, 'stale_request'); // the 300 s window still applies to every op (401)
      assert.equal(res.status, 401);
    });
  } finally {
    delete globalThis.__multishipTestShopify;
  }
});

test('stale create check, service side: a 59 s old create books normally, a 61 s old one is never claimed', async () => {
  const { isStaleCreate } = await import('../parcel-auth.js');
  const now = 1_800_000_000_000;
  assert.equal(isStaleCreate(String(now / 1000 - 59), now), false);
  assert.equal(isStaleCreate(String(now / 1000 - 60), now), false);
  assert.equal(isStaleCreate(String(now / 1000 - 61), now), true);
  const { op, dhl } = await setup();
  assert.equal((await op(createBody())).status, 'fulfilled'); // unlocked path unaffected
  assert.equal(dhl.calls.length, 1);
});


test('route: on an unlocked shop (dev store) a 61 s old create never reaches DHL, a 59 s old one books', async () => {
  const DEV = 'siluet-multiship-test.myshopify.com'; // the only shop isLocked() leaves unlocked in test mode
  const { shopify, db, dhl } = await setup();
  globalThis.__multishipTestShopify = { [DEV]: shopify.admin };
  // Distinct fake credentials: dhlFor() caches one client per credential set, and a client keeps the fetch it was
  // created with, so reusing the rates test's fake credentials would reuse its fake /rates endpoint.
  db.shopSetting.row = { shop: DEV, data: JSON.stringify({ dhl: { env: 'test', apiKey: 'fake-key-create', apiSecret: 'fake-secret', accountNumber: '000000001' }, sender: { phone: '+971000000000', contactName: 'Test Packer' } }) };
  const dhlRequests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/express\.api\.dhl\.com\/mydhlapi\/test\/shipments$/); // DHL test endpoint only
    const body = JSON.parse(init.body);
    dhlRequests.push(body);
    return new Response(JSON.stringify({
      shipmentTrackingNumber: '900000555',
      packages: body.content.packages.map((_, i) => ({ referenceNumber: i + 1, trackingNumber: `JD0555${i}` })),
      documents: [{ typeCode: 'label', imageFormat: 'PDF', content: dhl.label }],
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  const at = (body, ageSeconds) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000) - ageSeconds);
    return new Request('https://multiship.example/internal/parcels', {
      method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'X-Siluet-Timestamp': ts, 'X-Siluet-Signature': signParcelRequest('k1', ts, raw) },
    });
  };
  try {
    await withRoute({ OPERATIONS_SERVICE_KEY: 'k1', PARCEL_SHOPS: DEV }, async (route) => {
      let res = await route.action({ request: at({ ...createBody(), shop: DEV }, 61) });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: 'stale_request', code: 'stale_request' });
      assert.equal(dhlRequests.length, 0);
      assert.equal(db.parcel.rows.size, 0);

      res = await route.action({ request: at({ ...createBody(), shop: DEV }, 59) });
      assert.equal(res.status, 200);
      const out = await res.json();
      assert.equal(out.trackingNumber, '900000555');
      assert.equal(dhlRequests.length, 1);
      assert.equal(db.parcel.rows.size, 1);
    });
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.__multishipTestShopify;
  }
});
