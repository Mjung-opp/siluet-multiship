// Settings saved per shop (edited on the app's Settings page). .env values are only a fallback.
import path from "node:path";
import db from "../db.server";
import { ITEMS, applyItemOverrides } from "./src/config.js";
import { createDhlClient } from "./src/dhl.js";

if (!process.env.DHL_API_KEY) {
  try { process.loadEnvFile(path.resolve(".env")); } catch { /* env provided by host */ }
}

export const DEFAULTS = {
  sender: {
    companyName: "Siluet Handicraft Workshops LLC",
    contactName: process.env.SHIPPER_CONTACT_NAME || "",
    phone: process.env.SHIPPER_PHONE || "",
    email: process.env.SHIPPER_EMAIL || "info@siluet.co",
    addressLine1: "Street 4, Warehouse 2",
    addressLine2: "Al Quoz Industrial Area 4",
    city: "Dubai",
    postalCode: "00000",
    countryCode: "AE",
  },
  pickup: { readyTime: "16:00", closeTime: "18:00", location: "reception", instructions: "" },
  dhl: {
    env: process.env.DHL_ENV || "test",
    apiKey: process.env.DHL_API_KEY || "",
    apiSecret: process.env.DHL_API_SECRET || "",
    accountNumber: process.env.DHL_ACCOUNT || "",
  },
  label: { template: "ECOM26_A6_002" },
  tracking: { baseUrl: "" },
  items: Object.fromEntries(Object.entries(ITEMS).map(([k, v]) => [k, {
    length: v.length, width: v.width, height: v.height, declaredWeightKg: v.declaredWeightKg,
  }])),
};

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  }
  return out;
}

export async function getSettings(shop) {
  const row = await db.shopSetting.findUnique({ where: { shop } });
  const s = merge(DEFAULTS, row ? JSON.parse(row.data) : {});
  if (!s.tracking.baseUrl) s.tracking.baseUrl = `https://${shop}`;
  applyItemOverrides(s.items);
  return s;
}

export async function saveSettings(shop, data) {
  const current = await getSettings(shop);
  // Keep saved secrets when the form leaves them blank.
  if (!data.dhl?.apiSecret) data.dhl = { ...data.dhl, apiSecret: current.dhl.apiSecret };
  if (!data.dhl?.apiKey) data.dhl = { ...data.dhl, apiKey: current.dhl.apiKey };
  const next = merge(current, data);
  await db.shopSetting.upsert({
    where: { shop },
    create: { shop, data: JSON.stringify(next) },
    update: { data: JSON.stringify(next) },
  });
  return next;
}

const clients = new Map();
export function dhlFor(settings) {
  const d = settings.dhl;
  const key = `${d.env}:${d.apiKey}:${d.accountNumber}:${d.apiSecret.length}`;
  if (!clients.has(key)) {
    clients.set(key, createDhlClient({ apiKey: d.apiKey, apiSecret: d.apiSecret, accountNumber: d.accountNumber, env: d.env }));
  }
  return clients.get(key);
}

/** Pickup day: today if it is a working day and before 15:00 in Dubai, otherwise the next working day. */
export function pickupDay(now = new Date()) {
  const dubai = new Date(now.getTime() + 4 * 3600 * 1000);
  const isWeekend = (d) => [0, 6].includes(d.getUTCDay());
  const day = new Date(Date.UTC(dubai.getUTCFullYear(), dubai.getUTCMonth(), dubai.getUTCDate()));
  if (isWeekend(day) || dubai.getUTCHours() >= 15) {
    do { day.setUTCDate(day.getUTCDate() + 1); } while (isWeekend(day));
  }
  return day.toISOString().slice(0, 10);
}

/** MyDHL date format in Dubai time, e.g. 2026-11-11T16:00:00GMT+04:00 */
export function dubaiDateTime(dayIso, hhmm) {
  return `${dayIso}T${hhmm}:00GMT+04:00`;
}
