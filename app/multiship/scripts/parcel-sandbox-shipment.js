// OWNER-RUN ONLY. Books ONE two-piece international TEST shipment on the DHL TEST endpoint (MyDHL sandbox)
// to a Paperless Trade country, with the request built by the certified builder (buildShipmentRequest) the
// way the parcel service builds it. Records what DHL accepted (plan T6b sandbox evidence).
// Not run by the build or the tests. Prints no credentials. Uses a synthetic test recipient.
//
// Usage (credentials from your shell, never from a file in the repo):
//   DHL_ENV=test DHL_API_KEY=... DHL_API_SECRET=... DHL_ACCOUNT=... SHIPPER_PHONE=... SHIPPER_CONTACT_NAME=... \
//     node app/multiship/scripts/parcel-sandbox-shipment.js --i-understand-this-calls-dhl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FLAG = '--i-understand-this-calls-dhl';
if (!process.argv.includes(FLAG)) {
  console.error(`Refusing to run: this script books a shipment on the DHL test API. Re-run with ${FLAG}.`);
  process.exit(2);
}
if (process.env.DHL_ENV !== 'test') {
  console.error('Refusing to run: set DHL_ENV=test. This script only ever talks to the DHL test endpoint.');
  process.exit(2);
}
const { DHL_API_KEY, DHL_API_SECRET, DHL_ACCOUNT, SHIPPER_PHONE, SHIPPER_CONTACT_NAME } = process.env;
if (!DHL_API_KEY || !DHL_API_SECRET || !DHL_ACCOUNT || !SHIPPER_PHONE || !SHIPPER_CONTACT_NAME) {
  console.error('Refusing to run: DHL_API_KEY, DHL_API_SECRET, DHL_ACCOUNT, SHIPPER_PHONE and SHIPPER_CONTACT_NAME must be set.');
  process.exit(2);
}

// The shipment code imports the app database module; this script needs no database, so it is stubbed
// exactly as in the tests. Imported only after the checks above.
await import('../test/helpers/server-modules.js');
const { buildShipmentRequest, customsMode } = await import('../shipments.server.js');
const { DEFAULTS, pickupDay } = await import('../settings.server.js');
const { createDhlClient, SHIPMENT_TIMEOUT_MS } = await import('../src/dhl.js');
const { buildParcels } = await import('../src/parcels.js');

const settings = { ...structuredClone(DEFAULTS), dhl: { env: 'test', apiKey: DHL_API_KEY, apiSecret: DHL_API_SECRET, accountNumber: DHL_ACCOUNT } };
const lines = [
  { sku: 'MMB-LONDON', title: 'City Silhouette M (sandbox)', quantity: 1, barcode: '', unitPrice: 165 },
  { sku: 'GPLON3040LB', title: 'City Tracks (sandbox)', quantity: 1, barcode: '', unitPrice: 120 },
];
// Synthetic recipient: DHL sandbox only (UK test phone range).
const recipient = { id: 'r1', address: { name: 'Sandbox Test Recipient', phone: '+447700900000', address1: '1 Test Street', address2: '', city: 'London', provinceCode: '', zip: 'SW1A 1AA', countryCode: 'GB' }, lines };
const plan = {
  type: 'single', recipients: [recipient], shopCurrency: 'USD', ddpChoices: { r1: false },
  quotes: { r1: { id: 'r1', ddp: { available: true }, internal: { productCode: 'P', parcels: buildParcels(lines) } } },
};
const pieces = [
  { weight: 1.38, length: 93, width: 15.5, height: 3 },
  { weight: 1.5, length: 47, width: 35, height: 5.5 },
];
const parcelId = `SBX-${Date.now().toString(36).toUpperCase()}`;
const { plt } = customsMode({ plan, recipient });
if (!plt) {
  console.error('Refusing to run: the sandbox destination must accept Paperless Trade.');
  process.exit(2);
}
const body = buildShipmentRequest({ settings, orderName: '#SANDBOX', plan, recipient, letter: 'A', day: pickupDay(), pieces, customerReference: parcelId, invoiceImage: !plt });

console.log('parcelId', parcelId);
console.log('request: packages', body.content.packages.length, '| references', JSON.stringify(body.customerReferences), JSON.stringify(body.content.packages.map((p) => p.customerReferences[0].value)));
console.log('request: special services', JSON.stringify(body.valueAddedServices), '| image options', JSON.stringify(body.outputImageProperties.imageOptions.map((o) => o.typeCode)));
console.log('request: line gross weights', JSON.stringify(body.content.exportDeclarations[0].lineItems.map((l) => l.weight.grossValue)), '| piece weights', JSON.stringify(pieces.map((p) => p.weight)));

const dhl = createDhlClient({ apiKey: DHL_API_KEY, apiSecret: DHL_API_SECRET, accountNumber: DHL_ACCOUNT, env: 'test' });
try {
  const res = await dhl.createShipment(body, { timeoutMs: SHIPMENT_TIMEOUT_MS });
  console.log('DHL accepted. tracking', res.shipmentTrackingNumber, '| pieces', JSON.stringify((res.packages || []).map((p) => p.trackingNumber)));
  console.log('documents', JSON.stringify((res.documents || []).map((d) => d.typeCode)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siluet-parcel-sandbox-'));
  for (const d of res.documents || []) {
    const f = path.join(dir, `${parcelId}-${d.typeCode}.pdf`);
    fs.writeFileSync(f, Buffer.from(d.content, 'base64'));
    console.log('saved', f);
  }
} catch (e) {
  console.error('DHL refused:', e.message, e.dhl ? JSON.stringify(e.dhl).slice(0, 1500) : '');
  process.exit(1);
}
