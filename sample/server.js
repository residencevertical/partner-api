#!/usr/bin/env node
/**
 * The PARTNER's backend — this is the part you actually adapt.
 *
 * It shows the whole API-backed referral integration (guide §4) in one small file:
 *   POST /api/checkout-links     your user clicks "Raport ResidenceVertical" → we mint ONE
 *                                checkout link for the property, keyed by YOUR lead id as
 *                                `externalReference`, and hand the `/c/<token>` URL to the
 *                                browser. The buyer pays ResidenceVertical directly; this
 *                                backend is out of the payment path entirely.
 *   GET  /api/leads/:leadId      your own lead view: the link you minted plus, once the buyer
 *                                has bought, the referral row (pending → earned, or void) —
 *                                read from the ledger with a small cache.
 *   GET  /api/referrals          the "Conversiile mele" panel: your referral ledger, polled from
 *                                ResidenceVertical (this is how you learn a lead converted —
 *                                there is no webhook, guide §2.3).
 *   GET  /api/account            the safe subset of GET /me for the storefront: name, commission,
 *                                the link-only `/p/<slug>` URL and your running totals.
 *
 * Run it against the bundled mock (default) or against gamma — one env switch, no code change:
 *   node server.js
 *   RV_API_BASE_URL=https://gamma.residencevertical.ro RV_API_KEY=rvp_test_… node server.js
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRvClient, RvApiError } from "./lib/rvClient.js";
import { createLeadStore } from "./lib/store.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const LEDGER_CACHE_MS = 5_000;
const ACCOUNT_CACHE_MS = 60_000;
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

export class ConfigError extends Error {}

/** Local mock vs a real environment — decided by the host, so there is a single switch. */
export function resolveConfig(env = process.env) {
  const baseUrl = (env.RV_API_BASE_URL ?? "http://localhost:4010").replace(/\/+$/, "");
  let host;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new ConfigError(`RV_API_BASE_URL is not a valid URL: "${baseUrl}"`);
  }
  const mockMode = ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host);

  const apiKey = env.RV_API_KEY ?? (mockMode ? "rvp_test_localmockkey000000000000000000000000" : null);
  if (!apiKey) {
    throw new ConfigError(
      `RV_API_KEY is required when RV_API_BASE_URL points at a real environment (${baseUrl}).\n`
      + "  ResidenceVertical issues the key; it starts with rvp_test_ (gamma) or rvp_live_ (production).\n"
      + "  Set it and start again:\n"
      + `      RV_API_BASE_URL=${baseUrl} RV_API_KEY=rvp_test_… node server.js\n`
      + "  Or drop the env vars entirely to run against the bundled mock (node mock-rv-api.js).",
    );
  }
  if (!apiKey.startsWith("rvp_")) {
    throw new ConfigError(`RV_API_KEY does not look like a Partner API key (expected rvp_test_… or rvp_live_…).`);
  }
  if (!mockMode && apiKey.startsWith("rvp_test_") && !baseUrl.includes("gamma")) {
    throw new ConfigError(
      `RV_API_KEY is a TEST key (rvp_test_…) but RV_API_BASE_URL is ${baseUrl}.\n`
      + "  Keys are environment-scoped: rvp_test_ works only on https://gamma.residencevertical.ro,\n"
      + "  rvp_live_ only on https://residencevertical.ro. Using the wrong pair answers 401 unauthorized.",
    );
  }

  return {
    baseUrl,
    apiKey,
    mockMode,
    port: Number(env.PORT ?? 4000),
    ledgerCacheMs: Number(env.RV_LEDGER_CACHE_MS ?? LEDGER_CACHE_MS),
  };
}

export function createPartnerServer(config) {
  const ledgerCacheMs = config.ledgerCacheMs ?? LEDGER_CACHE_MS;
  const store = createLeadStore();
  const wireLog = [];

  function logWire(entry) {
    wireLog.unshift({ at: new Date().toISOString(), ...entry });
    if (wireLog.length > 60) wireLog.length = 60;
  }

  const rv = createRvClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    onExchange: ({ method, path: p, status, code, requestId, attempt, durationMs, note }) => {
      logWire({
        direction: "out",
        label: `${method} ${p}`,
        status,
        code,
        requestId,
        note: [attempt > 1 ? `attempt ${attempt}` : null, note, `${durationMs}ms`].filter(Boolean).join(" · "),
      });
    },
  });

  // ------------------------------------------------------------- http helpers

  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  };

  const readJsonBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  };

  /** Surface the machine-readable upstream code to your own UI; never the raw stack trace. */
  const sendUpstreamError = (res, error, extra = {}) => sendJson(res, error.status === 400 ? 400 : 502, {
    ...extra,
    error: { code: error.code, message: error.message, requestId: error.requestId },
  });

  /**
   * Your own view of a lead — never leak the key to the browser. `checkoutUrl` is safe to hand
   * over as-is: it carries no API key, only the opaque token that IS the link.
   */
  const leadView = (lead) => ({
    leadId: lead.leadId,
    property: lead.property,
    checkoutLinkId: lead.checkoutLinkId,
    checkoutUrl: lead.checkoutUrl,
    checkoutExpiresAt: lead.checkoutExpiresAt,
    createdAt: lead.createdAt,
    referral: lead.referral,
    error: lead.error,
  });

  // ------------------------------------------------------------- the ledger poll

  /**
   * One cached read of the ledger's first page, correlated with your leads. The real cadence is
   * yours to choose (minutes, hours, nightly — guide §2.3); the demo keeps it short so the panel
   * feels live, and the cache keeps five open tabs from becoming five calls a second upstream.
   */
  let ledger = { items: [], fetchedAt: 0 };
  async function refreshLedger() {
    if (Date.now() - ledger.fetchedAt < ledgerCacheMs) return ledger.items;
    const page = await rv.listReferrals({ limit: 100 });
    ledger = { items: page.items, fetchedAt: Date.now() };
    const matched = store.applyLedger(page.items);
    if (matched > 0) logWire({ direction: "note", label: "ledger correlated", note: `${matched} referral(s) matched to leads` });
    return ledger.items;
  }

  let account = { data: null, fetchedAt: 0 };
  async function loadAccount() {
    if (account.data && Date.now() - account.fetchedAt < ACCOUNT_CACHE_MS) return account.data;
    const profile = await rv.me();
    // Only what the storefront needs — nothing operational, nothing secret.
    account = {
      data: { name: profile.name, slug: profile.slug, commissionPct: profile.commissionPct, referral: profile.referral },
      fetchedAt: Date.now(),
    };
    return account.data;
  }

  // ------------------------------------------------------------- handlers

  /**
   * Mint a checkout link server-side and hand the URL to the browser (guide §4.1). ONE lead =
   * ONE `externalReference` = one link, reused while it is still valid — a re-click never mints
   * a duplicate, and a lead that comes back after expiry gets a fresh one.
   */
  async function createCheckoutLink(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "Corpul cererii trebuie să fie JSON valid." });
    }
    // YOUR lead id — stable per lead, reused on a re-click.
    const leadId = String(body.leadId || `lead-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
    const lead = store.get(leadId) ?? store.create({
      leadId,
      property: {
        street: body.street,
        streetNumber: body.streetNumber,
        city: body.city,
        county: body.county || null,
        postalCode: body.postalCode || null,
        propertyType: body.propertyType || "apartment",
      },
    });
    if (store.hasLiveCheckoutLink(lead)) {
      logWire({ direction: "note", label: "checkout link reused", note: `${lead.checkoutLinkId} still valid` });
      return sendJson(res, 200, leadView(lead));
    }

    try {
      const link = await rv.createCheckoutLink({
        address: {
          street: lead.property.street,
          streetNumber: lead.property.streetNumber,
          city: lead.property.city,
          county: lead.property.county,
          postalCode: lead.property.postalCode,
        },
        propertyType: lead.property.propertyType,
        externalReference: lead.leadId,
        // Pre-fills the buyer's email on our checkout. Send it only where you have a lawful
        // basis to share it (guide §10.1) — the demo form never collects one.
        ...(body.customerEmail ? { customer: { email: body.customerEmail } } : {}),
      });
      store.attachCheckoutLink(lead, link);
      logWire({ direction: "note", label: "checkout link minted (201)", note: `${link.checkoutLinkId} · expiră ${link.expiresAt}` });
      return sendJson(res, 201, leadView(lead));
    } catch (error) {
      if (!(error instanceof RvApiError)) throw error;
      store.markMintFailed(lead, error);
      return sendUpstreamError(res, error, leadView(lead));
    }
  }

  async function getLead(res, leadId) {
    const lead = store.get(leadId);
    if (!lead) return sendJson(res, 404, { error: "Lead inexistent." });
    try {
      await refreshLedger();
    } catch (error) {
      // A failed ledger read must never break your own page: serve the last known state.
      if (!(error instanceof RvApiError)) throw error;
    }
    return sendJson(res, 200, leadView(lead));
  }

  async function listReferrals(res) {
    try {
      const items = await refreshLedger();
      return sendJson(res, 200, { items });
    } catch (error) {
      if (!(error instanceof RvApiError)) throw error;
      return sendUpstreamError(res, error);
    }
  }

  async function getAccount(res) {
    try {
      return sendJson(res, 200, await loadAccount());
    } catch (error) {
      if (!(error instanceof RvApiError)) throw error;
      return sendUpstreamError(res, error);
    }
  }

  async function serveStatic(res, pathname) {
    const name = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.join(PUBLIC_DIR, name);
    if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "forbidden" });
    try {
      const content = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Content-Length": content.length });
      return res.end(content);
    } catch {
      return sendJson(res, 404, { error: "not found" });
    }
  }

  // ------------------------------------------------------------- routing

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const { pathname } = url;
    const leadMatch = /^\/api\/leads\/([^/]+)$/.exec(pathname);

    const route = async () => {
      if (req.method === "POST" && pathname === "/api/checkout-links") return createCheckoutLink(req, res);
      if (req.method === "GET" && leadMatch) return getLead(res, decodeURIComponent(leadMatch[1]));
      if (req.method === "GET" && pathname === "/api/referrals") return listReferrals(res);
      if (req.method === "GET" && pathname === "/api/account") return getAccount(res);
      if (req.method === "GET" && pathname === "/api/wire-log") return sendJson(res, 200, { entries: wireLog });
      if (req.method === "GET" && pathname === "/api/config") {
        return sendJson(res, 200, {
          mode: config.mockMode ? "mock" : "remote",
          apiBaseUrl: config.baseUrl, // the key itself is never exposed
        });
      }
      if (req.method === "GET") return serveStatic(res, pathname);
      return sendJson(res, 405, { error: "method not allowed" });
    };

    route().catch((error) => {
      console.error("[partner-backend] unhandled error", error);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });

  server.store = store;
  server.wireLog = wireLog;
  return server;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  let config;
  try {
    config = resolveConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`\n  Configuration problem — the server did not start.\n\n  ${error.message}\n`);
    process.exit(1);
  }
  const server = createPartnerServer(config);
  server.listen(config.port, () => {
    console.log(`
┌──────────────────────────────────────────────────────────────────────────────┐
│  Partner demo backend — ResidenceVertical Partner API reference integration  │
└──────────────────────────────────────────────────────────────────────────────┘
  Demo site        http://localhost:${config.port}
  Mode             ${config.mockMode ? "MOCK — talking to the bundled mock-rv-api.js" : "REMOTE — talking to a real ResidenceVertical environment"}
  Partner API      ${config.baseUrl}/api/partner/v1
  API key          ${config.apiKey.slice(0, 13)}…  (server-side only, never sent to the browser)
  Ledger poll      GET /referrals, cached ${config.ledgerCacheMs} ms (RV_LEDGER_CACHE_MS)
`);
  });
}
