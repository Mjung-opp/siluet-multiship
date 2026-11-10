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
  if ((m = s.match(/^([SML])(MB|SL|GD)-/))) return `CS-${m[1]}`;
  if ((m = s.match(/^CS-([SML])-/))) return `CS-${m[1]}`;
  if (/^GP[A-Z]{3}\d{4}/.test(s) || s.startsWith('GP-')) return 'GP';
  if (s.startsWith('LB')) throw new UnsupportedItemError('City Lights is not available for multi address shipping yet');
  throw new UnsupportedItemError(`Unknown SKU for multi address shipping: ${sku}`);
}

export class UnsupportedItemError extends Error {}
