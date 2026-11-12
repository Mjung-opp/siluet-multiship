// Siluet shipping configuration.
// Source: "Product packaging dimensions" sheet (confirmed 2026-10-13) and Mariana's rules (2026-11-09).
// VERIFY every value against the DHL Express Commerce presets (Settings > Packaging) before go live.

export const SHIPPER = {
  countryCode: 'AE',
  cityName: 'Dubai',
  postalCode: '00000', // UAE has no postcodes; DHL accepts a placeholder. Confirm with account.
};

// One entry per sellable box. dims in cm, declaredWeightKg = product + box.
export const ITEMS = {
  'CS-S': { line: 'CS', rank: 1, length: 63, width: 14, height: 3, declaredWeightKg: 0.75, hsCode: '3926400000', importCodes: { US: '3926400090' } },
  'CS-M': { line: 'CS', rank: 2, length: 93, width: 15.5, height: 3, declaredWeightKg: 1.38, hsCode: '3926400000', importCodes: { US: '3926400090' } },
  'CS-L': { line: 'CS', rank: 3, length: 122, width: 19.5, height: 3, declaredWeightKg: 2.1, hsCode: '3926400000', importCodes: { US: '3926400090' } },
  'GP':   { line: 'GP', rank: 1, length: 47, width: 35, height: 5.5, declaredWeightKg: 1.5, hsCode: '4911910000', importCodes: { US: '4911914040' } },
};

/** Replace box sizes and weights with the values saved on the Settings page. */
export function applyItemOverrides(overrides = {}) {
  for (const [key, v] of Object.entries(overrides)) {
    if (!ITEMS[key] || !v) continue;
    for (const f of ['length', 'width', 'height', 'declaredWeightKg']) {
      const n = Number(v[f]);
      if (n > 0) ITEMS[key][f] = n;
    }
  }
}

// Packing rules
export const PACKING = {
  CS: { stackHeightPerItemCm: 3, maxPerParcel: Infinity }, // custom parcel grows 3cm per item
  GP: { stackHeightPerItemCm: 5.5, maxPerParcel: 3 },        // never more than 3 Tracks per parcel
};

// DHL product codes
export const DHL_PRODUCTS = {
  international: 'P', // EXPRESS WORLDWIDE (non document)
  domestic: 'N',      // DOMESTIC EXPRESS (UAE to UAE)
};

export const DDP_SERVICE_CODE = 'DD'; // Duties and taxes paid by shipper
export const DAP_SERVICE_CODE = 'DS'; // Duties and taxes paid by receiver (DHL certification: always send DD or DS)

// Paperless Trade (WY): DHL PLT list, 12 Nov 2026. Countries NOT accepting PLT inbound need a printed invoice.
export const PLT_NOT_ACCEPTED = new Set('AM,AZ,BN,BO,BR,BY,CR,CU,DZ,EC,EG,GE,GL,GT,HN,IN,IQ,IR,KG,KH,KP,KV,KZ,LB,LS,LY,MA,MD,MK,MM,NG,NI,PK,RU,SD,SM,SO,SS,SV,SY,TJ,TN,TR,UA,UZ,VN,XS,YE'.split(','));
// Highest declared value DHL accepts with PLT, in USD (QAR, JOD and KWD limits converted).
export const PLT_MAX_USD = { CO: 2000, VE: 2000, BZ: 499, MS: 1500, JM: 3000, BM: 500, TT: 1000, AR: 1000, BS: 1000, DO: 3000, GY: 200, QA: 1370, XB: 100, XC: 49999, TC: 1000, SR: 50, UY: 200, XE: 100, OM: 2590, AE: 13623, AG: 4500, BH: 1300, JO: 1410, KY: 499999, KW: 325, HT: 100, PY: 1000, MQ: 25 };
export function pltAllowed(countryCode, valueUsd) {
  if (PLT_NOT_ACCEPTED.has(countryCode)) return false;
  const max = PLT_MAX_USD[countryCode];
  return !(max && valueUsd > max);
}

// EU customs reform (1 Nov 2026): B2C imports into the EU27 need product identifiers per line item.
export const EU27 = new Set('AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE'.split(','));

export const PRICING = {
  roundUpTo: 5,
  freeLabel: 'Free Standard Shipping',
  paidLabel: 'DHL Express Worldwide',
  domesticLabel: 'DHL Express Domestic',
};

// Map a Shopify SKU to an ITEMS key. Live SKU patterns (checked in Shopify, 10 Nov 2026):
//   City Silhouettes: {S|M|L}{MB|SL|GD}-CITY[-Y]   e.g. LMB-ABU DHABI-Y, SGD-PARIS
//   City Tracks:      GP{CITY}3040L{B|O|W}          e.g. GPAUH3040LB
// Planned pattern (CS-L-MB-..., GP-3040-BK-...) is also accepted.
export function itemKeyFromSku(sku) {
  const s = String(sku || '').toUpperCase().trim();
  let m;
  if ((m = s.match(/^([SML])(MB|SL|GD)-?/))) return `CS-${m[1]}`;
  if ((m = s.match(/^CS-([SML])-/))) return `CS-${m[1]}`;
  if (/^GP[A-Z]{3}\d{4}/.test(s) || s.startsWith('GP-')) return 'GP';
  if (s.startsWith('LB')) throw new UnsupportedItemError('City Lights is not available for multi address shipping yet');
  throw new UnsupportedItemError(`Unknown SKU for multi address shipping: ${sku}`);
}

export class UnsupportedItemError extends Error {}
