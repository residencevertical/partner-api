/**
 * MOCK ONLY (throw this file away) — server-minted CHECKOUT LINKS (guide §2.1), referral mode's
 * recommended tier.
 *
 * The real flow: the partner's backend calls `POST /api/partner/v1/checkout-links` with a
 * property address; ResidenceVertical answers with an opaque `/c/<token>` URL; the partner puts
 * that URL behind their button; the buyer opens it and lands on the ResidenceVertical checkout
 * with the address prefilled and the "Comandă prin partener: <name>" chip. The token is a
 * `pcl_` + 32 random alphanumeric characters — opaque and unguessable, never sequential.
 *
 * Two contract points the mock reproduces faithfully:
 *   - links are REUSABLE until expiry (no consumed flag) — a reload or the back button must
 *     never brick the buyer; per-lead uniqueness comes from `externalReference`, not from a
 *     one-shot token;
 *   - the public resolve endpoint distinguishes only expired (410) from unknown (404) — the
 *     token is the whole credential, no API key is ever involved on the buyer's path.
 */
import { randomInt } from "node:crypto";

const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** `pcl_` + 32 chars [A-Za-z0-9] — the documented token shape. */
export const CHECKOUT_TOKEN_PATTERN = /^pcl_[A-Za-z0-9]{32}$/;

export function mintCheckoutToken() {
  let suffix = "";
  for (let i = 0; i < 32; i += 1) suffix += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  return `pcl_${suffix}`;
}

/**
 * @param {object} options
 * @param {string} options.partnerSlug   the mock account's slug (what resolve reports)
 * @param {string} options.partnerName   the mock account's display name (the co-branding chip)
 * @param {number|null} [options.ttlSecondsOverride]  MOCK-ONLY demo lever: when set, EVERY
 *        minted link lives this many seconds regardless of `expiresInHours`, so you can watch a
 *        link expire without waiting an hour (`MOCK_CHECKOUT_LINK_TTL_SECONDS`). `null` (the
 *        default) honours the request's `expiresInHours`, like the real service.
 */
export function createCheckoutLinkStore({ partnerSlug, partnerName, ttlSecondsOverride = null }) {
  const links = new Map(); // token -> row

  /** @param input the validated `validateCreateCheckoutLinkBody` input. */
  function create(input) {
    const token = mintCheckoutToken();
    const now = new Date();
    const ttlMs = ttlSecondsOverride === null
      ? input.expiresInHours * 3600_000
      : ttlSecondsOverride * 1000;
    const row = {
      checkoutLinkId: token,
      partnerSlug,
      partnerName,
      address: {
        street: input.street,
        streetNumber: input.streetNumber,
        city: input.city,
        county: input.county,
        postalCode: input.postalCode,
      },
      propertyType: input.propertyType,
      customerEmail: input.customerEmail,
      externalReference: input.externalReference,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      lastResolvedAt: null,
    };
    links.set(token, row);
    return row;
  }

  /**
   * The public resolve. Exactly three outcomes, like the real endpoint:
   * `ok` (ACTIVE partner, unexpired), `expired` (410), `unknown` (404).
   */
  function resolve(token) {
    const row = links.get(token);
    if (!row) return { outcome: "unknown" };
    if (Date.parse(row.expiresAt) <= Date.now()) return { outcome: "expired" };
    // Stamped at most once per minute, like the real `last_resolved_at` (and key last_used).
    if (!row.lastResolvedAt || Date.now() - Date.parse(row.lastResolvedAt) >= 60_000) {
      row.lastResolvedAt = new Date().toISOString();
    }
    return { outcome: "ok", row };
  }

  /** The documented resolve body — what the checkout page (and nothing else) needs. */
  function publicRepresentation(row) {
    return {
      partnerSlug: row.partnerSlug,
      partnerName: row.partnerName,
      address: { ...row.address },
      propertyType: row.propertyType,
      customerEmail: row.customerEmail,
      expiresAt: row.expiresAt,
    };
  }

  return { create, resolve, publicRepresentation, get: (token) => links.get(token) };
}
