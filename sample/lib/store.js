/**
 * The partner's own job store — an in-memory stand-in for YOUR database table.
 *
 * This is the one piece of state a Partner API integration genuinely needs: the mapping between
 * your order/lead and our `reportRequestId`. Keep it in a real table; everything else (polling
 * cache, wire log) can be thrown away on restart, this cannot.
 *
 * RECOMMENDED COLUMNS (this file models exactly these)
 * ---------------------------------------------------
 *   order_id             PK   your own id. Also used as the `Idempotency-Key` and as
 *                             `externalReference`, so every side can correlate without a join.
 *   report_request_id    uniq our id, from the 202/200 create response. NULL until the create
 *                             succeeds (a create answered 502 leaves it NULL — retry later).
 *   report_id                 our internal report id — quote it to support.
 *   status                    processing | generated | failed  (+ your own `pending` before create)
 *   failure_reason            report_failed | report_cancelled | report_service_error
 *   created_at / generated_at timestamps as returned by us
 *   view_url                  the signed link to the report WEB PAGE — what you put behind your
 *                             "Vezi raportul" button. Store it, do not try to build it yourself.
 *   view_expires_at           when that link stops working (30 days by default). Past it, call
 *                             `POST /reports/{id}/view-link` for a fresh one instead of caching
 *                             a dead URL forever.
 *   pdf_path / pdf_bytes      where you cached the PDF (download once, serve many times)
 *   last_delivery_id          the last `X-RV-Delivery-Id` you processed → webhook de-duplication
 *   last_request_id           the last `X-RV-Request-Id` → what support asks for
 *
 * Index `report_request_id` (webhook lookups) and `status` (the "still processing" sweeper that
 * polls as a fallback when a webhook never arrives).
 */

export function createOrderStore() {
  const orders = new Map();
  const byReportRequestId = new Map();
  const seenDeliveryIds = new Set();

  return {
    create({ orderId, property }) {
      const order = {
        orderId,
        property,
        reportRequestId: null,
        reportId: null,
        status: "pending", // your own state, before our 202 lands
        failureReason: null,
        createdAt: new Date().toISOString(),
        generatedAt: null,
        viewUrl: null,      // set the moment the report is generated (status read or webhook)
        viewExpiresAt: null,
        lastDeliveryId: null,
        lastRequestId: null,
        lastPolledAt: 0,
        notifiedBy: null, // "webhook" | "polling" — demo only: shows which arrived first
        error: null,
      };
      orders.set(orderId, order);
      return order;
    },

    get: (orderId) => orders.get(orderId),
    getByReportRequestId: (reportRequestId) => byReportRequestId.get(reportRequestId),
    all: () => [...orders.values()],

    /** Apply one of our status representations (from a poll OR a webhook — same shape). */
    applyReportStatus(order, report, { source = "polling" } = {}) {
      if (!order) return null;
      if (report.reportRequestId) {
        order.reportRequestId = report.reportRequestId;
        byReportRequestId.set(report.reportRequestId, order);
      }
      order.reportId = report.reportId ?? order.reportId;
      // `failed` → `generated` is a real (if rare) transition on our side: the later status wins.
      order.status = report.status ?? order.status;
      order.failureReason = report.failureReason ?? null;
      order.generatedAt = report.generatedAt ?? order.generatedAt;
      // `viewUrl` arrives only on a GENERATED report — from a status read OR straight from the
      // `report.generated` webhook, which is why a webhook-driven integration needs no extra call
      // to show the report. Every read mints a fresh link, so the newest one always wins.
      if (report.viewUrl) {
        order.viewUrl = report.viewUrl;
        order.viewExpiresAt = report.viewExpiresAt ?? null;
      }
      order.error = null;
      if (order.status !== "processing" && !order.notifiedBy) order.notifiedBy = source;
      if (source === "polling") order.lastPolledAt = Date.now();
      return order;
    },

    markCreateFailed(order, error) {
      order.status = "create_failed";
      order.error = { code: error.code, message: error.message, requestId: error.requestId };
      return order;
    },

    /**
     * Webhook de-duplication. `X-RV-Delivery-Id` is stable across retries of the same event, so
     * "have I seen this id?" is the whole algorithm. In a real system this is a UNIQUE column
     * (or a Redis SET with a TTL of a few days), not a process-local Set.
     */
    isDuplicateDelivery(deliveryId) {
      if (!deliveryId) return false;
      if (seenDeliveryIds.has(deliveryId)) return true;
      seenDeliveryIds.add(deliveryId);
      return false;
    },
  };
}
