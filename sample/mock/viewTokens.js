/**
 * MOCK ONLY (throw this file away) — the signed, time-limited REPORT VIEW TOKEN, mirroring
 * `the view-token service` on our side.
 *
 * You never mint one of these yourself: ResidenceVertical mints them and hands you a finished
 * `viewUrl`. The mock reproduces the real recipe anyway, so the demo can show a token being
 * accepted, refused when tampered with, and refused again when it has expired.
 *
 * Format — the exact wire contract:
 *
 *     <expiryEpochMillis>.<hex hmac_sha256(secret, "partner-report-view|<reportRequestId>|<expiryEpochMillis>")>
 *
 * Two properties fall out of it, and both matter to you as an integrator:
 *   - the expiry is INSIDE the signed payload, so nobody can push a link's lifetime out by
 *     editing the URL;
 *   - the token is bound to ONE `reportRequestId`, so a link for one report cannot open another.
 *
 * The alphabet is `[0-9a-f.]`, so a `viewUrl` needs no URL escaping — store and forward it as-is.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

/** Domain separation: these MACs can never be replayed as another use of the same key. */
export const DOMAIN_LABEL = "partner-report-view";

/** The EXACT signed string. Any other implementation must reproduce it byte-for-byte. */
export function signedPayload(reportRequestId, expiryMillis) {
  return `${DOMAIN_LABEL}|${reportRequestId}|${expiryMillis}`;
}

function digest(secret, reportRequestId, expiryMillis) {
  return createHmac("sha256", secret)
    .update(signedPayload(reportRequestId, expiryMillis), "utf8")
    .digest("hex");
}

/** Signs a token for an explicit expiry — deliberately happy to mint an already-dead one (tests). */
export function mint(secret, reportRequestId, expiryMillis) {
  return `${expiryMillis}.${digest(secret, reportRequestId, expiryMillis)}`;
}

/**
 * A fresh link valid for `ttlSeconds` from `now`. The TTL is clamped to at least one second, so a
 * misconfigured `MOCK_VIEW_LINK_TTL_SECONDS` can never mint a link that is dead on arrival.
 */
export function issue(secret, reportRequestId, ttlSeconds, now = Date.now()) {
  const seconds = Number.isFinite(Number(ttlSeconds)) ? Number(ttlSeconds) : 0;
  const expiryMillis = now + Math.max(1000, Math.round(seconds * 1000));
  return { token: mint(secret, reportRequestId, expiryMillis), expiresAt: new Date(expiryMillis).toISOString() };
}

/**
 * True only for a well-formed, unexpired token whose MAC matches THIS id under THIS secret.
 *
 * Every rejection reason — malformed, wrong report, wrong secret, expired — answers the same
 * `false`, and the caller renders one single error. That is deliberate on the real service too:
 * the endpoint must never become an oracle that tells a stranger which ids exist.
 */
export function verify(secret, reportRequestId, token, now = Date.now()) {
  if (!secret || !reportRequestId || typeof token !== "string" || token.trim() === "") return false;
  const trimmed = token.trim();
  const separator = trimmed.indexOf(".");
  if (separator <= 0 || separator === trimmed.length - 1) return false;

  const expiryMillis = Number(trimmed.slice(0, separator));
  if (!Number.isInteger(expiryMillis)) return false;
  if (expiryMillis <= now) return false; // expired (or an expiry exactly at "now")

  // Constant-time over the whole digest. Compare the raw hex bytes, so a length difference or a
  // non-hex character can never short-circuit differently from a plain mismatch.
  const expected = Buffer.from(digest(secret, reportRequestId, expiryMillis), "utf8");
  const provided = Buffer.from(trimmed.slice(separator + 1), "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
