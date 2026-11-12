import { SHIPPER, DHL_PRODUCTS, DDP_SERVICE_CODE, ITEMS, itemKeyFromSku } from './config.js';

// MyDHL API (REST). Docs: https://developer.dhl.com/api-reference/dhl-express-mydhl-api
// Response field names below follow MyDHL API v2. VERIFY against the sandbox before go live
// (run `npm run quote:sandbox`).

const BASE = {
  test: 'https://express.api.dhl.com/mydhlapi/test',
  live: 'https://express.api.dhl.com/mydhlapi',
};

export function createDhlClient({ apiKey, apiSecret, accountNumber, env = 'test', fetchImpl = fetch, now = () => new Date() }) {
  if (!apiKey || !apiSecret || !accountNumber) throw new Error('DHL credentials missing');
  const auth = 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const base = BASE[env];

  async function post(path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const extra = Array.isArray(json.additionalDetails) ? ` (${json.additionalDetails.join('; ')})` : '';
      const err = new Error(`DHL ${path} ${res.status}: ${json.detail || json.title || 'request failed'}${extra}`);
      err.dhl = json;
      throw err;
    }
    return json;
  }

  function common(address, parcels) {
    const domestic = address.countryCode === SHIPPER.countryCode;
    return {
      domestic,
      productCode: domestic ? DHL_PRODUCTS.domestic : DHL_PRODUCTS.international,
      body: {
        customerDetails: {
          shipperDetails: { ...SHIPPER },
          receiverDetails: {
            countryCode: address.countryCode,
            cityName: address.city,
            postalCode: address.postalCode || '',
            ...(address.provinceCode ? { provinceCode: address.provinceCode } : {}),
          },
        },
        accounts: [{ typeCode: 'shipper', number: accountNumber }],
        unitOfMeasurement: 'metric',
        packages: parcels.map((p) => ({
          weight: p.weight,
          dimensions: { length: p.length, width: p.width, height: p.height },
        })),
      },
    };
  }

  /** Express Worldwide (or Domestic) price for this recipient, optionally with the DDP (DD) service. */
  async function rate({ address, parcels, declaredValue, currency, ddp = false }) {
    const { domestic, productCode, body } = common(address, parcels);
    const res = await post('/rates', {
      ...body,
      plannedShippingDateAndTime: dhlDate(nextDispatch(now())),
      productCode,
      isCustomsDeclarable: !domestic,
      ...(domestic ? {} : { monetaryAmount: [{ typeCode: 'declaredValue', value: declaredValue, currency }] }),
      ...(ddp && !domestic ? { valueAddedServices: [{ serviceCode: DDP_SERVICE_CODE }] } : {}),
      nextBusinessDay: true,
    });
    const product = (res.products || []).find((p) => p.productCode === productCode);
    if (!product) {
      const e = new Error(`DHL has no ${productCode} service to ${address.countryCode}`);
      e.code = 'NO_SERVICE';
      throw e;
    }
    const price = pickPrice(product.totalPrice);
    return { productCode, price: price.price, currency: price.priceCurrency, domestic };
  }

  /** Estimated duties and taxes for the destination (DHL Landed Cost). */
  async function dutiesAndTaxes({ address, parcels, lines, currency }) {
    const { productCode, body } = common(address, parcels);
    const res = await post('/landed-cost', {
      ...body,
      productCode,
      localProductCode: productCode,
      currencyCode: currency,
      isCustomsDeclarable: true,
      isDTPRequested: true,
      isInsuranceRequested: false,
      getCostBreakdown: true,
      shipmentPurpose: 'personal',
      transportationMode: 'air',
      merchantSelectedCarrierName: 'DHL',
      items: lines.map((l, i) => {
        const item = ITEMS[itemKeyFromSku(l.sku)];
        return {
          number: i + 1,
          name: l.title || l.sku,
          description: item.line === 'CS'
            ? 'Decorative wall art, laser cut acrylic plastic, with mounting nails'
            : 'UV printed picture on acrylic, in MDF frame',
          manufacturerCountry: 'AE',
          partNumber: l.sku,
          quantity: l.quantity,
          quantityType: 'prt',
          unitPrice: l.unitPrice,
          unitPriceCurrencyCode: currency,
          commodityCode: item.importCodes?.[address.countryCode] || item.hsCode, // destination import code where we have one (US HTS)
          weight: item.declaredWeightKg,
          weightUnitOfMeasurement: 'metric',
          estimatedTariffRateType: 'default_rate',
        };
      }),
    });
    return parseLandedCost(res, currency);
  }

  /** Create a shipment and label (POST /shipments). Returns DHL's response as is. */
  async function createShipment(body) {
    return post('/shipments', body);
  }

  /** Book a courier pickup (POST /pickups). */
  async function createPickup(body) {
    return post('/pickups', body);
  }

  /** Cancel a booked pickup (DELETE /pickups/{confirmation}). */
  async function cancelPickup(confirmation, requestorName, reason = 'not needed') {
    const q = new URLSearchParams({ requestorName, reason });
    const res = await fetchImpl(`${base}/pickups/${encodeURIComponent(confirmation)}?${q}`, { method: 'DELETE', headers: { Authorization: auth, Accept: 'application/json' } });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const err = new Error(`DHL cancel pickup ${res.status}: ${json.detail || json.title || 'request failed'}`);
      err.dhl = json;
      throw err;
    }
    return true;
  }

  /** All checkpoints for one shipment (GET /tracking). */
  async function track(trackingNumber) {
    const q = new URLSearchParams({ shipmentTrackingNumber: trackingNumber, trackingView: 'all-checkpoints', levelOfDetail: 'all' });
    const res = await fetchImpl(`${base}/tracking?${q}`, { headers: { Authorization: auth, Accept: 'application/json' } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`DHL /tracking ${res.status}: ${json.detail || json.title || 'request failed'}`);
      err.dhl = json;
      throw err;
    }
    return json;
  }

  return { rate, dutiesAndTaxes, createShipment, createPickup, cancelPickup, track };
}

// BILLC = billing currency of the DHL account. Fall back to the first price.
export function pickPrice(totalPrice = []) {
  return totalPrice.find((p) => p.currencyType === 'BILLC' && p.price != null)
    || totalPrice.find((p) => p.price != null)
    || (() => { throw new Error('DHL returned no price'); })();
}

// Landed cost response (verified in the DHL sandbox, 10 Nov 2026):
// products[0].detailedPriceBreakdown[0].breakdown has lines named
// "TOTAL DUTIES", "TOTAL TAXES", "TOTAL FEES", plus the DHL duty paid fee as serviceCode "DD".
export function parseLandedCost(res, currency) {
  const product = (res.products || [])[0];
  const block = product?.detailedPriceBreakdown?.find((b) => b.priceCurrency === currency)
    || product?.detailedPriceBreakdown?.[0];
  if (!block) throw new Error('DHL landed cost returned no breakdown');
  const line = (name) => Number(block.breakdown.find((b) => b.name?.toUpperCase() === name)?.price || 0);
  const duties = line('TOTAL DUTIES');
  const taxes = line('TOTAL TAXES');
  const fees = line('TOTAL FEES');
  const ddFee = Number(block.breakdown.find((b) => b.serviceCode === 'DD')?.price || 0);
  return {
    duties, taxes, fees, ddFee,
    amount: round2(duties + taxes + fees + ddFee),
    currency: block.priceCurrency || currency,
  };
}

// Orders leave within 2 working days; quote for the next working day at 13:00 Dubai time.
// UAE weekend is Saturday and Sunday.
export function nextDispatch(from) {
  const d = new Date(from.getTime());
  do { d.setUTCDate(d.getUTCDate() + 1); } while ([0, 6].includes(d.getUTCDay()));
  d.setUTCHours(9, 0, 0, 0); // 13:00 GST
  return d;
}

export function dhlDate(d) {
  // MyDHL format: 2026-11-10T13:00:00GMT+04:00
  const local = new Date(d.getTime() + 4 * 3600 * 1000);
  return local.toISOString().slice(0, 19) + 'GMT+04:00';
}

const round2 = (n) => Math.round(n * 100) / 100;
