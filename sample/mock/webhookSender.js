/**
 * MOCK ONLY (throw this file away) — outbound signed webhook delivery, mirroring
 * `PartnerWebhookDispatcher` in payment-service.
 *
 * What it reproduces faithfully (this is what your endpoint has to cope with):
 *   - body      `{event, deliveryId, sentAt, data:<status representation>}`
 *   - headers   `X-RV-Event`, `X-RV-Delivery-Id`, `X-RV-Timestamp` (unix seconds),
 *               `X-RV-Signature: v1=<hex hmac_sha256(secret, "<timestamp>.<raw body>")>`,
 *               `User-Agent: ResidenceVertical-Webhooks/1.0`
 *   - deliveryId is a UUID v3 of `(reportRequestId, event)` — byte-identical to production and
 *     STABLE across retries of the same event, so it is your de-duplication key.
 *   - retries   6 attempts in total (initial + ~1m, 5m, 15m, 1h, 3h). Each attempt is signed
 *     with a FRESH timestamp, so the signature changes between retries while deliveryId does not.
 *   - redirects are never followed: a 3xx counts as a failed attempt.
 */
import { createHash, createHmac } from "node:crypto";

export const USER_AGENT = "ResidenceVertical-Webhooks/1.0";
/** Production schedule, in ms after the previous attempt. */
export const DEFAULT_RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 10_800_000];

/** Java's `UUID.nameUUIDFromBytes` (MD5, version 3) — same id production would mint. */
export function nameUuid(name) {
  const bytes = createHash("md5").update(name, "utf8").digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deliveryIdFor(reportRequestId, event) {
  return nameUuid(`rv-webhook:${reportRequestId}:${event}`);
}

export function signatureHeader(secret, timestampSeconds, rawBody) {
  return `v1=${createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex")}`;
}

export function createWebhookSender({
  secret,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  timeoutMs = 10_000,
  log = () => {},
  fetchImpl = fetch,
} = {}) {
  const timers = new Set();

  async function attempt(target, attemptNumber) {
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-RV-Event": target.event,
      "X-RV-Delivery-Id": target.deliveryId,
      "X-RV-Timestamp": String(timestamp),
    };
    if (secret) headers["X-RV-Signature"] = signatureHeader(secret, timestamp, target.body);
    try {
      const response = await fetchImpl(target.url, {
        method: "POST",
        headers,
        body: target.body,
        redirect: "manual", // a 3xx is a FAILED attempt, never followed
        signal: AbortSignal.timeout(timeoutMs),
      });
      const delivered = response.status >= 200 && response.status < 300;
      log(`webhook ${target.event} attempt ${attemptNumber} -> HTTP ${response.status}`
        + `${delivered ? " (delivered)" : " (will retry)"} deliveryId=${target.deliveryId}`);
      return delivered;
    } catch (error) {
      log(`webhook ${target.event} attempt ${attemptNumber} failed: ${error.message}`);
      return false;
    }
  }

  async function run(target, attemptNumber) {
    if (await attempt(target, attemptNumber)) return;
    const delay = retryDelaysMs[attemptNumber - 1];
    if (delay === undefined) {
      log(`webhook ${target.event} abandoned after ${attemptNumber} attempts `
        + `deliveryId=${target.deliveryId} (the report itself is unaffected — poll GET /reports/{id})`);
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      void run(target, attemptNumber + 1);
    }, delay);
    timer.unref?.();
    timers.add(timer);
  }

  return {
    /** Fire-and-forget, exactly like the server-side sweeper. */
    send({ url, event, reportRequestId, data }) {
      if (!url) return null;
      const deliveryId = deliveryIdFor(reportRequestId, event);
      const body = JSON.stringify({ event, deliveryId, sentAt: new Date().toISOString(), data });
      void run({ url, event, deliveryId, body }, 1);
      return deliveryId;
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
