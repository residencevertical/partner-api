#!/usr/bin/env node
/**
 * A local MOCK of the ResidenceVertical Partner API (`/api/partner/v1`) — MOCK ONLY, throw it
 * away once you have a real `rvp_test_…` key. It exists so you can build and test your whole
 * integration TODAY, before a key is issued and without spending real reports.
 *
 * It implements the documented contract: Bearer auth, the JSON error envelope
 * `{"error":{"code","message"[,"fields"]}}`, `X-RV-Request-Id` on every response,
 * `Idempotency-Key` replay/conflict, the daily cap, a report that really takes time to become
 * `generated`, a genuinely valid PDF, signed webhook delivery, and server-minted checkout links
 * (referral mode's recommended tier: mint, public resolve, and the `/c/<token>` landing).
 *
 *     node mock-rv-api.js          # http://localhost:4010
 *
 * Everything is in memory: restart it and the ledger is empty.
 *
 * See the README for the env table and the address-driven test hooks.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { buildMinimalPdf } from "./mock/minimalPdf.js";
import { buildMockReportPayload } from "./mock/reportPayload.js";
import {
  createReportStore, fakeGeocode, hooksFor, HOOK_KEYWORDS, secondsUntilBucharestMidnight,
} from "./mock/reports.js";
import { buildCannedReferrals, referralTotals } from "./mock/referrals.js";
import { buildCannedSettlement } from "./mock/settlements.js";
import { createCheckoutLinkStore } from "./mock/checkoutLinks.js";
import { renderCheckoutLandingPage } from "./mock/checkoutPage.js";
import {
  validateCreateCheckoutLinkBody, validateCreateReportBody, validateIdempotencyKey, requestHash,
} from "./mock/validate.js";
import { renderViewPage } from "./mock/viewPage.js";

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
  version: "1.0.0-mock"
servers:
  - url: {{BASE}}/api/partner/v1
paths:
  /reports: { post: { summary: Request a premium report }, get: { summary: List report requests } }
  /reports/{reportRequestId}: { get: { summary: Status of a report request } }
  /reports/{reportRequestId}/pdf: { get: { summary: Download the generated PDF (API key or ?t= view token) } }
  /reports/{reportRequestId}/view-link: { post: { summary: Mint a fresh link to the report web page } }
  /reports/{reportRequestId}/view-data: { get: { summary: The web page's data (?t= view token, no API key) } }
  /checkout-links: { post: { summary: Mint a prefilled, server-attributed checkout link (/c/<token>) } }
  /checkout-links/{token}/resolve: { get: { summary: What the checkout page prefills (public, token is the credential) } }
  /me: { get: { summary: Partner profile and usage (incl. the referral block) } }
  /settlements: { get: { summary: Weekly settlement history (newest first) } }
  /referrals: { get: { summary: Referral ledger — your users who bought on our checkout } }
`;

export function createMockServer(options = {}) {
  const config = {
    reportSeconds: Number(options.reportSeconds ?? process.env.MOCK_REPORT_SECONDS ?? 20),
    publicBaseUrl: options.publicBaseUrl ?? process.env.MOCK_PUBLIC_BASE_URL ?? null,
    webhookUrl: options.webhookUrl
      ?? process.env.MOCK_WEBHOOK_URL ?? "http://localhost:4000/webhooks/residencevertical",
    webhookSecret: options.webhookSecret ?? process.env.MOCK_WEBHOOK_SECRET ?? "whsec_local_mock_secret",
    webhookRetryDelaysMs: options.webhookRetryDelaysMs
      ?? (process.env.MOCK_WEBHOOK_RETRY_DELAYS_MS
        ? process.env.MOCK_WEBHOOK_RETRY_DELAYS_MS.split(",").map(Number) : undefined),
    // Lifetime of a report view link. The real platform default is 30 days (configurable per
    // partner account); shrink this to a couple of seconds to watch a link lapse on demand.
    viewLinkTtlSeconds: Number(
      options.viewLinkTtlSeconds ?? process.env.MOCK_VIEW_LINK_TTL_SECONDS ?? 30 * 24 * 3600,
    ),
    viewTokenSecret: options.viewTokenSecret ?? process.env.MOCK_VIEW_TOKEN_SECRET ?? "mock-view-token-secret",
    dailyCap: Number(options.dailyCap ?? process.env.MOCK_DAILY_CAP ?? 100),
    commissionPct: Number(options.commissionPct ?? process.env.MOCK_COMMISSION_PCT ?? 15),
    partnerName: options.partnerName ?? process.env.MOCK_PARTNER_NAME ?? "Portal Imobiliar SRL (mock)",
    boomFailures: Number(options.boomFailures ?? process.env.MOCK_BOOM_FAILURES ?? 1),
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
  const boomAttempts = new Map(); // address key -> attempts so far (drives MOCK_BOOM_FAILURES)
  const checkoutLinks = createCheckoutLinkStore({
    partnerSlug: PARTNER_SLUG,
    partnerName: config.partnerName,
    ttlSecondsOverride: config.checkoutLinkTtlSeconds,
  });
  let store = null;

  function ensureStore() {
    if (!store) {
      store = createReportStore({
        reportSeconds: config.reportSeconds,
        publicBaseUrl,
        webhookUrl: config.webhookUrl,
        webhookSecret: config.webhookSecret,
        webhookRetryDelaysMs: config.webhookRetryDelaysMs,
        viewTokenSecret: config.viewTokenSecret,
        viewLinkTtlSeconds: config.viewLinkTtlSeconds,
        log,
      });
    }
    return store;
  }

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

  // ---------------------------------------------------------------- handlers

  async function createReport(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return fail(res, 400, "validation_error", "Request body must be a valid JSON object.");
    }
    let body;
    try {
      body = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      return fail(res, 400, "validation_error", "Request body must be a valid JSON object.");
    }

    // Hooks are read leniently BEFORE validation because the real maintenance gate also runs
    // before validation (a partner mid-deploy gets one clear signal, not a field error).
    const hooks = hooksFor(body?.address?.street);
    if (hooks.has("Maintenance")) {
      return fail(res, 503, "maintenance",
        "We're updating the platform. Report generation is paused for a few minutes — "
        + "please try again shortly.", { retryAfterSeconds: 60 });
    }

    const keyCheck = validateIdempotencyKey(req.headers["idempotency-key"]);
    if (keyCheck.error) {
      return fail(res, 400, "validation_error", keyCheck.error.message, { fields: keyCheck.error.fields });
    }
    const validation = validateCreateReportBody(body, { liveEnvironment: false });
    if (!validation.ok) {
      return fail(res, 400, "validation_error", validation.message, { fields: validation.fields });
    }
    let input = validation.input;
    const hash = requestHash(input);

    const replay = ensureStore().findReplay(keyCheck.key);
    if (replay) {
      if (replay.requestHash !== hash) {
        return fail(res, 409, "idempotency_conflict",
          "This Idempotency-Key was already used with a different request body.");
      }
      log(`200 idempotent replay of ${replay.row.id} (Idempotency-Key: ${keyCheck.key})`);
      return send(res, 200, store.createdRepresentation(replay.row));
    }

    if (hooks.has("Cap") || store.countToday() >= config.dailyCap) {
      return fail(res, 429, "daily_cap_exceeded",
        "The account's daily report cap has been reached. Retry after midnight (Europe/Bucharest).",
        { retryAfterSeconds: secondsUntilBucharestMidnight() });
    }

    if (input.lat === null || input.lng === null) {
      if (hooks.has("Geo")) {
        return fail(res, 502, "geocoding_failed",
          "The address could not be geocoded. Send coordinates.lat/lng or check the address.");
      }
      const geocoded = fakeGeocode(`${input.street} ${input.streetNumber}, ${input.city}`);
      input = { ...input, lat: geocoded.lat, lng: geocoded.lng };
    }

    if (hooks.has("Boom")) {
      const addressKey = `${input.street}|${input.streetNumber}|${input.city}`.toLowerCase();
      const attempts = (boomAttempts.get(addressKey) ?? 0) + 1;
      boomAttempts.set(addressKey, attempts);
      if (attempts <= config.boomFailures) {
        // Faithful to the contract: the ledger row exists (marked failed, `report_service_error`,
        // not billable) and may still emit `report.failed`, but the Idempotency-Key is NOT
        // consumed — retrying with the SAME key creates a fresh attempt.
        store.create({ input, hooks, idempotencyKey: keyCheck.key, requestHash: hash, failImmediately: true });
        return fail(res, 502, "report_service_unavailable",
          "The report generation service could not accept the request. Retry in a few minutes.");
      }
    }

    const row = store.create({ input, hooks, idempotencyKey: keyCheck.key, requestHash: hash });
    log(`202 created ${row.id} externalReference=${row.externalReference ?? "-"}`);
    return send(res, 202, store.createdRepresentation(row, { refresh: false }));
  }

  function getReport(res, id) {
    const row = ensureStore().get(id);
    if (!row) return fail(res, 404, "not_found", "Report request not found.");
    return send(res, 200, store.representation(row));
  }

  /**
   * Mints a FRESH link to the report's web page (Bearer key). This is what you call when the
   * `viewUrl` you stored has expired — older links keep working until their own expiry.
   */
  function createViewLink(res, id) {
    const row = ensureStore().get(id);
    if (!row) return fail(res, 404, "not_found", "Report request not found.");
    const representation = store.representation(row);
    if (representation.status !== "generated") {
      return fail(res, 409, "report_not_ready",
        `The report is not generated yet (status: ${representation.status}).`);
    }
    const link = store.viewLinkFor(row);
    log(`view link issued for ${row.id} (expires ${link.expiresAt})`);
    return send(res, 200, { reportRequestId: row.id, viewUrl: link.viewUrl, viewExpiresAt: link.expiresAt });
  }

  /**
   * The token IS the credential on the page-facing endpoints — no API key, because your end
   * user's browser calls them. A refused token and an unknown report request answer the SAME
   * `401 invalid_or_expired_view_token`, so the endpoint can never be used to discover which ids
   * exist. Returns the settled representation, or null once it has already answered.
   */
  function requireGeneratedViewGrant(res, id, token) {
    const refuse = () => {
      fail(res, 401, "invalid_or_expired_view_token",
        "This report link is invalid or has expired. Ask for a new link.");
      return null;
    };
    if (!ensureStore().verifyViewToken(id, token)) return refuse();
    const row = store.get(id);
    if (!row) return refuse();
    const representation = store.representation(row);
    if (representation.status !== "generated") {
      fail(res, 409, "report_not_ready",
        `The report is not generated yet (status: ${representation.status}).`);
      return null;
    }
    return representation;
  }

  /** The report web page's own data. No commercial field is ever exposed here. */
  function getReportViewData(res, id, token) {
    const representation = requireGeneratedViewGrant(res, id, token);
    if (!representation) return undefined;
    return send(res, 200, {
      reportRequestId: representation.reportRequestId,
      generatedAt: representation.generatedAt,
      address: representation.address,
      propertyType: representation.propertyType,
      partnerName: config.partnerName,
      report: buildMockReportPayload(representation),
    });
  }

  function getReportPdfByViewToken(res, id, token) {
    const representation = requireGeneratedViewGrant(res, id, token);
    if (!representation) return undefined;
    return renderPdf(res, representation);
  }

  function getReportPdf(res, id) {
    const row = ensureStore().get(id);
    if (!row) return fail(res, 404, "not_found", "Report request not found.");
    const representation = store.representation(row);
    if (representation.status !== "generated") {
      return fail(res, 409, "report_not_ready",
        `The report is not generated yet (status: ${representation.status}).`);
    }
    return renderPdf(res, representation);
  }

  /** The same bytes on both PDF paths — Bearer key and view token stream one identical file. */
  function renderPdf(res, representation) {
    const { address } = representation;
    const pdf = buildMinimalPdf({
      title: "Raport imobiliar ResidenceVertical (MOCK)",
      lines: [
        `Adresa: ${address.street} ${address.streetNumber}, ${address.city}`
          + `${address.county ? `, ${address.county}` : ""}${address.postalCode ? `, ${address.postalCode}` : ""}`,
        `Tip proprietate: ${representation.propertyType}`,
        `Coordonate: ${representation.coordinates?.lat}, ${representation.coordinates?.lng}`,
        "",
        `reportRequestId: ${representation.reportRequestId}`,
        `reportId: ${representation.reportId}`,
        `externalReference: ${representation.externalReference ?? "-"}`,
        `generatedAt: ${representation.generatedAt}`,
        "",
        "Acesta este un PDF generat de serverul MOCK, pentru dezvoltare locala.",
        "Raportul real are zeci de pagini: analiza zonei, dezvoltator, seismic,",
        "autorizatii de construire, preturi comparabile, transport, scoli, stiri.",
      ],
      footer: "MOCK — mock-rv-api.js · ResidenceVertical Partner API reference integration",
    });
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="raport-imobiliar-${representation.reportRequestId}.pdf"`,
      "Content-Length": pdf.length,
      "X-RV-Request-Id": res.rvRequestId,
    });
    res.end(pdf);
  }

  function listReports(res, url) {
    const status = (url.searchParams.get("status") ?? "").trim().toLowerCase();
    if (status && !["processing", "generated", "failed"].includes(status)) {
      return fail(res, 400, "validation_error", "status must be one of: processing, generated, failed",
        { fields: { status: "must be one of: processing, generated, failed" } });
    }
    const rawLimit = url.searchParams.get("limit");
    const rawOffset = url.searchParams.get("offset");
    const limit = rawLimit === null ? 20 : Math.max(1, Math.min(Number(rawLimit) || 20, 100));
    const offset = rawOffset === null ? 0 : Math.max(0, Number(rawOffset) || 0);
    const items = ensureStore().list({ status, limit, offset });
    return send(res, 200, { items, count: items.length, limit, offset });
  }

  function me(res) {
    const rows = ensureStore().list({ status: "", limit: 100, offset: 0 });
    const generated = rows.filter((row) => row.status === "generated").length;
    return send(res, 200, {
      partnerId,
      name: config.partnerName,
      slug: PARTNER_SLUG,
      environment: "test",
      commissionPct: config.commissionPct,
      dailyReportCap: config.dailyCap,
      reportsToday: store.countToday(),
      reportPriceCents: 5000,
      currency: "RON",
      webhookConfigured: Boolean(config.webhookUrl),
      usageThisMonth: {
        requested: rows.length,
        generated,
        failed: rows.filter((row) => row.status === "failed").length,
        commissionCents: Math.round(generated * 5000 * config.commissionPct / 100),
      },
      // Referral mode (guide §2): the link to put on the partner site + the money totals.
      // The totals are DERIVED from the same canned rows `GET /referrals` serves, so the two
      // surfaces always agree — exactly the consistency the real service guarantees.
      referral: {
        referralUrl: `${publicBaseUrl}/p/portal-imobiliar-mock`,
        commissionPct: config.commissionPct,
        ...referralTotals(ensureReferrals()),
      },
    });
  }

  /**
   * `GET /settlements` — the weekly settlement history (guide §16). The mock ships ONE canned
   * settlement: the last complete Monday→Sunday week, already `invoiced`, its money consistent with
   * `/me` (gross = reports × 50 lei, commission = the account's pct, net = what you owe). Canned
   * deliberately — the real service settles the ledger weekly, and reports created against the
   * mock minutes ago would never have settled yet.
   */
  let cannedSettlement = null; // minted once per process, so the settlementId is stable
  function listSettlements(res, url) {
    cannedSettlement ??= buildCannedSettlement({ commissionPct: config.commissionPct });
    const rawLimit = url.searchParams.get("limit");
    const rawOffset = url.searchParams.get("offset");
    const limit = rawLimit === null ? 20 : Math.max(1, Math.min(Number(rawLimit) || 20, 100));
    const offset = rawOffset === null ? 0 : Math.max(0, Number(rawOffset) || 0);
    const items = [cannedSettlement].slice(offset, offset + limit);
    return send(res, 200, { items, count: items.length, limit, offset });
  }

  /**
   * `GET /referrals` — the referral-mode ledger (guide §2.6): the partner's users who bought on
   * OUR checkout through the partner's `/p/<slug>` link. Canned deliberately (one row per state
   * a real ledger can show), minted once per process so the referralIds stay stable, and the
   * SAME rows feed `/me`'s referral totals. No buyer data on this surface — by design.
   */
  let cannedReferrals = null;
  const ensureReferrals = () => {
    cannedReferrals ??= buildCannedReferrals({ commissionPct: config.commissionPct });
    return cannedReferrals;
  };
  function listReferrals(res, url) {
    const rows = ensureReferrals();
    const rawLimit = url.searchParams.get("limit");
    const rawOffset = url.searchParams.get("offset");
    const limit = rawLimit === null ? 20 : Math.max(1, Math.min(Number(rawLimit) || 20, 100));
    const offset = rawOffset === null ? 0 : Math.max(0, Number(rawOffset) || 0);
    const items = rows.slice(offset, offset + limit);
    return send(res, 200, { items, count: items.length, limit, offset });
  }

  /**
   * `POST /checkout-links` (Bearer, guide §2.1) — referral mode's RECOMMENDED tier: mint a
   * prefilled, server-attributed checkout link. The partner puts the returned `url` behind
   * their button; the buyer opens it and pays on the ResidenceVertical checkout. Links are
   * REUSABLE until expiry (default 48 h, `expiresInHours` 1..720) — per-lead uniqueness comes
   * from `externalReference`, which later shows on the referral ledger (`GET /referrals`).
   */
  async function createCheckoutLink(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return fail(res, 400, "validation_error", "Request body must be a valid JSON object.");
    }
    let body;
    try {
      body = raw.trim() === "" ? {} : JSON.parse(raw);
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
    // The report WEB PAGE. On a real environment this is the SPA at
    // `https://<env>.residencevertical.ro/raport/<id>?t=…`; here it is a labelled placeholder that
    // makes the same two token-authenticated calls. It is deliberately OUTSIDE /api/partner/v1 and
    // needs no API key — your end user opens it directly.
    const pageMatch = /^\/raport\/([^/]+)$/.exec(path);
    if (pageMatch && req.method === "GET") {
      const html = renderViewPage({
        reportRequestId: decodeURIComponent(pageMatch[1]),
        token: url.searchParams.get("t") ?? "",
      });
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-RV-Request-Id": res.rvRequestId,
        "Content-Length": Buffer.byteLength(html),
      });
      return res.end(html);
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

    const reportMatch = /^\/api\/partner\/v1\/reports\/([^/]+)(\/pdf|\/view-link|\/view-data)?$/.exec(path);
    const viewToken = url.searchParams.get("t") ?? "";
    const hasAuthorization = Boolean((req.headers.authorization ?? "").trim());

    // `view-data` is called by a BROWSER: the signed token is the only credential, so the Bearer
    // check is skipped entirely (sending your API key here would be a leak, not an upgrade).
    if (reportMatch && reportMatch[2] === "/view-data" && req.method === "GET") {
      return getReportViewData(res, reportMatch[1], viewToken);
    }
    // The PDF takes EITHER credential. An `Authorization` header always wins, so the
    // server-to-server path is byte-identical to what it was before view links existed; a request
    // with neither credential still gets the same `401 unauthorized`.
    if (reportMatch && reportMatch[2] === "/pdf" && req.method === "GET" && !hasAuthorization && viewToken) {
      return getReportPdfByViewToken(res, reportMatch[1], viewToken);
    }

    if (!authenticate(req, res)) return undefined;

    if (path === "/api/partner/v1/reports" && req.method === "POST") return createReport(req, res);
    if (path === "/api/partner/v1/reports" && req.method === "GET") return listReports(res, url);
    if (path === "/api/partner/v1/checkout-links" && req.method === "POST") return createCheckoutLink(req, res);
    if (reportMatch && reportMatch[2] === "/view-link" && req.method === "POST") {
      return createViewLink(res, reportMatch[1]);
    }
    if (reportMatch && req.method === "GET" && reportMatch[2] !== "/view-link") {
      return reportMatch[2] === "/pdf" ? getReportPdf(res, reportMatch[1]) : getReport(res, reportMatch[1]);
    }
    if (path === "/api/partner/v1/me" && req.method === "GET") return me(res);
    if (path === "/api/partner/v1/settlements" && req.method === "GET") return listSettlements(res, url);
    if (path === "/api/partner/v1/referrals" && req.method === "GET") return listReferrals(res, url);
    return fail(res, 404, "not_found", "Unknown endpoint.");
  });

  // The store needs the final base URL (statusUrl / downloadUrl are absolute), which is only
  // known once the socket is bound — tests listen on an ephemeral port.
  const originalListen = server.listen.bind(server);
  server.listen = (...args) => {
    server.once("listening", () => {
      if (!publicBaseUrl) publicBaseUrl = `http://localhost:${server.address().port}`;
      ensureStore();
    });
    return originalListen(...args);
  };
  server.on("close", () => store?.stop());
  server.mockConfig = config;
  /** Change the ACCOUNT webhook URL at runtime (the real one is configured by our team). */
  server.setAccountWebhookUrl = (url) => { config.webhookUrl = url; ensureStore().setAccountWebhookUrl(url); };
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
  Report duration   ${config.reportSeconds}s until status=generated   (MOCK_REPORT_SECONDS)
  Account webhook   ${config.webhookUrl || "(none)"}
  Webhook secret    ${config.webhookSecret ? `${config.webhookSecret.slice(0, 12)}…` : "(unsigned)"}
  Daily cap         ${config.dailyCap} reports (Europe/Bucharest day)
  View link TTL     ${config.viewLinkTtlSeconds}s until a report link expires   (MOCK_VIEW_LINK_TTL_SECONDS)

  Endpoints:  POST /reports · GET /reports · GET /reports/{id} · GET /reports/{id}/pdf
              POST /reports/{id}/view-link · GET /reports/{id}/view-data?t=…
              POST /checkout-links (mint a prefilled checkout link — referral mode's
              recommended tier) · GET /checkout-links/{token}/resolve (public)
              GET /me (incl. the referral block) · GET /settlements (one canned invoiced week)
              GET /referrals (canned referral ledger, consistent with /me's totals)
              GET /openapi.yaml (mock stub — fetch the real one from gamma)

  Report web page:  ${base}/raport/{id}?t=…   (no API key — the token is the credential)
              A LABELLED PLACEHOLDER for the real ResidenceVertical page: it makes the same two
              token-authenticated calls and prints the report JSON. Set MOCK_VIEW_LINK_TTL_SECONDS=5
              to watch a link lapse into the "Linkul nu mai este valid" state.

  Checkout landing: ${base}/c/{token}   (no API key — the buyer opens it)
              A LABELLED PLACEHOLDER for the real checkout landing a checkout link opens: it
              resolves the token publicly and renders the prefilled order-form sketch with the
              "Comandă prin partener" chip. Links are REUSABLE until expiry (default 48h);
              set MOCK_CHECKOUT_LINK_TTL_SECONDS=10 to watch one lapse into the calm
              "Linkul de comandă nu mai este valid" state.

  TEST HOOKS — put the keyword in address.street as a whole word (case-insensitive):
    "Strada Fail 1"          the report ends status=failed (report_failed) + report.failed webhook
    "Strada Slow 1"          generation takes 3× as long (${config.reportSeconds * 3}s)
    "Strada Cap 1"           429 daily_cap_exceeded + Retry-After (seconds until midnight)
    "Strada Maintenance 1"   503 maintenance + Retry-After: 60
    "Strada Boom 1"          502 report_service_unavailable — first ${config.boomFailures} attempt(s),
                             then it succeeds (MOCK_BOOM_FAILURES). The Idempotency-Key is NOT
                             consumed: the same key retries as a fresh attempt.
    "Strada Geo 1"           502 geocoding_failed (only when you send no coordinates)
  Keywords: ${HOOK_KEYWORDS.join(", ")}
`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.MOCK_PORT ?? 4010);
  const server = createMockServer();
  server.listen(port, () => printBanner(server));
}
