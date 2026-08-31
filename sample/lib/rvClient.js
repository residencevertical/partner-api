/**
 * ResidenceVertical Partner API client — COPY THIS FILE into your project (adapt the logging).
 *
 * Zero dependencies: global `fetch`, `AbortSignal.timeout` and `node:buffer` only (Node ≥ 20).
 *
 * What it gives you:
 *   - `createReport(body, { idempotencyKey })` → 202 create / 200 idempotent replay
 *   - `getReport(id)` / `listReports()` / `me()`
 *   - `getReportPdf(id)` → `{ buffer, filename, contentType }`
 *   - `createViewLink(id)` → a fresh signed link to the report's WEB PAGE, for your end user
 *   - `createCheckoutLink(body)` → a prefilled `/c/<token>` checkout link (referral mode's
 *     recommended tier) — the buyer pays ResidenceVertical directly
 *   - every non-2xx becomes an `RvApiError` carrying `status`, `code`, `message`, `fields`
 *     and `requestId` (the `X-RV-Request-Id` support asks for)
 *   - a retry policy that matches the documented semantics (see RETRIES below)
 *
 * RETRIES — what is safe to retry, and why
 * ----------------------------------------
 *   429 `daily_cap_exceeded`  honours `Retry-After`, but ONLY when the wait fits inside
 *                             `maxRetryDelayMs`. A daily cap's `Retry-After` is "seconds until
 *                             midnight" — never sleep on that; surface it to your queue instead.
 *   503 `maintenance` /       transient by definition. Honours `Retry-After` (60 s on maintenance),
 *       `partner_api_disabled` again bounded by `maxRetryDelayMs`.
 *   502 `report_service_unavailable`
 *                             retried with the SAME `Idempotency-Key`. This is safe and documented:
 *                             a request answered with this error does NOT consume the key, so the
 *                             retry creates a FRESH attempt (it does not replay the failure) and
 *                             you are not billed twice.
 *   network errors / timeouts / 5xx without a JSON body → retried.
 *   Everything else (400, 401, 403, 404, 409, 502 `geocoding_failed`) is a decision you have to
 *   make differently — retrying an unchanged request would just fail again.
 */
import { Buffer } from "node:buffer";

const RETRYABLE_CODES = new Set(["report_service_unavailable", "maintenance", "partner_api_disabled"]);

export class RvApiError extends Error {
  constructor({ status, code, message, fields, requestId, retryAfterSeconds }) {
    super(message || `ResidenceVertical Partner API error (HTTP ${status})`);
    this.name = "RvApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** True when a later, identical attempt could plausibly succeed. */
  get retryable() {
    if (this.status === 429 || this.status >= 500) {
      return this.code !== "geocoding_failed";
    }
    return false;
  }

  toString() {
    return `${this.name}: ${this.status} ${this.code ?? "-"} — ${this.message}`
      + `${this.requestId ? ` [X-RV-Request-Id: ${this.requestId}]` : ""}`;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {string} options.baseUrl        e.g. `https://gamma.residencevertical.ro`
 * @param {string} options.apiKey         `rvp_test_…` / `rvp_live_…` — SERVER SIDE ONLY
 * @param {number} [options.timeoutMs]    per attempt (default 20 s; 60 s for PDF downloads)
 * @param {number} [options.maxAttempts]  total attempts per call, retryable failures only
 * @param {number} [options.maxRetryDelayMs] never sleep longer than this between attempts
 * @param {(exchange: object) => void} [options.onExchange] called once per HTTP exchange (logging)
 */
export function createRvClient({
  baseUrl,
  apiKey,
  timeoutMs = 20_000,
  pdfTimeoutMs = 60_000,
  maxAttempts = 3,
  maxRetryDelayMs = 10_000,
  fetchImpl = fetch,
  onExchange = () => {},
} = {}) {
  if (!baseUrl) throw new Error("createRvClient: baseUrl is required");
  if (!apiKey) throw new Error("createRvClient: apiKey is required");
  const root = `${String(baseUrl).replace(/\/+$/, "")}/api/partner/v1`;

  async function request(method, path, { body, headers = {}, expect = "json", timeout = timeoutMs } = {}) {
    const url = `${root}${path}`;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            // The key never leaves your backend. It is not logged by onExchange either.
            Authorization: `Bearer ${apiKey}`,
            Accept: expect === "pdf" ? "application/pdf" : "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
      } catch (cause) {
        // Network error / timeout: we do not know whether it reached us — replaying the same
        // Idempotency-Key is exactly what makes this safe.
        lastError = new RvApiError({
          status: 0,
          code: cause.name === "TimeoutError" ? "timeout" : "network_error",
          message: `${method} ${path} failed: ${cause.message}`,
        });
        onExchange({ method, path, status: 0, code: lastError.code, attempt, durationMs: Date.now() - startedAt });
        if (attempt < maxAttempts) {
          await sleep(backoffMs(attempt, maxRetryDelayMs));
          continue;
        }
        throw lastError;
      }

      const requestId = response.headers.get("x-rv-request-id") ?? undefined;
      const retryAfterSeconds = numberOrUndefined(response.headers.get("retry-after"));

      if (response.ok) {
        const result = expect === "pdf" ? await readPdf(response) : await readJson(response);
        onExchange({
          method, path, status: response.status, requestId, attempt,
          durationMs: Date.now() - startedAt,
          note: expect === "pdf" ? `${result.buffer.length} bytes` : undefined,
        });
        return { ...(expect === "pdf" ? { pdf: result } : { data: result }), status: response.status, requestId };
      }

      const error = await readError(response, requestId, retryAfterSeconds);
      onExchange({
        method, path, status: response.status, code: error.code, requestId, attempt,
        durationMs: Date.now() - startedAt,
      });

      const canRetry = attempt < maxAttempts && isRetryable(response.status, error.code);
      if (!canRetry) throw error;

      // A `Retry-After` we cannot honour inside our budget (e.g. "wait until midnight" on a daily
      // cap) is not a retry — it is a scheduling decision for the caller. Our OWN backoff is
      // always inside the budget by construction.
      if (retryAfterSeconds !== undefined && retryAfterSeconds * 1000 > maxRetryDelayMs) throw error;
      await sleep(retryAfterSeconds === undefined ? backoffMs(attempt, maxRetryDelayMs) : retryAfterSeconds * 1000);
      lastError = error;
    }
    throw lastError;
  }

  return {
    /** POST /reports — 202 fresh, 200 idempotent replay. Always send an `idempotencyKey`. */
    async createReport(body, { idempotencyKey } = {}) {
      const { data, status, requestId } = await request("POST", "/reports", {
        body,
        headers: idempotencyKey ? { "Idempotency-Key": String(idempotencyKey) } : {},
      });
      return { report: data, replayed: status === 200, requestId };
    },

    /** GET /reports/{id} — poll every 5–10 s; `status` is processing | generated | failed. */
    async getReport(reportRequestId) {
      const { data } = await request("GET", `/reports/${encodeURIComponent(reportRequestId)}`);
      return data;
    },

    /**
     * POST /reports/{id}/view-link — a FRESH signed link to the report's web page.
     *
     * You normally do not need this: a generated report already carries `viewUrl` on the status
     * and in the `report.generated` webhook. Call it when the link you stored has expired
     * (`viewExpiresAt` is in the past), which is the whole operational pattern — store the link,
     * re-mint on demand. `409 report_not_ready` before the report is generated.
     *
     * @returns {Promise<{reportRequestId: string, viewUrl: string, viewExpiresAt: string}>}
     */
    async createViewLink(reportRequestId) {
      const { data } = await request("POST", `/reports/${encodeURIComponent(reportRequestId)}/view-link`);
      return data;
    },

    /** GET /reports/{id}/pdf — 409 `report_not_ready` before the report is generated. */
    async getReportPdf(reportRequestId) {
      const { pdf } = await request("GET", `/reports/${encodeURIComponent(reportRequestId)}/pdf`, {
        expect: "pdf",
        timeout: pdfTimeoutMs,
      });
      return {
        ...pdf,
        filename: pdf.filename ?? `raport-imobiliar-${reportRequestId}.pdf`,
      };
    },

    /** GET /reports?status=&limit=&offset= — newest first, `count` is this page only. */
    async listReports({ status, limit, offset } = {}) {
      const query = new URLSearchParams();
      if (status) query.set("status", status);
      if (limit !== undefined) query.set("limit", String(limit));
      if (offset !== undefined) query.set("offset", String(offset));
      const suffix = query.toString() ? `?${query}` : "";
      const { data } = await request("GET", `/reports${suffix}`);
      return data;
    },

    /**
     * POST /checkout-links — referral mode's RECOMMENDED tier (guide §2.1): mint a prefilled,
     * server-attributed checkout link for ONE property. Put the returned `url` behind your
     * button; the buyer opens it and pays on the ResidenceVertical checkout — you never touch
     * the payment. The link is REUSABLE until `expiresAt` (default 48 h; `expiresInHours`
     * 1..720), and your `externalReference` (your lead id) comes back per referral on
     * `GET /referrals` — that is the per-lead conversion tracking.
     *
     * @returns {Promise<{checkoutLinkId: string, url: string, expiresAt: string, externalReference: string|null}>}
     */
    async createCheckoutLink(body) {
      const { data } = await request("POST", "/checkout-links", { body });
      return data;
    },

    /** GET /me — profile, commission, daily cap, usage. The cheapest way to verify a key. */
    async me() {
      const { data } = await request("GET", "/me");
      return data;
    },
  };
}

function isRetryable(status, code) {
  if (status === 429 || status === 503) return true;
  if (status === 502) return RETRYABLE_CODES.has(code); // never `geocoding_failed`
  return status >= 500 && status !== 501;
}

/** Exponential backoff with jitter — clamped AFTER the jitter, so it never exceeds the budget. */
function backoffMs(attempt, maxDelayMs) {
  const base = Math.min(500 * 2 ** (attempt - 1), maxDelayMs);
  return Math.min(Math.round(base * (0.75 + Math.random() * 0.5)), maxDelayMs);
}

function numberOrUndefined(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new RvApiError({
      status: response.status,
      code: "invalid_response",
      message: "Expected JSON from the Partner API but the body could not be parsed.",
      requestId: response.headers.get("x-rv-request-id") ?? undefined,
    });
  }
}

async function readPdf(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return {
    buffer,
    filename: match ? match[1] : undefined,
    contentType: response.headers.get("content-type") ?? "application/pdf",
  };
}

/** Every documented failure is `{"error":{"code","message"[,"fields"]}}`; anything else is edge. */
async function readError(response, requestId, retryAfterSeconds) {
  const text = await response.text().catch(() => "");
  let envelope;
  try {
    envelope = text ? JSON.parse(text) : null;
  } catch {
    envelope = null;
  }
  const error = envelope?.error;
  return new RvApiError({
    status: response.status,
    code: error?.code ?? `http_${response.status}`,
    message: error?.message
      ?? `ResidenceVertical Partner API returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    fields: error?.fields,
    requestId,
    retryAfterSeconds,
  });
}
