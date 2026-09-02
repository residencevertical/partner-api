/**
 * ResidenceVertical webhook signature verification — COPY THIS FILE into your project.
 *
 * THE RECIPE
 * ----------
 *   signedPayload = "<X-RV-Timestamp>" + "." + <the RAW request body>
 *   X-RV-Signature: "v1=" + hex( HMAC_SHA256(webhookSecret, signedPayload) )
 *
 * `X-RV-Timestamp` is unix time in SECONDS. `webhookSecret` is the `whsec_…` value
 * ResidenceVertical gives you when a webhook is configured or rotated.
 *
 * NOTE: the referral program has NO webhook today — you learn of conversions by polling
 * `GET /referrals` (guide §2.3). This file is kept, tested, as the verification a signed
 * notification would use if one is introduced; nothing in `server.js` calls it.
 *
 * THREE RULES, ALL OF THEM LOAD-BEARING
 * -------------------------------------
 * 1. Sign the RAW BODY BYTES exactly as received — never a re-serialised JSON object. Frameworks
 *    that auto-parse JSON destroy the bytes (key order, spacing, unicode escaping) and every
 *    signature will fail. In Express: `express.raw({ type: "application/json" })` on this route
 *    only. With `node:http`: concatenate the request chunks yourself and parse only AFTER
 *    verifying.
 * 2. Compare in CONSTANT TIME (`crypto.timingSafeEqual`). A `===` on the hex string leaks how
 *    much of a forged signature was correct, one byte at a time.
 * 3. Reject STALE timestamps (default tolerance: 300 s, the value the platform documents). This
 *    is what stops a captured delivery from being replayed at you later.
 *
 * A request that fails any of these is not from us: answer 401 and do nothing else with it.
 * A request that passes is still only a NOTIFICATION — treat the ledger (`GET /referrals`) as
 * the system of record and keep polling it as a fallback.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_SCHEME = "v1";
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Case-insensitive header lookup — works with `node:http`, Express and `Headers`. */
function header(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * @param {Buffer|string} rawBody       the request body exactly as received
 * @param {object} headers              request headers (any casing)
 * @param {string} secret               your `whsec_…` webhook secret
 * @param {{toleranceSeconds?: number, nowSeconds?: number}} [options]
 * @returns {boolean} true only when the signature, the secret and the timestamp all check out
 */
export function verify(rawBody, headers, secret, options = {}) {
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!secret || rawBody === undefined || rawBody === null) return false;

  const timestamp = header(headers, "x-rv-timestamp");
  const signature = header(headers, "x-rv-signature");
  if (!timestamp || !signature) return false;
  if (!/^\d+$/.test(String(timestamp).trim())) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;

  const provided = String(signature).trim();
  if (!provided.startsWith(`${SIGNATURE_SCHEME}=`)) return false;
  const providedHex = provided.slice(SIGNATURE_SCHEME.length + 1).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(providedHex)) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const expectedHex = createHmac("sha256", secret)
    .update(`${String(timestamp).trim()}.`, "utf8")
    .update(body)
    .digest("hex");

  // Both are 64-char hex, so the lengths always match and timingSafeEqual never throws.
  return timingSafeEqual(Buffer.from(expectedHex, "utf8"), Buffer.from(providedHex, "utf8"));
}

/**
 * The signing side — you never need this in production, it is here so the tests (and your own
 * tests) can forge a correctly signed delivery against your endpoint.
 */
export function sign(rawBody, secret, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const hex = createHmac("sha256", secret)
    .update(`${timestampSeconds}.`, "utf8")
    .update(body)
    .digest("hex");
  return { timestamp: String(timestampSeconds), signature: `${SIGNATURE_SCHEME}=${hex}` };
}
