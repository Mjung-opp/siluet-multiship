import { PRICING } from './config.js';

/**
 * Pick the free address.
 * Rule (Mariana, 2026-11-09):
 *  - Different item counts: the address with the most items is free.
 *  - Same item counts: the cheapest address is free.
 *  - Tie on most items: the one with the lowest DHL cost to Siluet is free.
 * Both cases reduce to: most items first, lowest DHL cost breaks ties.
 * @param {{id:string, itemCount:number, dhlCost:number}[]} recipients  dhlCost in one common currency
 * @returns {string} id of the free recipient
 */
export function pickFreeRecipient(recipients) {
  if (!recipients.length) throw new Error('No recipients');
  const maxItems = Math.max(...recipients.map((r) => r.itemCount));
  const candidates = recipients.filter((r) => r.itemCount === maxItems);
  candidates.sort((a, b) => a.dhlCost - b.dhlCost || a.id.localeCompare(b.id));
  return candidates[0].id;
}

/** Round up to the next multiple of `step` (5 by default). 31.2 -> 35, 35 -> 35. */
export function roundUp(amount, step = PRICING.roundUpTo) {
  const cents = Math.round(amount * 100);
  const stepCents = step * 100;
  return Math.ceil(cents / stepCents) * step;
}

/** Convert from shop currency to the customer's currency, 2 decimals. */
export function convert(amount, rate) {
  return Math.round(amount * rate * 100) / 100;
}
