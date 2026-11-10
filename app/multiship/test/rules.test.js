import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildParcels } from '../src/parcels.js';
import { pickFreeRecipient, roundUp } from '../src/allocate.js';
import { quoteMultiship, shippingTotal } from '../src/quote.js';
import { nextDispatch, dhlDate, parseLandedCost } from '../src/dhl.js';

test('parcels: 1 Small is the Small 1 preset', () => {
  assert.deepEqual(buildParcels([{ sku: 'CS-S-MB-PARIS', quantity: 1 }]).map(strip), [
    { length: 63, width: 14, height: 3, weight: 0.75 },
  ]);
});

test('parcels: Small + Large uses the Large footprint for 2 items', () => {
  const [p] = buildParcels([{ sku: 'CS-S-MB-PARIS', quantity: 1 }, { sku: 'CS-L-GD-DUBAI', quantity: 1 }]);
  assert.deepEqual(strip(p), { length: 122, width: 19.5, height: 6, weight: 2.85 });
});

test('parcels: 5 Silhouettes grow 3cm per item in one custom parcel', () => {
  const parcels = buildParcels([{ sku: 'CS-M-SL-NYC', quantity: 5 }]);
  assert.equal(parcels.length, 1);
  assert.equal(parcels[0].height, 15);
});

test('parcels: 4 Tracks split into 3 + 1, never blocked', () => {
  const parcels = buildParcels([{ sku: 'GP-3040-BK-LONDON', quantity: 4 }]);
  assert.deepEqual(parcels.map((p) => p.contents.length), [3, 1]);
});

test('parcels: City Lights is rejected', () => {
  assert.throws(() => buildParcels([{ sku: 'LB-ST-X', quantity: 1 }]), /City Lights/);
});

test('free rule: different counts, most items wins even if dearer', () => {
  assert.equal(pickFreeRecipient([
    { id: 'a', itemCount: 1, dhlCost: 100 },
    { id: 'b', itemCount: 3, dhlCost: 400 },
  ]), 'b');
});

test('free rule: same counts, cheapest wins', () => {
  assert.equal(pickFreeRecipient([
    { id: 'a', itemCount: 2, dhlCost: 300 },
    { id: 'b', itemCount: 2, dhlCost: 180 },
    { id: 'c', itemCount: 2, dhlCost: 250 },
  ]), 'b');
});

test('free rule: tie on most items goes to lowest DHL cost', () => {
  assert.equal(pickFreeRecipient([
    { id: 'a', itemCount: 3, dhlCost: 500 },
    { id: 'b', itemCount: 3, dhlCost: 320 },
    { id: 'c', itemCount: 1, dhlCost: 90 },
  ]), 'b');
});

test('rounding: up to the next 5', () => {
  assert.equal(roundUp(31.2), 35);
  assert.equal(roundUp(35), 35);
  assert.equal(roundUp(35.01), 40);
  assert.equal(roundUp(0.01), 5);
});

test('dates: next working day 13:00 Dubai, skipping the weekend', () => {
  const friday = new Date('2026-11-13T10:00:00Z');
  assert.equal(dhlDate(nextDispatch(friday)), '2026-11-16T13:00:00GMT+04:00');
});

test('landed cost parsing uses DHL totals plus the DD fee (sandbox shape)', () => {
  const r = parseLandedCost({ products: [{ detailedPriceBreakdown: [{ priceCurrency: 'AED', breakdown: [
    { name: 'SCUSV', price: 900 }, { name: 'FUEL SURCHARGE', serviceCode: 'FF', price: 61.7 },
    { name: 'Duty Tax Paid', serviceCode: 'DD', price: 16 },
    { name: 'TOTAL DUTIES', price: 24.21 }, { name: 'TOTAL TAXES', price: 205.3 }, { name: 'TOTAL FEES', price: 0 },
  ] }] }] }, 'AED');
  assert.equal(r.amount, 245.51);
  assert.equal(r.ddFee, 16);
});

// End to end with a fake DHL
function fakeDhl(costs, { duties = 40, ddFee = 45 } = {}) {
  return {
    async rate({ address }) {
      const domestic = address.countryCode === 'AE';
      return { productCode: domestic ? 'N' : 'P', price: costs[address.city], currency: 'AED', domestic };
    },
    async dutiesAndTaxes() { return { duties, taxes: 0, fees: 0, ddFee, amount: duties + ddFee, currency: 'AED' }; },
  };
}

test('quote: most items free, others paid and rounded in customer currency', async () => {
  const result = await quoteMultiship({
    shopCurrency: 'AED',
    presentment: { currency: 'USD', rate: 0.2723 },
    recipients: [
      { id: 'mum', address: { countryCode: 'GB', city: 'London' }, lines: [{ sku: 'CS-L-MB-LONDON', quantity: 1, unitPrice: 900 }] },
      { id: 'me', address: { countryCode: 'US', city: 'Boston' }, lines: [{ sku: 'CS-S-MB-NYC', quantity: 2, unitPrice: 450 }] },
      { id: 'sis', address: { countryCode: 'AE', city: 'Dubai' }, lines: [{ sku: 'GP-3040-BK-DXB', quantity: 1, unitPrice: 600 }] },
    ],
  }, fakeDhl({ London: 210, Boston: 260, Dubai: 35 }));

  assert.equal(result.freeRecipientId, 'me');
  const by = Object.fromEntries(result.quotes.map((q) => [q.id, q]));
  assert.deepEqual(by.me.shipping, { label: 'Free Standard Shipping', amount: 0, currency: 'USD' });
  assert.equal(by.mum.shipping.amount, 60);            // 210 AED * 0.2723 = 57.18 -> 60
  assert.equal(by.sis.shipping.label, 'DHL Express Domestic');
  assert.equal(by.sis.shipping.amount, 10);            // 35 * 0.2723 = 9.53 -> 10
  assert.equal(by.sis.ddp, null);                      // no DDP inside the UAE
  assert.equal(by.me.ddp.amount, 23.15);               // (40 + 45) * 0.2723
  assert.equal(shippingTotal(result, { me: true }), 93.15);
});

test('quote: single address is refused (normal checkout handles it)', async () => {
  await assert.rejects(quoteMultiship({ shopCurrency: 'AED', presentment: { currency: 'AED', rate: 1 }, recipients: [
    { id: 'a', address: { countryCode: 'GB', city: 'London' }, lines: [{ sku: 'CS-S-MB-X', quantity: 1, unitPrice: 1 }] },
  ] }, fakeDhl({})), /at least 2/);
});

test('sku: live Shopify SKUs map to the right box', async () => {
  const { itemKeyFromSku } = await import('../src/config.js');
  assert.equal(itemKeyFromSku('LMB-ABU DHABI-Y'), 'CS-L');
  assert.equal(itemKeyFromSku('SGD-PARIS'), 'CS-S');
  assert.equal(itemKeyFromSku('MSL-RIYADH'), 'CS-M');
  assert.equal(itemKeyFromSku('GPAUH3040LB'), 'GP');
  assert.equal(itemKeyFromSku('GPBAH3042LW'), 'GP');
  assert.throws(() => itemKeyFromSku('XYZ'), /Unknown SKU/);
});

function strip({ contents, ...p }) { return p; }

test('quote: DHL bills AED, live shop is USD, converted before rounding', async () => {
  const result = await quoteMultiship({
    shopCurrency: 'USD',
    presentment: { currency: 'GBP', rate: 0.78 },
    dhlFx: { 'AED->USD': 0.2723 },
    recipients: [
      { id: 'a', address: { countryCode: 'GB', city: 'London' }, lines: [{ sku: 'CS-M-MB-LONDON', quantity: 1, unitPrice: 250 }] },
      { id: 'b', address: { countryCode: 'US', city: 'Boston' }, lines: [{ sku: 'CS-M-MB-NYC', quantity: 2, unitPrice: 250 }] },
    ],
  }, fakeDhl({ London: 210, Boston: 260 }));
  const a = result.quotes.find((q) => q.id === 'a');
  assert.equal(result.freeRecipientId, 'b');
  assert.equal(a.internal.dhlCost, 57.18);   // 210 AED -> 57.18 USD
  assert.equal(a.shipping.amount, 45);       // 57.18 * 0.78 = 44.60 GBP -> 45
});
