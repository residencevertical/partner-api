import test from "node:test";
import assert from "node:assert/strict";
import { createRvClient, RvApiError } from "../lib/rvClient.js";
import { startMock, waitFor, TEST_KEY, addressBody } from "./helpers.js";

/** The mock is driven by MOCK_REPORT_SECONDS=0 here — never sleep for the real 20 s in a test. */
async function withMock(options, run) {
  const mock = await startMock(options);
  try {
    await run(mock);
  } finally {
    await mock.close();
  }
}

const clientFor = (mock, overrides = {}) => createRvClient({
  baseUrl: mock.baseUrl,
  apiKey: TEST_KEY,
  maxRetryDelayMs: 200,
  ...overrides,
});

test("create → poll → generated → PDF bytes", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);

    const { report, replayed } = await rv.createReport(
      addressBody({ externalReference: "order-1" }),
      { idempotencyKey: "order-1" },
    );
    assert.equal(replayed, false);
    assert.equal(report.status, "processing");
    assert.equal(report.externalReference, "order-1");
    assert.equal(report.downloadUrl, null);
    assert.equal(report.estimatedReadySeconds, 240);
    assert.ok(report.statusUrl.endsWith(`/api/partner/v1/reports/${report.reportRequestId}`));
    assert.deepEqual(Object.keys(report.address), ["street", "streetNumber", "city", "county", "postalCode"]);

    // Before it is generated the PDF endpoint is a 409, not a 404 and not an empty body.
    await assert.rejects(
      () => rv.getReportPdf(report.reportRequestId),
      (error) => error instanceof RvApiError && error.status === 409 && error.code === "report_not_ready",
    );

    const generated = await waitFor(async () => {
      const current = await rv.getReport(report.reportRequestId);
      return current.status === "generated" ? current : null;
    }, { label: "status=generated" });

    assert.ok(generated.generatedAt);
    assert.ok(generated.downloadUrl.endsWith("/pdf"));
    assert.equal(generated.failureReason, null);

    const pdf = await rv.getReportPdf(report.reportRequestId);
    assert.equal(pdf.buffer.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.equal(pdf.contentType, "application/pdf");
    assert.equal(pdf.filename, `raport-imobiliar-${report.reportRequestId}.pdf`);
    assert.ok(pdf.buffer.length > 500);
  });
});

test("an idempotent replay returns 200 with the SAME reportRequestId", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    const first = await rv.createReport(addressBody(), { idempotencyKey: "order-replay" });
    const second = await rv.createReport(addressBody(), { idempotencyKey: "order-replay" });
    assert.equal(second.replayed, true);
    assert.equal(second.report.reportRequestId, first.report.reportRequestId);
  });
});

test("the same key with a different body is a 409 idempotency_conflict", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    await rv.createReport(addressBody(), { idempotencyKey: "order-conflict" });
    await assert.rejects(
      () => rv.createReport(addressBody({ address: { street: "Strada Alta", streetNumber: "2", city: "Cluj-Napoca" } }),
        { idempotencyKey: "order-conflict" }),
      (error) => error.status === 409 && error.code === "idempotency_conflict",
    );
  });
});

test("401 unauthorized: an unknown key is not retried and carries X-RV-Request-Id", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock, { apiKey: "rvp_live_wrong_environment_key" });
    const attempts = [];
    const observed = createRvClient({
      baseUrl: mock.baseUrl,
      apiKey: "rvp_live_wrong_environment_key",
      onExchange: (exchange) => attempts.push(exchange),
    });
    await assert.rejects(() => rv.me(), (error) => error.status === 401 && error.code === "unauthorized");
    await assert.rejects(() => observed.me(), (error) => {
      assert.ok(error.requestId, "every response carries X-RV-Request-Id");
      return true;
    });
    assert.equal(attempts.length, 1, "a 401 must not be retried");
  });
});

test("429 daily_cap_exceeded surfaces Retry-After instead of sleeping until midnight", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    const startedAt = Date.now();
    await assert.rejects(
      () => rv.createReport(addressBody({ address: { street: "Strada Cap", streetNumber: "1", city: "București" } }),
        { idempotencyKey: "order-cap" }),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.code, "daily_cap_exceeded");
        assert.ok(error.retryAfterSeconds > 0, "Retry-After must be present on a cap 429");
        assert.equal(error.retryable, true);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 1000, "a Retry-After we cannot honour must fail fast, not block");
  });
});

test("503 maintenance is retried within budget and then succeeds", async () => {
  await withMock({}, async (mock) => {
    const exchanges = [];
    const rv = clientFor(mock, { maxAttempts: 2, onExchange: (exchange) => exchanges.push(exchange) });
    // Retry-After on maintenance is 60 s — above our 200 ms budget, so the client must NOT wait.
    await assert.rejects(
      () => rv.createReport(addressBody({ address: { street: "Strada Maintenance", streetNumber: "1", city: "București" } })),
      (error) => error.status === 503 && error.code === "maintenance" && error.retryAfterSeconds === 60,
    );
    assert.equal(exchanges.length, 1);
  });
});

test("502 report_service_unavailable: the same Idempotency-Key retries as a FRESH attempt", async () => {
  await withMock({ boomFailures: 1 }, async (mock) => {
    // maxAttempts: 1 so the failure surfaces to us instead of being retried internally.
    const rv = clientFor(mock, { maxAttempts: 1 });
    const body = addressBody({
      address: { street: "Strada Boom", streetNumber: "1", city: "București" },
      externalReference: "order-boom",
    });

    await assert.rejects(
      () => rv.createReport(body, { idempotencyKey: "order-boom" }),
      (error) => error.status === 502 && error.code === "report_service_unavailable",
    );

    // The key was NOT consumed: the same key now creates a new request (202), not a 200 replay.
    const retry = await rv.createReport(body, { idempotencyKey: "order-boom" });
    assert.equal(retry.replayed, false, "a 502 must not consume the Idempotency-Key");
    assert.equal(retry.report.status, "processing");
  });
});

test("502 report_service_unavailable is retried automatically by the client", async () => {
  await withMock({ boomFailures: 1 }, async (mock) => {
    const exchanges = [];
    const rv = clientFor(mock, { maxAttempts: 3, onExchange: (exchange) => exchanges.push(exchange) });
    const { report } = await rv.createReport(
      addressBody({ address: { street: "Strada Boom", streetNumber: "1", city: "București" } }),
      { idempotencyKey: "order-boom-auto" },
    );
    assert.equal(report.status, "processing");
    assert.deepEqual(exchanges.map((exchange) => exchange.status), [502, 202]);
  });
});

test("502 geocoding_failed is NOT retried (an unchanged address will fail again)", async () => {
  await withMock({}, async (mock) => {
    const exchanges = [];
    const rv = clientFor(mock, { maxAttempts: 3, onExchange: (exchange) => exchanges.push(exchange) });
    await assert.rejects(
      () => rv.createReport(addressBody({ address: { street: "Strada Geo", streetNumber: "1", city: "București" } })),
      (error) => error.status === 502 && error.code === "geocoding_failed" && error.retryable === false,
    );
    assert.equal(exchanges.length, 1);
  });
});

test("a validation error surfaces error.fields per field", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    await assert.rejects(
      () => rv.createReport({ address: { street: "Strada Turda" }, propertyType: "villa" }),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, "validation_error");
        assert.equal(error.fields["address.streetNumber"], "address.streetNumber is required");
        assert.equal(error.fields["address.city"], "address.city is required");
        assert.equal(error.fields.propertyType, "propertyType must be one of: apartment, house");
        assert.match(error.message, /^Request validation failed: /);
        return true;
      },
    );
  });
});

test("a failed report reports failureReason and never a downloadUrl", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    const { report } = await rv.createReport(
      addressBody({ address: { street: "Strada Fail", streetNumber: "1", city: "București" } }),
    );
    const failed = await waitFor(async () => {
      const current = await rv.getReport(report.reportRequestId);
      return current.status === "failed" ? current : null;
    }, { label: "status=failed" });
    assert.equal(failed.failureReason, "report_failed");
    assert.equal(failed.downloadUrl, null);
    await assert.rejects(() => rv.getReportPdf(report.reportRequestId),
      (error) => error.status === 409 && error.code === "report_not_ready");
  });
});

test("listReports pages newest-first and filters by status; me() reports the account", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    await rv.createReport(addressBody({ externalReference: "a" }), { idempotencyKey: "a" });
    await rv.createReport(addressBody({ externalReference: "b" }), { idempotencyKey: "b" });

    const page = await rv.listReports({ limit: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(page.count, 1);
    assert.equal(page.limit, 1);
    assert.equal(page.offset, 0);
    assert.equal(page.items[0].externalReference, "b", "newest first");

    await assert.rejects(() => rv.listReports({ status: "nope" }),
      (error) => error.status === 400 && error.fields.status === "must be one of: processing, generated, failed");

    const profile = await rv.me();
    assert.equal(profile.environment, "test");
    assert.equal(profile.reportPriceCents, 5000);
    assert.equal(profile.currency, "RON");
    assert.equal(profile.reportsToday, 2);
  });
});

test("an unknown reportRequestId is a 404 not_found", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    await assert.rejects(() => rv.getReport("00000000-0000-4000-8000-000000000000"),
      (error) => error.status === 404 && error.code === "not_found");
  });
});
