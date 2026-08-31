/**
 * `GET /settlements` — the weekly settlement history (guide §16). The mock ships one canned
 * settlement so a reconciliation flow can be built before a real week has ever settled.
 *
 * These assert the contract you actually depend on:
 *   - Bearer auth exactly like every other partner endpoint (401 without a key);
 *   - the documented wire shape and field order, status `invoiced` with a real invoice number;
 *   - the money model: gross = reports × 50 lei, commission = the account's pct of it (so it
 *     moves with MOCK_COMMISSION_PCT), net = gross − commission, currency RON;
 *   - the weekly period: a Monday→Sunday complete week, with 7-day payment terms on the invoice;
 *   - the `{ items, count, limit, offset }` envelope shared with GET /reports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startMock, TEST_KEY } from "./helpers.js";

async function getSettlements(mock, { key = TEST_KEY, query = "" } = {}) {
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const response = await fetch(`${mock.baseUrl}/api/partner/v1/settlements${query}`, { headers });
  return { response, body: await response.json() };
}

const utcDay = (isoDate) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();

test("GET /settlements requires the API key like every other partner endpoint", async () => {
  const mock = await startMock();
  try {
    const { response, body } = await getSettlements(mock, { key: null });
    assert.equal(response.status, 401);
    assert.equal(body.error.code, "unauthorized");
    assert.ok(response.headers.get("x-rv-request-id"), "even a 401 carries X-RV-Request-Id");
  } finally {
    await mock.close();
  }
});

test("GET /settlements returns one canned invoiced weekly settlement in the documented shape", async () => {
  const mock = await startMock();
  try {
    const { response, body } = await getSettlements(mock);
    assert.equal(response.status, 200);
    assert.deepEqual({ count: body.count, limit: body.limit, offset: body.offset },
      { count: 1, limit: 20, offset: 0 }, "the same list envelope as GET /reports");
    assert.equal(body.items.length, 1);

    const settlement = body.items[0];
    assert.deepEqual(Object.keys(settlement), [
      "settlementId", "periodStart", "periodEnd", "reportsCount", "grossCents", "commissionCents",
      "netCents", "currency", "status", "invoiceNumber", "issuedAt", "dueAt", "paidAt",
    ], "the documented wire shape, field for field");

    // The settled period is a COMPLETE Monday→Sunday week that ended before today.
    assert.match(settlement.periodStart, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(settlement.periodEnd, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(utcDay(settlement.periodStart), 1, "periodStart is a Monday");
    assert.equal(utcDay(settlement.periodEnd), 0, "periodEnd is a Sunday");
    assert.equal(Date.parse(`${settlement.periodEnd}T00:00:00Z`) - Date.parse(`${settlement.periodStart}T00:00:00Z`),
      6 * 86_400_000, "exactly one week: Monday through its own Sunday");
    assert.ok(Date.parse(`${settlement.periodEnd}T00:00:00Z`) < Date.now(), "an already-closed week");

    // The money model: gross = N × 50 lei list price; the 15% default commission is a visible
    // negative invoice line; net = gross − commission is what the partner owes.
    assert.equal(settlement.grossCents, settlement.reportsCount * 5000);
    assert.equal(settlement.commissionCents, Math.round(settlement.grossCents * 15 / 100));
    assert.equal(settlement.netCents, settlement.grossCents - settlement.commissionCents);
    assert.equal(settlement.currency, "RON");

    // Invoiced, awaiting payment, on 7-day terms.
    assert.equal(settlement.status, "invoiced",
      "lowercase status, matching the OpenAPI enum [open, invoiced, paid, void]");
    assert.match(settlement.invoiceNumber, /^RVTP \d+$/, "invoice series + number joined");
    assert.equal(Date.parse(settlement.dueAt) - Date.parse(settlement.issuedAt),
      7 * 86_400_000, "payment terms: 7 days from the invoice date");
    assert.ok(Date.parse(settlement.issuedAt) >= Date.parse(`${settlement.periodEnd}T00:00:00Z`),
      "the invoice was issued after the week closed");
    assert.equal(settlement.paidAt, null);

    // Canned but STABLE: a second read is the same settlement, not a new one.
    const again = await getSettlements(mock);
    assert.equal(again.body.items[0].settlementId, settlement.settlementId);
  } finally {
    await mock.close();
  }
});

test("GET /settlements commission follows the account's percentage, and offset pages past the single row", async () => {
  const mock = await startMock({ commissionPct: 20 });
  try {
    const { body } = await getSettlements(mock);
    const settlement = body.items[0];
    assert.equal(settlement.commissionCents, Math.round(settlement.grossCents * 20 / 100));
    assert.equal(settlement.netCents, settlement.grossCents - settlement.commissionCents);

    const page2 = await getSettlements(mock, { query: "?limit=5&offset=1" });
    assert.deepEqual(page2.body, { items: [], count: 0, limit: 5, offset: 1 });
  } finally {
    await mock.close();
  }
});
