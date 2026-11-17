// DHL certified the shipment request data on 12 Nov 2026 and asked us to keep it. These tests pin it.
// A change to any pinned field must fail here and needs a deliberate update of this file and the fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './helpers/server-modules.js';
import { SETTINGS, DAY, CASES } from './fixtures/shipment-cases.js';

const { buildShipmentRequest } = await import('../shipments.server.js');
const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/golden-shipment-requests.json', import.meta.url))).requests;
const certifiedPaths = JSON.parse(fs.readFileSync(new URL('./fixtures/certified-key-paths.json', import.meta.url))).paths;

const build = (name, extra = {}) => buildShipmentRequest({ settings: SETTINGS, day: DAY, ...CASES[name], ...extra });

function keyPaths(o, p = '') {
  if (Array.isArray(o)) return o.flatMap((v) => keyPaths(v, `${p}[]`));
  if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => keyPaths(v, p ? `${p}.${k}` : k));
  return [p];
}
const uniq = (a) => [...new Set(a)].sort();

for (const name of Object.keys(CASES)) {
  test(`golden: legacy request for ${name} is byte-identical to main@9b3438e`, () => {
    assert.equal(JSON.stringify(build(name)), golden[name]);
  });
}

test('certified shape: SA request has exactly the key paths DHL certified (_cert/request.json)', () => {
  assert.deepEqual(uniq(keyPaths(build('multi-sa-short-address'))), certifiedPaths['request.json']);
});

test('certified shape: EU request has exactly the key paths DHL certified (_cert/eu-request.json)', () => {
  assert.deepEqual(uniq(keyPaths(build('eu-plt'))), certifiedPaths['eu-request.json']);
});

// The certified fields, extracted. Used for the explicit pins below and for the parcel path comparisons.
function pinned(r) {
  const c = r.content;
  const ed = c.exportDeclarations?.[0];
  return {
    productCode: r.productCode,
    specialServices: r.valueAddedServices || [],
    imageOptions: r.outputImageProperties.imageOptions,
    shipper: r.customerDetails.shipperDetails,
    receiver: r.customerDetails.receiverDetails,
    description: c.description,
    incoterm: c.incoterm,
    isCustomsDeclarable: c.isCustomsDeclarable,
    declaredValue: c.declaredValue,
    declaredValueCurrency: c.declaredValueCurrency,
    packages: c.packages.map((p) => ({ weight: p.weight, dimensions: p.dimensions })),
    exportDeclaration: ed && {
      exportReason: ed.exportReason, shipmentType: ed.shipmentType, incoterm: ed.incoterm, invoice: ed.invoice,
      lineItems: ed.lineItems,
    },
  };
}

const SHIPPER = {
  postalAddress: { postalCode: '00000', cityName: 'Dubai', countryCode: 'AE', addressLine1: 'Test Street 1', addressLine2: 'Test Area' },
  contactInformation: { companyName: 'Test Shipper LLC', fullName: 'Test Packer', phone: '+971000000000', email: 'shipper@example.com' },
  typeCode: 'business',
};
const LABEL = { typeCode: 'label', templateName: 'ECOM26_A6_002' };
const INVOICE = { typeCode: 'invoice', templateName: 'COMMERCIAL_INVOICE_P_10', isRequested: true, invoiceType: 'commercial' };
const CS = 'Decorative wall art, laser cut acrylic plastic, with mounting nails';
const GP = 'UV printed picture on acrylic, in MDF frame';

test('pinned: domestic single package (N, no customs, no special services, no invoice)', () => {
  assert.deepEqual(pinned(build('domestic-single-package')), {
    productCode: 'N', specialServices: [], imageOptions: [LABEL], shipper: SHIPPER,
    receiver: {
      postalAddress: { postalCode: '', cityName: 'Dubai', countryCode: 'AE', addressLine1: '1 Test Road', addressLine2: 'Business Bay' },
      contactInformation: { fullName: 'Test Recipient', companyName: 'Test Recipient', phone: '+10000000000' }, typeCode: 'private',
    },
    description: 'Wall art', incoterm: 'DAP', isCustomsDeclarable: false, declaredValue: undefined, declaredValueCurrency: undefined,
    packages: [{ weight: 1.38, dimensions: { length: 93, width: 15.5, height: 3 } }], exportDeclaration: undefined,
  });
});

test('pinned: EU paperless trade (DS + WY, invoice image, HS codes, EU identifiers, weights match parcels)', () => {
  assert.deepEqual(pinned(build('eu-plt')), {
    productCode: 'P', specialServices: [{ serviceCode: 'DS' }, { serviceCode: 'WY' }], imageOptions: [LABEL, INVOICE], shipper: SHIPPER,
    receiver: {
      postalAddress: { postalCode: '10115', cityName: 'Berlin', countryCode: 'DE', addressLine1: 'Teststrasse 1' },
      contactInformation: { fullName: 'Test Recipient', companyName: 'Test Recipient', phone: '+10000000000' }, typeCode: 'private',
    },
    description: 'Wall art', incoterm: 'DAP', isCustomsDeclarable: true, declaredValue: 300, declaredValueCurrency: 'USD',
    packages: [{ weight: 2.13, dimensions: { length: 93, width: 15.5, height: 6 } }],
    exportDeclaration: {
      exportReason: 'Sale', shipmentType: 'personal', incoterm: 'DAP', invoice: { number: '9002-A', date: DAY },
      lineItems: [
        { number: 1, description: CS, price: 135, quantity: { value: 1, unitOfMeasurement: 'PCS' },
          commodityCodes: [{ typeCode: 'outbound', value: '3926400000' }, { typeCode: 'inbound', value: '3926400000' }],
          exportReasonType: 'permanent', manufacturerCountry: 'AE', weight: { netValue: 0.675, grossValue: 0.75 },
          customerReferences: [{ typeCode: 'ABW', value: 'SMB-BERLIN' }, { typeCode: 'MF', value: 'SMB-BERLIN' }, { typeCode: 'SRV', value: '0000000000017' }] },
        { number: 2, description: CS, price: 165, quantity: { value: 1, unitOfMeasurement: 'PCS' },
          commodityCodes: [{ typeCode: 'outbound', value: '3926400000' }, { typeCode: 'inbound', value: '3926400000' }],
          exportReasonType: 'permanent', manufacturerCountry: 'AE', weight: { netValue: 1.242, grossValue: 1.38 },
          customerReferences: [{ typeCode: 'ABW', value: 'MGD-PARIS' }, { typeCode: 'MF', value: 'MGD-PARIS' }] },
      ],
    },
  });
});

test('pinned: non-PLT international (DS only, no WY, invoice image requested)', () => {
  assert.deepEqual(pinned(build('non-plt-international')), {
    productCode: 'P', specialServices: [{ serviceCode: 'DS' }], imageOptions: [LABEL, INVOICE], shipper: SHIPPER,
    receiver: {
      postalAddress: { postalCode: '34000', cityName: 'Istanbul', countryCode: 'TR', addressLine1: 'Test Sokak 1' },
      contactInformation: { fullName: 'Test Recipient', companyName: 'Test Recipient', phone: '+10000000000' }, typeCode: 'private',
    },
    description: 'Wall art', incoterm: 'DAP', isCustomsDeclarable: true, declaredValue: 240, declaredValueCurrency: 'USD',
    packages: [{ weight: 3, dimensions: { length: 47, width: 35, height: 11 } }],
    exportDeclaration: {
      exportReason: 'Sale', shipmentType: 'personal', incoterm: 'DAP', invoice: { number: '9003-A', date: DAY },
      lineItems: [
        { number: 1, description: GP, price: 120, quantity: { value: 2, unitOfMeasurement: 'PCS' },
          commodityCodes: [{ typeCode: 'outbound', value: '4911910000' }, { typeCode: 'inbound', value: '4911910000' }],
          exportReasonType: 'permanent', manufacturerCountry: 'AE', weight: { netValue: 2.7, grossValue: 3 } },
      ],
    },
  });
});

test('pinned: DDP sends DD (not DS) and the destination import code', () => {
  const p = pinned(build('us-ddp'));
  assert.deepEqual(p.specialServices, [{ serviceCode: 'DD' }, { serviceCode: 'WY' }]);
  assert.equal(p.incoterm, 'DDP');
  assert.deepEqual(p.exportDeclaration.lineItems[0].commodityCodes, [{ typeCode: 'outbound', value: '3926400000' }, { typeCode: 'inbound', value: '3926400090' }]);
});

test('pinned: PLT value ceiling drops WY (Kuwait above 325 USD)', () => {
  assert.deepEqual(pinned(build('kw-over-plt-limit')).specialServices, [{ serviceCode: 'DS' }]);
});

test('pinned: Saudi short address goes in address line 3', () => {
  assert.deepEqual(pinned(build('multi-sa-short-address')).receiver.postalAddress,
    { postalCode: '12211', cityName: 'Riyadh', countryCode: 'SA', addressLine1: 'Test Street 2', addressLine2: 'Test District', addressLine3: 'ABCD1234' });
});

// ---------- Parcel path: explicit pieces, parcel reference, invoice flag ----------

const PIECES = [
  { weight: 1.2, length: 93, width: 15.5, height: 4 },
  { weight: 0.9, length: 63, width: 14, height: 3 },
];

test('multiPieceCustomsDeclarationWeightsMatchPieces', () => {
  const r = build('eu-plt', { pieces: PIECES, customerReference: 'PCL-1', invoiceImage: false });
  assert.equal(r.content.packages.length, 2);
  assert.deepEqual(r.content.packages.map((p) => p.weight), [1.2, 0.9]);
  assert.deepEqual(r.content.packages.map((p) => p.dimensions), PIECES.map(({ length, width, height }) => ({ length, width, height })));
  const gross = r.content.exportDeclarations[0].lineItems.reduce((t, l) => t + l.weight.grossValue, 0);
  assert.equal(Math.round(gross * 1000) / 1000, 2.1);
});

test('customer references: shipment = parcelId, packages = parcelId-1..N (parcel path only)', () => {
  const r = build('non-plt-international', { pieces: PIECES, customerReference: 'PCL-7', invoiceImage: true });
  assert.deepEqual(r.customerReferences, [{ value: 'PCL-7', typeCode: 'CU' }]);
  assert.deepEqual(r.content.packages.map((p) => p.customerReferences), [[{ value: 'PCL-7-1', typeCode: 'CU' }], [{ value: 'PCL-7-2', typeCode: 'CU' }]]);
});

test('pltRequestedWhenAllowed: WY, electronic export declaration, no invoice image option', () => {
  const r = build('eu-plt', { pieces: PIECES, customerReference: 'PCL-1', invoiceImage: false });
  assert.ok(r.valueAddedServices.some((v) => v.serviceCode === 'WY'));
  assert.equal(r.content.exportDeclarations.length, 1);
  assert.deepEqual(r.outputImageProperties.imageOptions, [LABEL]);
});

test('parcel path keeps every other certified field of the legacy request', () => {
  for (const name of ['eu-plt', 'non-plt-international', 'domestic-single-package']) {
    const legacy = pinned(build(name));
    const parcel = pinned(build(name, { pieces: PIECES, customerReference: 'PCL-1', invoiceImage: name === 'non-plt-international' }));
    for (const k of ['productCode', 'specialServices', 'shipper', 'receiver', 'description', 'incoterm', 'isCustomsDeclarable', 'declaredValue', 'declaredValueCurrency']) {
      assert.deepEqual(parcel[k], legacy[k], `${name}: ${k}`);
    }
    if (legacy.exportDeclaration) {
      // Parcel path changes the line weights (scaled to the pieces) and the invoice number (parcelId), nothing else.
      const strip = (ed) => ({ ...ed, invoice: { date: ed.invoice.date }, lineItems: ed.lineItems.map(({ weight, ...l }) => l) });
      assert.deepEqual(strip(parcel.exportDeclaration), strip(legacy.exportDeclaration), `${name}: exportDeclaration`);
      assert.equal(parcel.exportDeclaration.invoice.number, 'PCL-1');
    }
  }
});

// ---------- Line weights scaled to the packed pieces (parcel path only) ----------

const { lineWeightsForPieces } = await import('../shipments.server.js');
const grossOf = (r) => r.content.exportDeclarations[0].lineItems.map((l) => l.weight.grossValue);
const grams = (kgs) => kgs.reduce((t, w) => t + Math.round(w * 1000), 0);

test('line weights: pieces much lighter than the declared items still add up exactly, no line below 0.001 kg', () => {
  const r = build('eu-plt', { pieces: [{ weight: 0.3, length: 93, width: 15.5, height: 6 }], customerReference: 'PCL-1', invoiceImage: false });
  const g = grossOf(r);
  assert.equal(grams(g), 300);
  assert.ok(g.every((w) => w >= 0.001));
  assert.deepEqual(g, [0.105, 0.195]); // proportional to 0.75 : 1.38, last line absorbs rounding
  assert.ok(r.content.exportDeclarations[0].lineItems.every((l) => l.weight.netValue <= l.weight.grossValue && l.weight.netValue >= 0.001));
});

test('line weights: pieces heavier than the declared items are spread proportionally', () => {
  const g = grossOf(build('eu-plt', { pieces: [{ weight: 4, length: 93, width: 15.5, height: 6 }, { weight: 2.39, length: 60, width: 40, height: 10 }], customerReference: 'PCL-1', invoiceImage: false }));
  assert.equal(grams(g), 6390);
  assert.ok(Math.abs(g[0] / g[1] - 0.75 / 1.38) < 0.01);
});

test('line weights: single line takes the whole pieces weight', () => {
  const g = grossOf(build('non-plt-international', { pieces: [{ weight: 0.5, length: 47, width: 35, height: 11 }], customerReference: 'PCL-1', invoiceImage: true }));
  assert.deepEqual(g, [0.5]);
});

test('line weights: many lines, tiny pieces: exact total and the DHL minimum; impossible totals are refused', () => {
  const declared = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? 2.1 : 0.75));
  const out = lineWeightsForPieces(declared, 0.05);
  assert.equal(out.length, 40);
  assert.equal(grams(out), 50);
  assert.ok(out.every((w) => w >= 0.001));
  assert.deepEqual(lineWeightsForPieces([1, 1, 1], 0.003), [0.001, 0.001, 0.001]);
  assert.throws(() => lineWeightsForPieces([1, 1, 1], 0.002), (e) => e.code === 'PIECES_TOO_LIGHT');
});
