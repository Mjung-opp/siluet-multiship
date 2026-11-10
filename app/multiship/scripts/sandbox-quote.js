// Run a real quote against the DHL sandbox to verify request and response shapes.
// Usage: DHL_API_KEY=... DHL_API_SECRET=... DHL_ACCOUNT=... npm run quote:sandbox
import { createDhlClient } from '../src/dhl.js';
import { quoteMultiship } from '../src/quote.js';

const dhl = createDhlClient({
  apiKey: process.env.DHL_API_KEY,
  apiSecret: process.env.DHL_API_SECRET,
  accountNumber: process.env.DHL_ACCOUNT,
  env: process.env.DHL_ENV || 'test',
});

const result = await quoteMultiship({
  shopCurrency: 'USD',
  dhlCurrency: 'AED',
  dhlFx: { 'AED->USD': 0.2723 }, // AED is pegged: 1 USD = 3.6725 AED
  presentment: { currency: 'USD', rate: 1 },
  recipients: [
    { id: 'uk', address: { countryCode: 'GB', city: 'London', postalCode: 'SW1A 1AA' }, lines: [{ sku: 'CS-L-MB-LONDON', quantity: 1, unitPrice: 245 }] },
    { id: 'us', address: { countryCode: 'US', city: 'New York', postalCode: '10001', provinceCode: 'NY' }, lines: [{ sku: 'CS-S-MB-NYC', quantity: 2, unitPrice: 125 }] },
    { id: 'ae', address: { countryCode: 'AE', city: 'Dubai' }, lines: [{ sku: 'GP-3040-BK-DXB', quantity: 4, unitPrice: 165 }] },
  ],
}, dhl);

for (const q of result.quotes) {
  console.log(`${q.id}: ${q.itemCount} items | ${q.shipping.label} ${q.shipping.amount} ${q.shipping.currency} | DHL cost ${q.internal.dhlCost} USD | parcels ${q.internal.parcels.map((p) => `${p.length}x${p.width}x${p.height}cm ${p.weight}kg`).join(' + ')} | DDP ${q.ddp ? (q.ddp.available ? q.ddp.amount : 'unavailable') : 'n/a'}`);
}
console.log('free:', result.freeRecipientId);
