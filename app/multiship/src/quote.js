import { buildParcels, itemCount } from './parcels.js';
import { pickFreeRecipient, roundUp, convert } from './allocate.js';
import { PRICING } from './config.js';

/**
 * Quote a multi address cart.
 * @param {object} input
 * @param {{id:string, address:{countryCode:string, city:string, postalCode?:string, provinceCode?:string},
 *          lines:{sku:string, quantity:number, unitPrice:number, title?:string}[]}[]} input.recipients
 *        unitPrice in shop currency
 * @param {string} input.shopCurrency   e.g. 'AED'
 * @param {{currency:string, rate:number}} input.presentment  customer currency and shop to customer rate
 * @param {ReturnType<import('./dhl.js').createDhlClient>} dhl
 */
export async function quoteMultiship({ recipients, shopCurrency, presentment, dhlFx, dhlCurrency = 'AED' }, dhl) {
  if (!Array.isArray(recipients) || recipients.length < 2) {
    throw new Error('Multi address quotes need at least 2 addresses. Single address orders use the normal checkout.');
  }

  const prepared = recipients.map((r) => {
    const parcels = buildParcels(r.lines);
    const declaredValue = round2(r.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0));
    return { ...r, parcels, itemCount: itemCount(r.lines), declaredValue };
  });

  const toDhl = (amount) => {
    if (shopCurrency === dhlCurrency) return amount;
    const rate = dhlFx?.[`${dhlCurrency}->${shopCurrency}`];
    if (!rate) throw new Error(`No exchange rate for ${dhlCurrency} to ${shopCurrency}`);
    return round2(amount / rate);
  };

  // 1. Base Express Worldwide / Domestic cost for every address (cost to Siluet).
  const base = await Promise.all(prepared.map((r) =>
    dhl.rate({ address: r.address, parcels: r.parcels, declaredValue: toDhl(r.declaredValue), currency: dhlCurrency })));
  // DHL bills in its account currency (AED). The live store's currency is USD, so convert to shop currency.
  const toShop = (amount, currency) => {
    if (currency === shopCurrency) return amount;
    const rate = dhlFx?.[`${currency}->${shopCurrency}`];
    if (!rate) throw new Error(`No exchange rate for ${currency} to ${shopCurrency}`);
    return round2(amount * rate);
  };
  base.forEach((b) => { b.price = toShop(b.price, b.currency); b.currency = shopCurrency; });

  // 2. Free address: most items, ties broken by lowest DHL cost.
  const freeId = pickFreeRecipient(prepared.map((r, i) => ({ id: r.id, itemCount: r.itemCount, dhlCost: base[i].price })));

  // 3. DDP option per international address: DHL landed cost gives duties, taxes, fees and the DD fee in one call.
  const ddp = await Promise.all(prepared.map(async (r, i) => {
    if (base[i].domestic) return null;
    try {
      const lc = await dhl.dutiesAndTaxes({ address: r.address, parcels: r.parcels, lines: r.lines.map((l) => ({ ...l, unitPrice: toDhl(l.unitPrice) })), currency: dhlCurrency });
      return {
        duties: toShop(lc.duties, lc.currency),
        taxes: toShop(lc.taxes, lc.currency),
        fees: toShop(lc.fees, lc.currency),
        ddFee: toShop(lc.ddFee, lc.currency),
        total: toShop(lc.amount, lc.currency),
      };
    } catch (e) {
      return { unavailable: true, reason: e.message };
    }
  }));

  // 4. Customer facing prices.
  const quotes = prepared.map((r, i) => {
    const free = r.id === freeId;
    const label = free ? PRICING.freeLabel : base[i].domestic ? PRICING.domesticLabel : PRICING.paidLabel;
    const amount = free ? 0 : roundUp(convert(base[i].price, presentment.rate));
    const d = ddp[i];
    return {
      id: r.id,
      itemCount: r.itemCount,
      free,
      shipping: { label, amount, currency: presentment.currency },
      ddp: !d ? null
        : d.unavailable ? { available: false }
        : { available: true, amount: convert(d.total, presentment.rate), currency: presentment.currency },
      internal: {
        dhlCost: base[i].price,
        dhlCurrency: base[i].currency,
        productCode: base[i].productCode,
        parcels: r.parcels,
        ddpBreakdown: d,
      },
    };
  });

  return { freeRecipientId: freeId, quotes };
}

/** Total the customer pays for shipping and DDP, given their DDP choices. */
export function shippingTotal(quoteResult, ddpChoices = {}) {
  return round2(quoteResult.quotes.reduce((sum, q) => {
    const ddp = ddpChoices[q.id] && q.ddp?.available ? q.ddp.amount : 0;
    return sum + q.shipping.amount + ddp;
  }, 0));
}

const round2 = (n) => Math.round(n * 100) / 100;
