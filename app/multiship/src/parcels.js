import { ITEMS, PACKING, itemKeyFromSku } from './config.js';

/**
 * Build DHL parcels for one recipient.
 * City Silhouettes: wrapped together in one parcel. Footprint of the largest size, height grows per item.
 * City Tracks: stacked, max 3 per parcel, extra Tracks start a new parcel. Kept apart from Silhouettes.
 * @param {{sku:string, quantity:number}[]} lines
 * @returns {{length:number,width:number,height:number,weight:number, contents:string[]}[]}
 */
export function buildParcels(lines) {
  const units = [];
  for (const { sku, quantity } of lines) {
    const key = itemKeyFromSku(sku);
    for (let i = 0; i < quantity; i++) units.push(key);
  }
  const parcels = [];

  const cs = units.filter((k) => ITEMS[k].line === 'CS');
  if (cs.length) parcels.push(stack(cs, PACKING.CS.stackHeightPerItemCm));

  const gp = units.filter((k) => ITEMS[k].line === 'GP');
  for (let i = 0; i < gp.length; i += PACKING.GP.maxPerParcel) {
    parcels.push(stack(gp.slice(i, i + PACKING.GP.maxPerParcel), PACKING.GP.stackHeightPerItemCm));
  }
  return parcels;
}

function stack(keys, perItemHeight) {
  const largest = keys.reduce((a, b) => (ITEMS[b].rank > ITEMS[a].rank ? b : a));
  const box = ITEMS[largest];
  const weight = keys.reduce((sum, k) => sum + ITEMS[k].declaredWeightKg, 0);
  return {
    length: box.length,
    width: box.width,
    height: round1(perItemHeight * keys.length),
    weight: round3(weight),
    contents: keys,
  };
}

export function itemCount(lines) {
  return lines.reduce((n, l) => n + l.quantity, 0);
}

const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;
