// OWNER-RUN ONLY. Calls the DHL TEST API (MyDHL sandbox) once per destination to confirm the rates() response
// shape, in particular the ETA field (products[].deliveryCapabilities.estimatedDeliveryDateAndTime).
// Not run by the build or the tests. Prints no credentials.
//
// Usage (credentials from your shell, never from a file in the repo):
//   DHL_ENV=test DHL_API_KEY=... DHL_API_SECRET=... DHL_ACCOUNT=... \
//     node app/multiship/scripts/parcel-rates-sandbox.js --i-understand-this-calls-dhl
import { createDhlClient } from '../src/dhl.js';

const FLAG = '--i-understand-this-calls-dhl';
if (!process.argv.includes(FLAG)) {
  console.error(`Refusing to run: this script calls the DHL test API. Re-run with ${FLAG}.`);
  process.exit(2);
}
if (process.env.DHL_ENV !== 'test') {
  console.error('Refusing to run: set DHL_ENV=test. This script only ever talks to the DHL test endpoint.');
  process.exit(2);
}
const { DHL_API_KEY, DHL_API_SECRET, DHL_ACCOUNT } = process.env;
if (!DHL_API_KEY || !DHL_API_SECRET || !DHL_ACCOUNT) {
  console.error('Refusing to run: DHL_API_KEY, DHL_API_SECRET and DHL_ACCOUNT must be set in the environment.');
  process.exit(2);
}

let raw = null;
const dhl = createDhlClient({
  apiKey: DHL_API_KEY, apiSecret: DHL_API_SECRET, accountNumber: DHL_ACCOUNT, env: 'test',
  fetchImpl: async (url, init) => {
    const res = await fetch(url, init);
    raw = await res.clone().json().catch(() => null);
    return res;
  },
});

const pieces = [
  { weight: 1.38, length: 93, width: 15.5, height: 3 },
  { weight: 1.5, length: 47, width: 35, height: 5.5 },
];
const destinations = [
  { countryCode: 'GB', city: 'London', postalCode: 'SW1A 1AA' },
  { countryCode: 'DE', city: 'Berlin', postalCode: '10115' },
  { countryCode: 'US', city: 'New York', postalCode: '10001', provinceCode: 'NY' },
  { countryCode: 'AE', city: 'Dubai' },
];

for (const address of destinations) {
  try {
    const services = await dhl.rates({ address, parcels: pieces, declaredValue: 300, currency: 'USD' });
    console.log(`\n${address.countryCode}: ${services.length} services`);
    for (const s of services) console.log(`  ${s.productCode} ${s.name} ${s.price} ${s.currency} ETA ${s.estimatedDelivery ?? 'MISSING'}`);
    const p = raw?.products?.[0];
    if (p) console.log('  first product keys:', Object.keys(p).join(', '), '| deliveryCapabilities:', JSON.stringify(p.deliveryCapabilities));
  } catch (e) {
    console.log(`\n${address.countryCode}: FAILED ${e.message}`);
  }
}
