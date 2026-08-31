#!/usr/bin/env node
/**
 * The PARTNER's backend — this is the part you actually adapt.
 *
 * It shows the whole integration in one small file:
 *   POST /api/orders             your user clicks "Generează raportul" → we create ONE report
 *                                request, using YOUR order id as the `Idempotency-Key` and as
 *                                `externalReference`.
 *   GET  /api/orders/:orderId    your own status endpoint. Your browser polls YOU; YOU poll
 *                                ResidenceVertical (with a small cache, so a page with 5 open
 *                                tabs does not become 5 calls/second upstream).
 *   GET  /api/orders/:orderId/pdf  proxies our bytes to your user — the API key never reaches a
 *                                browser, and `downloadUrl` is never hotlinked.
 *   POST /api/orders/:orderId/view-link  re-mints the signed link to the report WEB PAGE when the
 *                                one you stored has expired. The page itself is opened by your
 *                                user's browser straight from `viewUrl` — no key, no proxy.
 *   POST /api/checkout-links     REFERRAL mode's recommended tier: mints a server-attributed
 *                                checkout link for the property (one API call, your lead id as
 *                                `externalReference`) and hands the `/c/<token>` URL to the
 *                                browser — the buyer pays ResidenceVertical directly and you
 *                                earn commission per generated report.
 *   POST /webhooks/residencevertical  signed delivery: verify → de-duplicate → 2xx immediately.
 *
 * Run it against the bundled mock (default) or against gamma — one env switch, no code change:
 *   node server.js
 *   RV_API_BASE_URL=https://gamma.residencevertical.ro RV_API_KEY=rvp_test_… \
 *     RV_WEBHOOK_SECRET=whsec_… node server.js
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRvClient, RvApiError } from "./lib/rvClient.js";
import { verify as verifyWebhookSignature } from "./lib/webhookSignature.js";
import { createOrderStore } from "./lib/store.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const STATUS_CACHE_MS = 3_000;
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
      + `      RV_API_BASE_URL=${baseUrl} RV_API_KEY=rvp_test_… RV_WEBHOOK_SECRET=whsec_… node server.js\n`
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
    webhookSecret: env.RV_WEBHOOK_SECRET ?? (mockMode ? "whsec_local_mock_secret" : null),
    port: Number(env.PORT ?? 4000),
    statusCacheMs: Number(env.RV_STATUS_CACHE_MS ?? STATUS_CACHE_MS),
  };
}

export function createPartnerServer(config) {
  const statusCacheMs = config.statusCacheMs ?? STATUS_CACHE_MS;
  const store = createOrderStore();
  const wireLog = [];
  const pdfCache = new Map(); // orderId -> {buffer, filename} — "download once, serve many times"

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

  const readRawBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  /**
   * Your own view of an order — never leak our internals or the key to the browser.
   *
   * Two deliverables reach your user once the report is generated:
   *   `viewUrl`      the signed ResidenceVertical web page. Safe to hand to a browser as-is: it
   *                  carries no API key, only a signature bound to this one report. Put it behind
   *                  your "Vezi raportul" button.
   *   `downloadPath` YOUR route, which proxies our PDF bytes. The PDF endpoint on our side needs
   *                  your key, so it is fetched server-side and never hotlinked.
   */
  const orderView = (order) => ({
    orderId: order.orderId,
    property: order.property,
    status: order.status,
    failureReason: order.failureReason,
    reportRequestId: order.reportRequestId,
    reportId: order.reportId,
    createdAt: order.createdAt,
    generatedAt: order.generatedAt,
    notifiedBy: order.notifiedBy,
    error: order.error,
    viewUrl: order.viewUrl,
    viewExpiresAt: order.viewExpiresAt,
    downloadPath: order.status === "generated" ? `/api/orders/${order.orderId}/pdf` : null,
  });

  // ------------------------------------------------------------- handlers

  async function createOrder(req, res) {
    const raw = await readRawBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      return sendJson(res, 400, { error: "Corpul cererii trebuie să fie JSON valid." });
    }

    // YOUR id. One click = one order id = one Idempotency-Key = one report, forever.
    const orderId = String(body.orderId || `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
    const existing = store.get(orderId);
    const order = existing ?? store.create({
      orderId,
      property: {
        street: body.street,
        streetNumber: body.streetNumber,
        city: body.city,
        county: body.county || null,
        postalCode: body.postalCode || null,
        propertyType: body.propertyType || "apartment",
        residentialComplex: body.residentialComplex || null,
        priceEur: body.priceEur ?? null,
        surfaceSqm: body.surfaceSqm ?? null,
      },
    });

    try {
      const { report, replayed } = await rv.createReport({
        address: {
          street: order.property.street,
          streetNumber: order.property.streetNumber,
          city: order.property.city,
          county: order.property.county,
          postalCode: order.property.postalCode,
        },
        propertyType: order.property.propertyType,
        residentialComplex: order.property.residentialComplex,
        // Send `customer.email` ONLY when you want ResidenceVertical to email the buyer the PDF
        // as well. Omitted here: this demo delivers the PDF itself.
        externalReference: order.orderId,
      }, { idempotencyKey: order.orderId });

      store.applyReportStatus(order, report, { source: "polling" });
      logWire({ direction: "note", label: replayed ? "idempotent replay (200)" : "report request created (202)", note: report.reportRequestId });
      return sendJson(res, 201, orderView(order));
    } catch (error) {
      if (!(error instanceof RvApiError)) throw error;
      store.markCreateFailed(order, error);
      // Surface the machine-readable code to your own UI; never the raw upstream message.
      return sendJson(res, 502, { ...orderView(order), error: { code: error.code, message: error.message, requestId: error.requestId } });
    }
  }

  async function getOrder(res, orderId) {
    const order = store.get(orderId);
    if (!order) return sendJson(res, 404, { error: "Comandă inexistentă." });

    const terminal = order.status === "generated" || order.status === "failed";
    const fresh = Date.now() - order.lastPolledAt < statusCacheMs;
    if (order.reportRequestId && !terminal && !fresh) {
      try {
        store.applyReportStatus(order, await rv.getReport(order.reportRequestId), { source: "polling" });
      } catch (error) {
        // A failed status refresh must never break your own page: serve the last known state.
        if (!(error instanceof RvApiError)) throw error;
        order.lastPolledAt = Date.now();
      }
    }
    return sendJson(res, 200, orderView(order));
  }

  /**
   * "The link expired — give me a new one."
   *
   * A view link lives 30 days by default, and your order row outlives it. Rather than caching a
   * URL forever (or hiding the button once it lapses), re-mint on demand: this is one call, it
   * costs nothing, and older links keep working until their own expiry.
   */
  async function reissueViewLink(res, orderId) {
    const order = store.get(orderId);
    if (!order) return sendJson(res, 404, { error: "Comandă inexistentă." });
    if (order.status !== "generated" || !order.reportRequestId) {
      return sendJson(res, 409, { error: "Raportul nu este încă disponibil.", status: order.status });
    }
    try {
      const link = await rv.createViewLink(order.reportRequestId);
      order.viewUrl = link.viewUrl;
      order.viewExpiresAt = link.viewExpiresAt;
      logWire({ direction: "note", label: "view link re-emis", note: `expiră ${link.viewExpiresAt}` });
      return sendJson(res, 200, orderView(order));
    } catch (error) {
      if (!(error instanceof RvApiError)) throw error;
      return sendJson(res, 502, { error: "Nu am putut emite un link nou.", code: error.code, requestId: error.requestId });
    }
  }

  async function getOrderPdf(res, orderId) {
    const order = store.get(orderId);
    if (!order) return sendJson(res, 404, { error: "Comandă inexistentă." });
    if (order.status !== "generated") {
      return sendJson(res, 409, { error: "Raportul nu este încă disponibil.", status: order.status });
    }
    try {
      if (!pdfCache.has(orderId)) {
        // Download once, cache, serve every later view from your own storage.
        pdfCache.set(orderId, await rv.getReportPdf(order.reportRequestId));
      }
      const pdf = pdfCache.get(orderId);
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdf.filename}"`,
        "Content-Length": pdf.buffer.length,
      });
      return res.end(pdf.buffer);
    } catch (error) {
      if (!(error instanceof RvApiError)) throw error;
      return sendJson(res, 502, { error: "Descărcarea raportului a eșuat.", code: error.code, requestId: error.requestId });
    }
  }

  /**
   * REFERRAL mode, recommended tier (guide §2.1): mint a checkout link server-side and hand the
   * URL to the browser. The buyer opens it and pays ResidenceVertical directly — this backend is
   * out of the payment path entirely; its only job is the ONE mint call, keyed by YOUR lead id
   * (`externalReference`), which later identifies the conversion on `GET /referrals`.
   */
  async function createCheckoutLink(req, res) {
    const raw = await readRawBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      return sendJson(res, 400, { error: "Corpul cererii trebuie să fie JSON valid." });
    }
    // YOUR lead id — one per lead, reused on a re-click, exactly like the order id above.
    const leadId = String(body.leadId || `lead-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
    try {
      const link = await rv.createCheckoutLink({
        address: {
          street: body.street,
          streetNumber: body.streetNumber,
          city: body.city,
          county: body.county || null,
          postalCode: body.postalCode || null,
        },
        propertyType: body.propertyType || "apartment",
        externalReference: leadId,
        ...(body.customerEmail ? { customer: { email: body.customerEmail } } : {}),
      });
      logWire({ direction: "note", label: "checkout link minted (201)", note: `${link.checkoutLinkId} · expiră ${link.expiresAt}` });
      // The URL is safe for the browser: it carries no API key — the token IS the link.
      return sendJson(res, 201, {
        checkoutLinkId: link.checkoutLinkId,
        url: link.url,
        expiresAt: link.expiresAt,
        externalReference: link.externalReference,
      });
    } catch (error) {
      if (!(error instanceof RvApiError)) throw error;
      return sendJson(res, 502, { error: { code: error.code, message: error.message, requestId: error.requestId } });
    }
  }

  /** The webhook endpoint. Verify the RAW bytes, de-duplicate, answer 2xx fast. */
  async function receiveWebhook(req, res) {
    const rawBody = await readRawBody(req);
    if (!config.webhookSecret || !verifyWebhookSignature(rawBody, req.headers, config.webhookSecret)) {
      logWire({ direction: "in", label: "POST /webhooks/residencevertical", status: 401, note: "signature invalid — rejected" });
      return sendJson(res, 401, { error: "invalid signature" });
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }

    const deliveryId = req.headers["x-rv-delivery-id"] ?? event.deliveryId;
    if (store.isDuplicateDelivery(deliveryId)) {
      logWire({ direction: "in", label: `webhook ${event.event}`, status: 200, note: `duplicate deliveryId ignored (${deliveryId})` });
      return sendJson(res, 200, { received: true, duplicate: true });
    }

    // `data` is exactly the GET /reports/{id} representation — no follow-up call needed.
    const order = store.getByReportRequestId(event.data?.reportRequestId)
      ?? store.get(event.data?.externalReference); // correlate by YOUR id when we have not stored theirs yet
    if (order) {
      store.applyReportStatus(order, event.data, { source: "webhook" });
      order.lastDeliveryId = deliveryId;
    }
    logWire({
      direction: "in",
      label: `webhook ${event.event}`,
      status: 200,
      note: `${order ? `order ${order.orderId}` : "unknown order"} · deliveryId ${deliveryId}`,
    });
    // Answer immediately; anything slow (PDF download, email) belongs in a background job.
    return sendJson(res, 200, { received: true });
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
    const orderMatch = /^\/api\/orders\/([^/]+)(\/pdf|\/view-link)?$/.exec(pathname);

    const route = async () => {
      if (req.method === "POST" && pathname === "/api/orders") return createOrder(req, res);
      if (req.method === "POST" && pathname === "/api/checkout-links") return createCheckoutLink(req, res);
      if (req.method === "POST" && orderMatch && orderMatch[2] === "/view-link") {
        return reissueViewLink(res, orderMatch[1]);
      }
      if (req.method === "GET" && orderMatch && orderMatch[2] !== "/view-link") {
        return orderMatch[2] ? getOrderPdf(res, orderMatch[1]) : getOrder(res, orderMatch[1]);
      }
      if (req.method === "POST" && pathname === "/webhooks/residencevertical") return receiveWebhook(req, res);
      if (req.method === "GET" && pathname === "/api/wire-log") return sendJson(res, 200, { entries: wireLog });
      if (req.method === "GET" && pathname === "/api/config") {
        return sendJson(res, 200, {
          mode: config.mockMode ? "mock" : "remote",
          apiBaseUrl: config.baseUrl, // the key itself is never exposed
          webhookVerification: Boolean(config.webhookSecret),
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
  Webhook endpoint POST http://localhost:${config.port}/webhooks/residencevertical`
      + `${config.webhookSecret ? " (signature verification ON)" : " (NO RV_WEBHOOK_SECRET — deliveries will be rejected; polling still works)"}
`);
  });
}
