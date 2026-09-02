/**
 * `lib/rvClient.js` against the mock — and against a stubbed `fetch` for the retry policy, so the
 * suite never sleeps for real.
 *
 * These assert the contract you actually depend on:
 *   - `createCheckoutLink` → the documented 201 shape; a validation failure surfaces
 *     `error.fields` per field;
 *   - `listReferrals` pages the ledger; `me()` reports the account and the referral block;
 *   - a 401 is never retried and carries `X-RV-Request-Id`;
 *   - the retry policy: network errors and `503 partner_api_disabled` are retried within budget,
 *     a `Retry-After` beyond the budget fails fast, a 400 is never retried.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRvClient, RvApiError } from "../lib/rvClient.js";
import { startMock, TEST_KEY, linkBody } from "./helpers.js";

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

test("createCheckoutLink mints the documented 201 shape on the mock's own host", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    const before = Date.now();
    const link = await rv.createCheckoutLink(linkBody({ externalReference: "lead-1" }));
    assert.deepEqual(Object.keys(link), ["checkoutLinkId", "url", "expiresAt", "externalReference"]);
    assert.match(link.checkoutLinkId, /^pcl_[A-Za-z0-9]{32}$/);
    assert.equal(link.url, `${mock.server.baseUrl()}/c/${link.checkoutLinkId}`);
    assert.equal(link.externalReference, "lead-1");
    const lifetimeMs = Date.parse(link.expiresAt) - before;
    assert.ok(lifetimeMs > 47.9 * 3600_000 && lifetimeMs < 48.1 * 3600_000, "default expiry is 48 h");
  });
});

test("a validation error surfaces error.fields per field and is not retried", async () => {
  await withMock({}, async (mock) => {
    const exchanges = [];
    const rv = clientFor(mock, { onExchange: (exchange) => exchanges.push(exchange) });
    await assert.rejects(
      () => rv.createCheckoutLink({ address: { street: "Strada Turda" }, propertyType: "villa", expiresInHours: 0 }),
      (error) => {
        assert.ok(error instanceof RvApiError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "validation_error");
        assert.equal(error.fields["address.streetNumber"], "address.streetNumber is required");
        assert.equal(error.fields["address.city"], "address.city is required");
        assert.equal(error.fields.propertyType, "propertyType must be one of: apartment, house");
        assert.match(error.fields.expiresInHours, /between 1 and 720/);
        assert.match(error.message, /^Request validation failed: /);
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(exchanges.length, 1, "a 400 must not be retried");
  });
});

test("listReferrals pages the ledger newest-first and me() reports the referral block", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    const page = await rv.listReferrals({ limit: 2 });
    assert.equal(page.items.length, 2);
    assert.deepEqual({ count: page.count, limit: page.limit, offset: page.offset }, { count: 2, limit: 2, offset: 0 });
    assert.ok(Date.parse(page.items[0].createdAt) >= Date.parse(page.items[1].createdAt), "newest first");

    const next = await rv.listReferrals({ limit: 2, offset: 2 });
    assert.equal(next.offset, 2);
    assert.notEqual(next.items[0].referralId, page.items[0].referralId, "offset walks the ledger");

    const profile = await rv.me();
    assert.equal(profile.environment, "test");
    assert.equal(profile.reportPriceCents, 5000);
    assert.equal(profile.currency, "RON");
    assert.equal(profile.commissionPct, 15);
    assert.equal(profile.referral.referralUrl, `${mock.server.baseUrl()}/p/${profile.slug}`);
    assert.equal(typeof profile.referral.earnedUnpaidCents, "number");
  });
});

test("401 unauthorized: an unknown key is not retried and carries X-RV-Request-Id", async () => {
  await withMock({}, async (mock) => {
    const attempts = [];
    const rv = createRvClient({
      baseUrl: mock.baseUrl,
      apiKey: "rvp_live_wrong_environment_key",
      onExchange: (exchange) => attempts.push(exchange),
    });
    await assert.rejects(() => rv.me(), (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "unauthorized");
      assert.ok(error.requestId, "every response carries X-RV-Request-Id");
      return true;
    });
    assert.equal(attempts.length, 1, "a 401 must not be retried");
  });
});

/** A `fetch` stand-in that plays a scripted list of answers, one per attempt. */
function scriptedFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(calls.length, script.length) - 1];
    if (step.throws) {
      const error = new Error(step.throws);
      error.name = step.name ?? "TypeError";
      throw error;
    }
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json", "x-rv-request-id": `req-${calls.length}`, ...(step.headers ?? {}) },
    });
  };
  return { fetchImpl, calls };
}

const ok201 = { status: 201, body: { checkoutLinkId: "pcl_x", url: "u", expiresAt: "e", externalReference: null } };

test("a network error is retried and the mint then succeeds on the next attempt", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ throws: "ECONNRESET" }, ok201]);
  const exchanges = [];
  const rv = createRvClient({
    baseUrl: "http://rv.invalid", apiKey: TEST_KEY, fetchImpl, maxRetryDelayMs: 20,
    onExchange: (exchange) => exchanges.push(exchange),
  });
  const link = await rv.createCheckoutLink(linkBody());
  assert.equal(link.checkoutLinkId, "pcl_x");
  assert.equal(calls.length, 2);
  assert.deepEqual(exchanges.map((exchange) => [exchange.status, exchange.code]), [[0, "network_error"], [201, undefined]]);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TEST_KEY}`, "the key travels only as the Bearer header");
});

test("503 partner_api_disabled is retried within budget; a Retry-After beyond it fails fast", async () => {
  const disabled = { status: 503, body: { error: { code: "partner_api_disabled", message: "off" } }, headers: { "retry-after": "0" } };
  const short = scriptedFetch([disabled, ok201]);
  const rv = createRvClient({ baseUrl: "http://rv.invalid", apiKey: TEST_KEY, fetchImpl: short.fetchImpl, maxRetryDelayMs: 50 });
  assert.equal((await rv.me()).checkoutLinkId, "pcl_x");
  assert.equal(short.calls.length, 2, "retried once, then succeeded");

  const long = scriptedFetch([{ ...disabled, headers: { "retry-after": "3600" } }, ok201]);
  const slow = createRvClient({ baseUrl: "http://rv.invalid", apiKey: TEST_KEY, fetchImpl: long.fetchImpl, maxRetryDelayMs: 50 });
  const startedAt = Date.now();
  await assert.rejects(() => slow.me(), (error) => error.status === 503 && error.retryAfterSeconds === 3600 && error.retryable);
  assert.equal(long.calls.length, 1, "a Retry-After we cannot honour is surfaced, not slept on");
  assert.ok(Date.now() - startedAt < 500, "…and it must fail fast");
});

test("an edge 429 without a JSON body is retried, and a 5xx without a body is retried too", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { status: 429, body: undefined, headers: { "content-type": "text/plain" } },
    { status: 502, body: undefined, headers: { "content-type": "text/html" } },
    ok201,
  ]);
  const rv = createRvClient({ baseUrl: "http://rv.invalid", apiKey: TEST_KEY, fetchImpl, maxRetryDelayMs: 20, maxAttempts: 3 });
  const link = await rv.createCheckoutLink(linkBody());
  assert.equal(link.checkoutLinkId, "pcl_x");
  assert.equal(calls.length, 3);

  const exhausted = scriptedFetch([{ status: 502, body: undefined, headers: { "content-type": "text/html" } }]);
  const rv2 = createRvClient({ baseUrl: "http://rv.invalid", apiKey: TEST_KEY, fetchImpl: exhausted.fetchImpl, maxRetryDelayMs: 20, maxAttempts: 2 });
  await assert.rejects(() => rv2.me(), (error) => error.status === 502 && error.code === "http_502" && error.requestId === "req-2");
  assert.equal(exhausted.calls.length, 2, "gives up after maxAttempts");
});
