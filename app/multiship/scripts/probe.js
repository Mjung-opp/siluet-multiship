// Probe the DHL sandbox and print response shapes (no secrets printed).
const { DHL_API_KEY, DHL_API_SECRET, DHL_ACCOUNT, DHL_ENV } = process.env;
const base = DHL_ENV === 'live' ? 'https://express.api.dhl.com/mydhlapi' : 'https://express.api.dhl.com/mydhlapi/test';
const auth = 'Basic ' + Buffer.from(`${DHL_API_KEY}:${DHL_API_SECRET}`).toString('base64');
const d = new Date(Date.now() + 86400000 * 2);
const planned = d.toISOString().slice(0, 10) + 'T13:00:00GMT+04:00';

async function post(path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const common = {
  customerDetails: {
    shipperDetails: { postalCode: '00000', cityName: 'Dubai', countryCode: 'AE' },
    receiverDetails: { postalCode: 'SW1A 1AA', cityName: 'London', countryCode: 'GB' },
  },
  accounts: [{ typeCode: 'shipper', number: DHL_ACCOUNT }],
  unitOfMeasurement: 'metric',
  packages: [{ weight: 2.1, dimensions: { length: 122, width: 19.5, height: 3 } }],
};

for (const dd of [false, true]) {
  const r = await post('/rates', {
    ...common, plannedShippingDateAndTime: planned, productCode: 'P', isCustomsDeclarable: true,
    monetaryAmount: [{ typeCode: 'declaredValue', value: 900, currency: 'AED' }],
    ...(dd ? { valueAddedServices: [{ serviceCode: 'DD' }] } : {}), nextBusinessDay: true,
  });
  console.log(`RATES dd=${dd} status=${r.status}`);
  if (r.status !== 200) { console.log(JSON.stringify(r.json).slice(0, 800)); continue; }
  for (const p of r.json.products || []) {
    console.log(' ', p.productCode, p.productName, JSON.stringify(p.totalPrice));
    if (dd) console.log('  breakdown', JSON.stringify(p.detailedPriceBreakdown).slice(0, 900));
  }
}

const lc = await post('/landed-cost', {
  ...common, productCode: 'P', localProductCode: 'P', currencyCode: 'AED', isCustomsDeclarable: true,
  isDTPRequested: true, isInsuranceRequested: false, getCostBreakdown: true, shipmentPurpose: 'personal',
  transportationMode: 'air', merchantSelectedCarrierName: 'DHL',
  items: [{ number: 1, name: 'City Silhouette Large', description: 'Decorative wall art, laser cut acrylic plastic, with mounting nails',
    manufacturerCountry: 'AE', partNumber: 'CS-L-MB', quantity: 1, quantityType: 'prt', unitPrice: 900, unitPriceCurrencyCode: 'AED',
    commodityCode: '3926400000', weight: 2.1, weightUnitOfMeasurement: 'metric', estimatedTariffRateType: 'default_rate' }],
});
console.log(`LANDED COST status=${lc.status}`);
console.log(JSON.stringify(lc.json).slice(0, 2500));
