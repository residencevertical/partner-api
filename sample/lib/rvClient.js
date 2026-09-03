/**
 * ResidenceVertical Partner API client — COPY THIS FILE into your project (adapt the logging).
 *
 * Zero dependencies: global `fetch` and `AbortSignal.timeout` only (Node ≥ 20).
 *
 * What it gives you:
 *   - `createCheckoutLink(body)` → a prefilled `/c/<token>` checkout link for ONE lead — the
 *     buyer pays ResidenceVertical directly and you earn the commission
 *   - `listReferrals({ limit, offset })` → your referral ledger, the surface you poll to learn
 *     which leads converted
 *   - `me()` → your account: commission, the `/p/<slug>` link, running totals
 *   - every non-2xx becomes an `RvApiError` carrying `status`, `code`, `message`, `fields`
 *     and `requestId` (the `X-RV-Request-Id` support asks for)
 *   - a retry policy that matches the documented semantics (see RETRIES below)
 *
 * RETRIES — what is safe to retry, and why
 * ----------------------------------------
 *   429 (edge rate limit)     honours `Retry-After`, but ONLY when the wait fits inside
 *                             `maxRetryDelayMs`; a longer wait is surfaced to the caller instead.
 *   503 `partner_api_disabled`
 *                             transient by definition. Honours `Retry-After`, again bounded by
 *                             `maxRetryDelayMs`.
 *   network errors / timeouts / 5xx without a JSON body → retried.
 *   Everything else (400, 401, 403, 404, 410) is a decision you have to make differently —
 *   retrying an unchanged request would just fail again.
 *
 *   Retrying a checkout-link mint is always safe: at worst it mints a SECOND link for the same
 *   lead, and either one attributes the sale to you with the same `externalReference`.
 */

const RETRYABLE_CODES = new Set(["partner_api_disabled"]);

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
    return this.status === 0 || this.status === 429 || this.status >= 500;
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
 * @param {number} [options.timeoutMs]    per attempt (default 20 s)
 * @param {number} [options.maxAttempts]  total attempts per call, retryable failures only
 * @param {number} [options.maxRetryDelayMs] never sleep longer than this between attempts
 * @param {(exchange: object) => void} [options.onExchange] called once per HTTP exchange (logging)
 */
export function createRvClient({
  baseUrl,
  apiKey,
  timeoutMs = 20_000,
  maxAttempts = 3,
  maxRetryDelayMs = 10_000,
  fetchImpl = fetch,
  onExchange = () => {},
} = {}) {
  if (!baseUrl) throw new Error("createRvClient: baseUrl is required");
  if (!apiKey) throw new Error("createRvClient: apiKey is required");
  const root = `${String(baseUrl).replace(/\/+$/, "")}/api/partner/v1`;

  async function request(method, path, { body, headers = {} } = {}) {
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
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        // Network error / timeout: we do not know whether it reached us. Every call this client
        // makes is safe to repeat (see RETRIES above), so try again.
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
        const data = await readJson(response);
        onExchange({ method, path, status: response.status, requestId, attempt, durationMs: Date.now() - startedAt });
        return { data, status: response.status, requestId };
      }

      const error = await readError(response, requestId, retryAfterSeconds);
      onExchange({
        method, path, status: response.status, code: error.code, requestId, attempt,
        durationMs: Date.now() - startedAt,
      });

      const canRetry = attempt < maxAttempts && isRetryable(response.status, error.code);
      if (!canRetry) throw error;

      // A `Retry-After` we cannot honour inside our budget is not a retry — it is a scheduling
      // decision for the caller. Our OWN backoff is always inside the budget by construction.
      if (retryAfterSeconds !== undefined && retryAfterSeconds * 1000 > maxRetryDelayMs) throw error;
      await sleep(retryAfterSeconds === undefined ? backoffMs(attempt, maxRetryDelayMs) : retryAfterSeconds * 1000);
      lastError = error;
    }
    throw lastError;
  }

  return {
    /**
     * POST /checkout-links (guide §4.1): mint a prefilled, server-attributed checkout link for
     * ONE lead. Put the returned `url` behind your button; the buyer opens it and pays on the
     * ResidenceVertical checkout — you never touch the payment. The link is REUSABLE until
     * `expiresAt` (default 48 h; `expiresInHours` 1..720), and your `externalReference` (your
     * lead id) comes back per referral on `GET /referrals` — that is the per-lead tracking.
     *
     * @returns {Promise<{checkoutLinkId: string, url: string, expiresAt: string, externalReference: string|null}>}
     */
    async createCheckoutLink(body) {
      const { data } = await request("POST", "/checkout-links", { body });
      return data;
    },

    /**
     * GET /referrals?limit=&offset= (guide §4.2) — newest first, `count` is this page only.
     * This is how you learn a lead converted: match `externalReference` against the ids you
     * minted with; `status` is pending → earned, or void.
     */
    async listReferrals({ limit, offset } = {}) {
      const query = new URLSearchParams();
      if (limit !== undefined) query.set("limit", String(limit));
      if (offset !== undefined) query.set("offset", String(offset));
      const suffix = query.toString() ? `?${query}` : "";
      const { data } = await request("GET", `/referrals${suffix}`);
      return data;
    },

    /** GET /me — profile, commission, the referral block. The cheapest way to verify a key. */
    async me() {
      const { data } = await request("GET", "/me");
      return data;
    },
  };
}

function isRetryable(status, code) {
  if (status === 429) return true;
  if (status === 503) return RETRYABLE_CODES.has(code) || code.startsWith("http_");
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
