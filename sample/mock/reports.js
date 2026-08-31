/**
 * MOCK ONLY (throw this file away) — the in-memory report ledger behind the mock API:
 * lifecycle (`processing` → `generated` / `failed`), the exact wire representation
 * (`PartnerReportRepresentation`), the address-driven test hooks and the webhook arming.
 */
import { randomUUID } from "node:crypto";
import { createWebhookSender } from "./webhookSender.js";
import { issue as issueViewToken, verify as verifyViewToken } from "./viewTokens.js";

/** Test hooks — matched as WHOLE WORDS (case-insensitive) in `address.street`. */
export const HOOK_KEYWORDS = ["Fail", "Slow", "Cap", "Maintenance", "Boom", "Geo"];

export function hooksFor(street) {
  const value = String(street ?? "");
  return new Set(HOOK_KEYWORDS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(value)));
}

/** Deterministic stand-in for the real Google geocode (inside Romania's bounding box). */
export function fakeGeocode(query) {
  let hash = 0;
  for (const char of String(query)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const lat = 43.65 + ((hash % 4600) / 1000);
  const lng = 20.30 + (((hash >>> 8) % 9300) / 1000);
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

/** Seconds until the next Europe/Bucharest midnight — what `Retry-After` carries on a 429 cap. */
export function secondsUntilBucharestMidnight(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bucharest", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return 86_400 - (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second));
}

function bucharestDay(instant) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest" }).format(instant);
}

export function createReportStore({
  reportSeconds = 20,
  publicBaseUrl = "http://localhost:4010",
  webhookUrl = null,
  webhookSecret = null,
  webhookRetryDelaysMs,
  viewTokenSecret = "mock-view-token-secret",
  viewLinkTtlSeconds = 30 * 24 * 3600,
  log = () => {},
} = {}) {
  const reports = new Map();      // reportRequestId -> row
  const byIdempotency = new Map(); // Idempotency-Key -> {requestHash, reportRequestId}
  // The ACCOUNT webhook URL. On the real platform this is configured by the ResidenceVertical
  // team and can change at any time; each row snapshots it at creation, so a change only ever
  // affects NEW requests.
  let accountWebhookUrl = webhookUrl;
  const sender = createWebhookSender({ secret: webhookSecret, retryDelaysMs: webhookRetryDelaysMs, log });
  const timers = new Set();

  /**
   * A fresh view link for a row — minted at RENDER time, exactly like the real service, so every
   * status read and every `report.generated` webhook (including a retry of one) hands out a
   * full-lifetime link rather than a stale one.
   */
  function viewLinkFor(row) {
    const { token, expiresAt } = issueViewToken(viewTokenSecret, row.id, viewLinkTtlSeconds);
    return { token, expiresAt, viewUrl: `${publicBaseUrl}/raport/${row.id}?t=${token}` };
  }

  /** The §4.2 status representation — field-for-field (and in the same order) as the real API. */
  function toRepresentation(row) {
    const representation = {
      reportRequestId: row.id,
      reportId: row.reportId,
      status: row.status,
      failureReason: row.failureReason,
      createdAt: row.createdAt,
      generatedAt: row.generatedAt,
      downloadUrl: row.status === "generated" ? `${publicBaseUrl}/api/partner/v1/reports/${row.id}/pdf` : null,
    };
    // `viewUrl` + `viewExpiresAt` exist only for a GENERATED report: a processing or failed one
    // has no web page, so the keys are ABSENT rather than null. Never assume they are there.
    if (row.status === "generated") {
      const link = viewLinkFor(row);
      representation.viewUrl = link.viewUrl;
      representation.viewExpiresAt = link.expiresAt;
    }
    return {
      ...representation,
      externalReference: row.externalReference,
      address: { ...row.address },
      coordinates: row.coordinates,
      propertyType: row.propertyType,
    };
  }

  /** Reads settle the row first — the real API refreshes a stale `processing` row inline too. */
  function representation(row) {
    settle(row);
    return toRepresentation(row);
  }

  /**
   * The 202/200 create body = the status representation + the two creation-only fields.
   * `refresh: false` for a FRESH create — a 202 always reports `processing`, exactly like the
   * real API (the row was created microseconds ago). A 200 replay does refresh, because the real
   * replay path re-reads the row's current state.
   */
  function createdRepresentation(row, { refresh = true } = {}) {
    return {
      ...(refresh ? representation(row) : toRepresentation(row)),
      estimatedReadySeconds: 240,
      statusUrl: `${publicBaseUrl}/api/partner/v1/reports/${row.id}`,
    };
  }

  /** Terminal transition + webhook arming. Idempotent: a settled row is never settled twice. */
  function settle(row, force = false) {
    if (row.status !== "processing") return row;
    if (!force && Date.now() < row.readyAt) return row;
    if (row.willFail) {
      row.status = "failed";
      row.failureReason = row.failureReason ?? "report_failed";
    } else {
      row.status = "generated";
      row.generatedAt = new Date(Math.max(row.readyAt, Date.now())).toISOString();
    }
    const event = row.status === "generated" ? "report.generated" : "report.failed";
    log(`report ${row.id} -> ${row.status}${row.failureReason ? ` (${row.failureReason})` : ""}`);
    if (row.webhookUrl) {
      sender.send({ url: row.webhookUrl, event, reportRequestId: row.id, data: toRepresentation(row) });
    }
    return row;
  }

  function create({ input, hooks, idempotencyKey, requestHash, failImmediately = false }) {
    const now = new Date();
    const slow = hooks.has("Slow");
    const durationMs = failImmediately ? 0 : Math.round(reportSeconds * 1000 * (slow ? 3 : 1));
    const row = {
      id: randomUUID(),
      reportId: failImmediately ? null : randomUUID(),
      status: "processing",
      failureReason: null,
      createdAt: now.toISOString(),
      generatedAt: null,
      externalReference: input.externalReference,
      address: {
        street: input.street,
        streetNumber: input.streetNumber,
        city: input.city,
        county: input.county,
        postalCode: input.postalCode,
      },
      coordinates: { lat: input.lat, lng: input.lng },
      propertyType: input.propertyType,
      customerEmail: input.customerEmail,
      // Snapshotted at creation, exactly like the real ledger row: the per-request override if
      // given, else the account URL configured by ResidenceVertical at that moment.
      webhookUrl: input.webhookUrl ?? accountWebhookUrl,
      willFail: failImmediately || hooks.has("Fail"),
      idempotencyKey: idempotencyKey ?? null,
      requestHash,
      createdDay: bucharestDay(now),
      readyAt: now.getTime() + durationMs,
    };
    reports.set(row.id, row);

    if (failImmediately) {
      // The `Boom` path: report-service refused the request. The row is marked terminally failed
      // with `report_service_error`, the Idempotency-Key is RELEASED (so the same key retries as a
      // fresh attempt) and — because a webhook URL is configured — a `report.failed` still fires.
      row.failureReason = "report_service_error";
      row.idempotencyKey = null;
      settle(row, true);
      return row;
    }
    if (idempotencyKey) byIdempotency.set(idempotencyKey, { requestHash, reportRequestId: row.id });
    const timer = setTimeout(() => {
      timers.delete(timer);
      settle(row);
    }, durationMs + 5);
    timer.unref?.();
    timers.add(timer);
    log(`report ${row.id} created (ready in ${Math.round(durationMs / 1000)}s`
      + `${slow ? ", Slow hook: 3x" : ""}${row.willFail ? ", Fail hook: will end failed" : ""})`);
    return row;
  }

  return {
    create,
    representation,
    setAccountWebhookUrl: (url) => { accountWebhookUrl = url; },
    createdRepresentation,
    viewLinkFor,
    /** Is this `?t=` token a valid, unexpired grant for THIS report request? */
    verifyViewToken: (id, token) => verifyViewToken(viewTokenSecret, id, token),
    get: (id) => reports.get(id),
    /** Newest first, filtered like `GET /reports?status=`. */
    list({ status, limit, offset }) {
      const rows = [...reports.values()];
      for (const row of rows) settle(row);
      const filtered = rows
        .filter((row) => !status || row.status === status)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      return filtered.slice(offset, offset + limit).map(representation);
    },
    findReplay(idempotencyKey) {
      if (!idempotencyKey) return null;
      const entry = byIdempotency.get(idempotencyKey);
      if (!entry) return null;
      const row = reports.get(entry.reportRequestId);
      return row ? { row, requestHash: entry.requestHash } : null;
    },
    countToday: () => [...reports.values()].filter((row) => row.createdDay === bucharestDay(new Date())).length,
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      sender.stop();
    },
  };
}
