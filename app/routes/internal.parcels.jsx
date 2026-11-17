// Operations parcel service: POST /internal/parcels, server to server, HMAC signed (see multiship/parcel-auth.js).
// Body: {op, shop, ...}. Ops: plan, rates, create, status, label, reconcile, audit (multiship/parcel-shipping.server.js).
// Responses are JSON; errors are {error, code}. Nothing from the body (recipient data) is written to the logs.
import { unauthenticated } from "../shopify.server";
import { getSettings, dhlFor } from "../multiship/settings.server.js";
import { isLocked } from "../multiship/lock.js";
import { verifyParcelRequest, parcelShops, readBodyCapped } from "../multiship/parcel-auth.js";
import { handleParcelOp, ParcelError } from "../multiship/parcel-shipping.server.js";

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const MAX_BODY = 256 * 1024;

const reply = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const loader = () => reply({ error: "Method not allowed", code: "method_not_allowed" }, 405);

export const action = async ({ request }) => {
  if (request.method !== "POST") return reply({ error: "Method not allowed", code: "method_not_allowed" }, 405);
  const rawBody = await readBodyCapped(request, MAX_BODY);
  if (rawBody === null) return reply({ error: "Request too large", code: "too_large" }, 413);

  const auth = verifyParcelRequest({
    key: process.env.OPERATIONS_SERVICE_KEY,
    timestamp: request.headers.get("X-Siluet-Timestamp"),
    signature: request.headers.get("X-Siluet-Signature"),
    rawBody,
  });
  if (!auth.ok) return reply({ error: auth.error, code: auth.code }, auth.status);

  let body;
  try { body = JSON.parse(rawBody); } catch { return reply({ error: "Body must be JSON", code: "bad_request" }, 400); }
  if (!body || typeof body !== "object" || !SHOP_RE.test(String(body.shop || ""))) {
    return reply({ error: "shop must be a myshopify.com domain", code: "bad_request" }, 400);
  }
  const shop = body.shop;
  const allowed = parcelShops();
  if (!allowed.length) return reply({ error: "No shop is enabled for the parcel service (PARCEL_SHOPS)", code: "shops_not_configured" }, 503);
  if (!allowed.includes(shop)) return reply({ error: "This shop is not enabled for the parcel service", code: "shop_not_allowed" }, 403);

  try {
    const settings = await getSettings(shop);
    const ctx = {
      shop,
      settings,
      locked: isLocked(settings, shop),
      getAdmin: async () => {
        try {
          return (await unauthenticated.admin(shop)).admin;
        } catch {
          throw new ParcelError("shop_not_installed", "Multiship is not installed on this shop", 404);
        }
      },
      getDhl: () => {
        try {
          return dhlFor(settings);
        } catch {
          throw new ParcelError("dhl_unavailable", "DHL is not configured", 503);
        }
      },
    };
    return reply(await handleParcelOp(body, ctx));
  } catch (e) {
    if (e instanceof ParcelError) return reply({ error: e.message, code: e.code, ...e.extra }, e.status);
    console.error("[parcels] op failed", String(body.op).slice(0, 20), e?.name || "Error");
    return reply({ error: "Parcel service error", code: "internal" }, 500);
  }
};
