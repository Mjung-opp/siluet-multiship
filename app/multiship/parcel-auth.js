// Signed server-to-server requests from Operations to /internal/parcels.
// Headers: X-Siluet-Timestamp = unix seconds, X-Siluet-Signature = lowercase hex HMAC-SHA256 with
// key = UTF-8 of OPERATIONS_SERVICE_KEY over `${timestamp}.${rawBody}`. Requests more than 300 s away
// from the server clock are refused. No key configured: every request is refused (fail closed).
// The key is trimmed (leading/trailing whitespace from env files) on both sides, here and when signing.
import crypto from "node:crypto";

export const MAX_SKEW_SECONDS = 300;

const cleanKey = (key) => String(key ?? "").trim();

export function signParcelRequest(key, timestamp, rawBody) {
  return crypto.createHmac("sha256", Buffer.from(cleanKey(key), "utf8")).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/** @returns {{ok: true} | {ok: false, status: number, code: string, error: string}} */
export function verifyParcelRequest({ key: rawKey, timestamp, signature, rawBody, now = Date.now() }) {
  const key = cleanKey(rawKey);
  if (!key) return { ok: false, status: 503, code: "service_key_missing", error: "Parcel service is not configured" };
  const ts = String(timestamp ?? "");
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, status: 401, code: "bad_timestamp", error: "Missing or invalid timestamp" };
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > MAX_SKEW_SECONDS) return { ok: false, status: 401, code: "stale_request", error: "Request timestamp is too old or too far ahead" };
  const sig = String(signature ?? "");
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, status: 401, code: "bad_signature", error: "Invalid signature" };
  const expected = Buffer.from(signParcelRequest(key, ts, rawBody), "hex");
  if (!crypto.timingSafeEqual(expected, Buffer.from(sig, "hex"))) return { ok: false, status: 401, code: "bad_signature", error: "Invalid signature" };
  return { ok: true };
}

/**
 * Shops allowed to use the parcel service: PARCEL_SHOPS, comma separated. Unset or empty means NO shop
 * (fail closed): there is no production shop recorded anywhere in Multiship's settings to default to, and the
 * dev store is accepted only when listed explicitly.
 */
export function parcelShops(env = process.env) {
  return String(env.PARCEL_SHOPS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Reads at most maxBytes of the body (bytes, not characters); null when it is larger. */
export async function readBodyCapped(request, maxBytes) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
