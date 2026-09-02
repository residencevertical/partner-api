#!/usr/bin/env node
/**
 * A local MOCK of the ResidenceVertical Partner API (`/api/partner/v1`) — MOCK ONLY, throw it
 * away once you have a real `rvp_test_…` key. It exists so you can build and test your whole
 * integration TODAY, before a key is issued.
 *
 * It implements the documented contract: Bearer auth, the JSON error envelope
 * `{"error":{"code","message"[,"fields"]}}`, `X-RV-Request-Id` on every response, server-minted
 * checkout links (mint, public resolve, and the `/c/<token>` landing), the referral ledger and
 * the `/me` profile whose referral totals agree with that ledger.
 *
 *     node mock-rv-api.js          # http://localhost:4010
 *
 * Everything is in memory: restart it and the minted links are gone.
 *
 * See the README for the env table.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { buildCannedReferrals, referralTotals } from "./mock/referrals.js";
import { createCheckoutLinkStore } from "./mock/checkoutLinks.js";
import { renderCheckoutLandingPage } from "./mock/checkoutPage.js";
import { validateCreateCheckoutLinkBody } from "./mock/validate.js";

const KEY_PREFIX = "rvp_test_"; // the mock is a TEST environment; `rvp_live_` keys get 401
const PARTNER_SLUG = "portal-imobiliar-mock";
const MAX_BODY_BYTES = 1_000_000;

const OPENAPI_STUB = `# ResidenceVertical Partner API — LOCAL MOCK
# This is the mock server, not the contract. Fetch the authoritative OpenAPI document from the
# real environment (public, no authentication):
#   curl https://gamma.residencevertical.ro/api/partner/v1/openapi.yaml
openapi: 3.0.3
info:
  title: ResidenceVertical Partner API (local mock)
  version: "2.0.0-mock"
servers:
  - url: {{BASE}}/api/partner/v1
paths:
  /checkout-links: { post: { summary: Mint a prefilled, server-attributed checkout link (/c/<token>) } }
  /checkout-links/{token}/resolve: { get: { summary: What the checkout page prefills (public, token is the credential) } }
  /me: { get: { summary: Partner profile, commission and the referral block } }
  /referrals: { get: { summary: Referral ledger — your users who bought on our checkout } }
`;

export function createMockServer(options = {}) {
  const config = {
    publicBaseUrl: options.publicBaseUrl ?? process.env.MOCK_PUBLIC_BASE_URL ?? null,
    commissionPct: Number(options.commissionPct ?? process.env.MOCK_COMMISSION_PCT ?? 15),
    partnerName: options.partnerName ?? process.env.MOCK_PARTNER_NAME ?? "Portal Imobiliar SRL (mock)",
    // MOCK-ONLY demo lever: when set, every checkout link lives this many seconds regardless of
    // the request's `expiresInHours` (whose 1..720 validation is unchanged), so you can watch a
    // link expire on demand. The real expiry is chosen per request; default 48 h.
    checkoutLinkTtlSeconds: options.checkoutLinkTtlSeconds
      ?? (process.env.MOCK_CHECKOUT_LINK_TTL_SECONDS ? Number(process.env.MOCK_CHECKOUT_LINK_TTL_SECONDS) : null),
    quiet: options.quiet ?? false,
  };
  const log = (message) => { if (!config.quiet) console.log(`[mock-rv-api] ${message}`); };

  let publicBaseUrl = config.publicBaseUrl; // finalised on listen() when the port is ephemeral
  const partnerId = randomUUID();
  const checkoutLinks = createCheckoutLinkStore({
    partnerSlug: PARTNER_SLUG,
    partnerName: config.partnerName,
    ttlSecondsOverride: config.checkoutLinkTtlSeconds,
  });

  // ---------------------------------------------------------------- helpers

  function send(res, status, payload, headers = {}) {
    const body = payload === null ? "" : JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "X-RV-Request-Id": res.rvRequestId,
      "Content-Length": Buffer.byteLength(body),
      ...headers,
    });
    res.end(body);
  }

  function fail(res, status, code, message, { fields, retryAfterSeconds } = {}) {
    const error = { code, message };
    if (fields && Object.keys(fields).length > 0) error.fields = fields;
    const headers = retryAfterSeconds === undefined ? {} : { "Retry-After": String(retryAfterSeconds) };
    log(`${status} ${code} requestId=${res.rvRequestId} — ${message}`);
    send(res, status, { error }, headers);
  }

  /** 401 exactly like the real key service (missing/malformed vs unknown key). */
  function authenticate(req, res) {
    const header = req.headers.authorization ?? "";
    const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
    if (!match) {
      fail(res, 401, "unauthorized",
        "Missing or malformed Authorization header (expected: Bearer <api key>).");
      return false;
    }
    if (!match[1].startsWith(KEY_PREFIX)) {
      fail(res, 401, "unauthorized", "Unknown API key.");
      return false;
    }
    return true;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) reject(new Error("body too large"));
        else chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function readJsonBody(req) {
    const raw = await readBody(req);
    return raw.trim() === "" ? {} : JSON.parse(raw);
  }

  /** `?limit=` ≤ 100 (default 20) and `?offset=` (default 0) — the shared list envelope. */
  function pageOf(rows, url) {
    const rawLimit = url.searchParams.get("limit");
    const rawOffset = url.searchParams.get("offset");
    const limit = rawLimit === null ? 20 : Math.max(1, Math.min(Number(rawLimit) || 20, 100));
    const offset = rawOffset === null ? 0 : Math.max(0, Number(rawOffset) || 0);
    const items = rows.slice(offset, offset + limit);
    return { items, count: items.length, limit, offset };
  }

  // ---------------------------------------------------------------- handlers

  /**
   * `GET /referrals` — the referral ledger (guide §4.2): the partner's users who bought on OUR
   * checkout through a checkout link or the `/p/<slug>` link. Canned deliberately (one row per
   * state a real ledger can show), minted once per process so the referralIds stay stable, and
   * the SAME rows feed `/me`'s referral totals. No buyer data on this surface — by design.
   */
  let cannedReferrals = null;
  const ensureReferrals = () => {
    cannedReferrals ??= buildCannedReferrals({ commissionPct: config.commissionPct });
    return cannedReferrals;
  };
  function listReferrals(res, url) {
    return send(res, 200, pageOf(ensureReferrals(), url));
  }

  /**
   * `GET /me` (guide §8.4). The `referral` totals are DERIVED from the same canned rows
   * `GET /referrals` serves, so the two surfaces always agree — exactly the consistency the real
   * service guarantees. The trailing fields belong to the retired generation API and are kept on
   * the wire, empty, for compatibility (guide §13).
   */
  function me(res) {
    return send(res, 200, {
      partnerId,
      name: config.partnerName,
      slug: PARTNER_SLUG,
      environment: "test",
      commissionPct: config.commissionPct,
      reportPriceCents: 5000,
      currency: "RON",
      referral: {
        referralUrl: `${publicBaseUrl}/p/${PARTNER_SLUG}`,
        commissionPct: config.commissionPct,
        ...referralTotals(ensureReferrals()),
      },
      dailyReportCap: null,
      reportsToday: 0,
      webhookConfigured: false,
      usageThisMonth: { requested: 0, generated: 0, failed: 0, commissionCents: 0 },
    });
  }

  /**
   * `POST /checkout-links` (Bearer, guide §4.1): mint a prefilled, server-attributed checkout
   * link. The partner puts the returned `url` behind their button; the buyer opens it and pays on
   * the ResidenceVertical checkout. Links are REUSABLE until expiry (default 48 h,
   * `expiresInHours` 1..720) — per-lead uniqueness comes from `externalReference`, which later
   * shows on the referral ledger (`GET /referrals`).
   */
  async function createCheckoutLink(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return fail(res, 400, "validation_error", "Request body must be a valid JSON object.");
    }
    const validation = validateCreateCheckoutLinkBody(body);
    if (!validation.ok) {
      return fail(res, 400, "validation_error", validation.message, { fields: validation.fields });
    }
    const row = checkoutLinks.create(validation.input);
    log(`201 checkout link ${row.checkoutLinkId} minted`
      + ` externalReference=${row.externalReference ?? "-"} (expires ${row.expiresAt})`);
    return send(res, 201, {
      checkoutLinkId: row.checkoutLinkId,
      url: `${publicBaseUrl}/c/${row.checkoutLinkId}`,
      expiresAt: row.expiresAt,
      externalReference: row.externalReference,
    });
  }

  /**
   * `GET /checkout-links/{token}/resolve` — PUBLIC (the buyer's browser calls it from the
   * checkout page; the token is the whole grant, no API key). Exactly the documented outcomes:
   * 200 with the prefill payload, `410 checkout_link_expired`, `404 not_found` for a token
   * that never existed — and nothing else the endpoint could be used to discover.
   */
  function resolveCheckoutLink(res, token) {
    const result = checkoutLinks.resolve(token);
    if (result.outcome === "unknown") {
      return fail(res, 404, "not_found", "Checkout link not found.");
    }
    if (result.outcome === "expired") {
      return fail(res, 410, "checkout_link_expired",
        "This checkout link has expired. Ask the partner for a fresh link.");
    }
    return send(res, 200, checkoutLinks.publicRepresentation(result.row));
  }

  /**
   * `POST /reports` — the RETIRED partner-generated-report endpoint (guide §13). The message
   * below is copied WORD FOR WORD from the real service, so code copied from an old integration
   * fails here exactly as it would in production; `test/retiredGeneration.test.js` pins the
   * string. If the real refusal is ever reworded, reword it here in the same change.
   */
  function retiredReportGeneration(res) {
    return fail(res, 403, "billed_generation_retired",
      "Partner-billed report generation is not offered. Reports are sold through checkout links "
      + "(POST /api/partner/v1/checkout-links): your customer pays ResidenceVertical and you earn "
      + "a referral commission.");
  }

  // ---------------------------------------------------------------- routing

  const server = http.createServer((req, res) => {
    res.rvRequestId = randomUUID();
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/partner/v1/openapi.yaml" && req.method === "GET") {
      const yaml = OPENAPI_STUB.replace("{{BASE}}", publicBaseUrl);
      res.writeHead(200, {
        "Content-Type": "text/yaml; charset=utf-8",
        "X-RV-Request-Id": res.rvRequestId,
        "Content-Length": Buffer.byteLength(yaml),
      });
      return res.end(yaml);
    }

    // The CHECKOUT LANDING a checkout link opens. On a real environment this is the customer SPA
    // at `https://<env>.residencevertical.ro/c/<token>`; here it is a labelled placeholder that
    // performs the same public resolve call and renders the prefilled order-form sketch (or the
    // calm expired state). Deliberately OUTSIDE /api/partner/v1 and key-free — the BUYER opens it.
    const checkoutPageMatch = /^\/c\/([^/]+)$/.exec(path);
    if (checkoutPageMatch && req.method === "GET") {
      const html = renderCheckoutLandingPage({ token: decodeURIComponent(checkoutPageMatch[1]) });
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-RV-Request-Id": res.rvRequestId,
        "Content-Length": Buffer.byteLength(html),
      });
      return res.end(html);
    }

    if (!path.startsWith("/api/partner/v1")) {
      return fail(res, 404, "not_found", "Unknown endpoint. The Partner API is served under /api/partner/v1.");
    }

    // PUBLIC resolve — the checkout page's own call. The token is the credential, so the Bearer
    // check is skipped entirely (a browser never holds the partner's key).
    const resolveMatch = /^\/api\/partner\/v1\/checkout-links\/([^/]+)\/resolve$/.exec(path);
    if (resolveMatch && req.method === "GET") {
      return resolveCheckoutLink(res, decodeURIComponent(resolveMatch[1]));
    }

    if (!authenticate(req, res)) return undefined;

    if (path === "/api/partner/v1/checkout-links" && req.method === "POST") return createCheckoutLink(req, res);
    if (path === "/api/partner/v1/me" && req.method === "GET") return me(res);
    if (path === "/api/partner/v1/referrals" && req.method === "GET") return listReferrals(res, url);
    if (path === "/api/partner/v1/reports" && req.method === "POST") return retiredReportGeneration(res);
    return fail(res, 404, "not_found", "Unknown endpoint.");
  });

  // The public base URL (checkout-link and referral URLs are absolute) is only known once the
  // socket is bound — tests listen on an ephemeral port.
  const originalListen = server.listen.bind(server);
  server.listen = (...args) => {
    server.once("listening", () => {
      if (!publicBaseUrl) publicBaseUrl = `http://localhost:${server.address().port}`;
    });
    return originalListen(...args);
  };
  server.mockConfig = config;
  server.baseUrl = () => publicBaseUrl ?? `http://localhost:${server.address().port}`;
  return server;
}

export function printBanner(server) {
  const { mockConfig: config } = server;
  const base = server.baseUrl();
  console.log(`
┌──────────────────────────────────────────────────────────────────────────────┐
│  ResidenceVertical Partner API — LOCAL MOCK (not the real service)           │
└──────────────────────────────────────────────────────────────────────────────┘
  Base URL          ${base}/api/partner/v1
  API key           any key starting with "${KEY_PREFIX}"  (anything else → 401 unauthorized)
  Commission        ${config.commissionPct}% per generated report (MOCK_COMMISSION_PCT)
  Checkout link TTL ${config.checkoutLinkTtlSeconds === null ? "per request (expiresInHours, default 48 h)" : `${config.checkoutLinkTtlSeconds}s (MOCK_CHECKOUT_LINK_TTL_SECONDS)`}

  Endpoints:  POST /checkout-links (mint a prefilled checkout link)
              GET /checkout-links/{token}/resolve (public — the checkout page's own call)
              GET /me (profile, commission, the referral block)
              GET /referrals (canned referral ledger, consistent with /me's totals)
              GET /openapi.yaml (mock stub — fetch the real one from gamma)
              POST /reports → 403 billed_generation_retired (the retired generation API)

  Checkout landing: ${base}/c/{token}   (no API key — the buyer opens it)
              A LABELLED PLACEHOLDER for the real checkout landing a checkout link opens: it
              resolves the token publicly and renders the prefilled order-form sketch with the
              "Comandă prin partener" chip. Links are REUSABLE until expiry (default 48h);
              set MOCK_CHECKOUT_LINK_TTL_SECONDS=10 to watch one lapse into the calm
              "Linkul de comandă nu mai este valid" state.

  Referral link:    ${base}/p/${PARTNER_SLUG}   (the link-only tier — read it from GET /me)
`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.MOCK_PORT ?? 4010);
  const server = createMockServer();
  server.listen(port, () => printBanner(server));
}
