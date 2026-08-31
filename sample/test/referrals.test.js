/**
 * `GET /referrals` + the `/me` `referral` block — referral mode (guide §2). The mock ships a
 * canned referral ledger with one row per state a real ledger can show, and derives the `/me`
 * money totals from the same rows.
 *
 * These assert the contract you actually depend on:
 *   - Bearer auth exactly like every other partner endpoint (401 without a key);
 *   - the documented wire shape, field for field, newest first, with the ledger states
 *     `pending` / `earned` / `void` and `paidAt` as the paid marker (status stays `earned`);
 *   - the money model: priceCents = 5000 (50 lei list price), commissionCents follows the
 *     account's percentage on EVERY row (so it moves with MOCK_COMMISSION_PCT);
 *   - the /me referral block: the `/p/<slug>` link on the mock's own host, and totals
 *     (pending / earned-unpaid / paid-all-time) that EQUAL the sums over the ledger rows —
 *     the two surfaces can never disagree;
 *   - the `{ items, count, limit, offset }` envelope shared with GET /reports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startMock, TEST_KEY } from "./helpers.js";

async function getJson(mock, path, { key = TEST_KEY } = {}) {
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const response = await fetch(`${mock.baseUrl}${path}`, { headers });
  return { response, body: await response.json() };
}

test("GET /referrals requires the API key like every other partner endpoint", async () => {
  const mock = await startMock();
  try {
    const { response, body } = await getJson(mock, "/api/partner/v1/referrals", { key: null });
    assert.equal(response.status, 401);
    assert.equal(body.error.code, "unauthorized");
    assert.ok(response.headers.get("x-rv-request-id"), "even a 401 carries X-RV-Request-Id");
  } finally {
    await mock.close();
  }
});

test("GET /referrals returns the canned ledger in the documented shape, newest first", async () => {
  const mock = await startMock();
  try {
    const { response, body } = await getJson(mock, "/api/partner/v1/referrals");
    assert.equal(response.status, 200);
    assert.deepEqual({ count: body.count, limit: body.limit, offset: body.offset },
      { count: body.items.length, limit: 20, offset: 0 }, "the same list envelope as GET /reports");
    assert.ok(body.items.length >= 4, "one row per state a real ledger can show");

    for (const referral of body.items) {
      assert.deepEqual(Object.keys(referral), [
        "referralId", "createdAt", "status", "priceCents", "commissionCents", "earnedAt", "paidAt",
        "externalReference", "checkoutLinkId",
      ], "the documented wire shape, field for field (externalReference + checkoutLinkId since v1.4)");
      assert.ok(["pending", "earned", "void"].includes(referral.status),
        "lowercase statuses, matching the OpenAPI enum [pending, earned, void]");
      assert.equal(referral.priceCents, 5000, "every referral is a full-price 50 lei checkout");
      assert.equal(referral.commissionCents, Math.round(5000 * 15 / 100), "default 15% per row");
    }

    const statuses = body.items.map((referral) => referral.status);
    assert.ok(statuses.includes("pending") && statuses.includes("earned") && statuses.includes("void"),
      "pending, earned and void are all represented");

    // Newest first, like every list endpoint.
    const createdAts = body.items.map((referral) => Date.parse(referral.createdAt));
    assert.deepEqual(createdAts, [...createdAts].sort((a, b) => b - a), "newest first");

    // State semantics: pending/void never earned; a paid row is still `earned` — `paidAt` is the
    // paid marker (there is no paid status on this surface).
    for (const referral of body.items) {
      if (referral.status !== "earned") {
        assert.equal(referral.earnedAt, null, `${referral.status} rows have no earnedAt`);
        assert.equal(referral.paidAt, null, `${referral.status} rows have no paidAt`);
      } else {
        assert.ok(referral.earnedAt, "earned rows carry earnedAt");
      }
    }
    assert.ok(body.items.some((r) => r.status === "earned" && r.paidAt === null),
      "at least one earned commission still awaiting its weekly payout");
    assert.ok(body.items.some((r) => r.status === "earned" && r.paidAt !== null),
      "at least one commission already paid out (paidAt set, status still earned)");

    // Per-lead conversion tracking (v1.4): a purchase attributed by a CHECKOUT LINK carries the
    // partner's own lead id and the link that carried it; a zero-code /p attribution carries
    // neither — the two tiers are distinguishable per row.
    for (const referral of body.items) {
      assert.equal(referral.externalReference !== null, referral.checkoutLinkId !== null,
        "externalReference and checkoutLinkId travel together — both copied from the link");
      if (referral.checkoutLinkId !== null) {
        assert.match(referral.checkoutLinkId, /^pcl_[A-Za-z0-9]{32}$/,
          "the checkout link id is the documented pcl_ token shape");
      }
    }
    assert.ok(body.items.some((r) => r.externalReference !== null),
      "at least one referral attributed through a checkout link (the recommended tier)");
    assert.ok(body.items.some((r) => r.externalReference === null),
      "at least one referral attributed through the zero-code /p link");

    // No buyer PII on the partner surface — the buyer is our customer, not the partner's.
    const serialized = JSON.stringify(body.items);
    assert.ok(!serialized.includes("@"), "no buyer email anywhere in the ledger");

    // Canned but STABLE: a second read is the same ledger, not a new one.
    const again = await getJson(mock, "/api/partner/v1/referrals");
    assert.deepEqual(again.body.items.map((r) => r.referralId), body.items.map((r) => r.referralId));
  } finally {
    await mock.close();
  }
});

test("the /me referral block links /p/<slug> and its totals equal the ledger sums", async () => {
  const mock = await startMock();
  try {
    const { body: profile } = await getJson(mock, "/api/partner/v1/me");
    assert.deepEqual(Object.keys(profile.referral), [
      "referralUrl", "commissionPct", "pendingCents", "earnedUnpaidCents", "paidCentsAllTime",
    ], "the documented referral block, field for field");
    assert.equal(profile.referral.referralUrl, `${mock.server.baseUrl()}/p/${profile.slug}`,
      "the referral link is /p/<slug> on this environment's own public base URL");
    assert.equal(profile.referral.commissionPct, profile.commissionPct,
      "one account, one percentage — the block repeats the top-level value");

    const { body: ledger } = await getJson(mock, "/api/partner/v1/referrals");
    const sum = (rows) => rows.reduce((total, row) => total + row.commissionCents, 0);
    assert.equal(profile.referral.pendingCents,
      sum(ledger.items.filter((r) => r.status === "pending")),
      "/me pending equals the pending rows");
    assert.equal(profile.referral.earnedUnpaidCents,
      sum(ledger.items.filter((r) => r.status === "earned" && r.paidAt === null)),
      "/me earned-unpaid equals the earned rows without paidAt");
    assert.equal(profile.referral.paidCentsAllTime,
      sum(ledger.items.filter((r) => r.paidAt !== null)),
      "/me paid-all-time equals the rows a payout has paid");
  } finally {
    await mock.close();
  }
});

test("referral commission follows the account's percentage, and offset pages past the ledger", async () => {
  const mock = await startMock({ commissionPct: 20 });
  try {
    const { body } = await getJson(mock, "/api/partner/v1/referrals");
    for (const referral of body.items) {
      assert.equal(referral.commissionCents, Math.round(5000 * 20 / 100));
    }
    const { body: profile } = await getJson(mock, "/api/partner/v1/me");
    assert.equal(profile.referral.commissionPct, 20);

    const page = await getJson(mock, `/api/partner/v1/referrals?limit=2&offset=1`);
    assert.equal(page.body.items.length, 2);
    assert.equal(page.body.limit, 2);
    assert.equal(page.body.offset, 1);
    assert.equal(page.body.items[0].referralId, body.items[1].referralId, "offset walks the same order");

    const past = await getJson(mock, `/api/partner/v1/referrals?limit=5&offset=${body.items.length}`);
    assert.deepEqual(past.body, { items: [], count: 0, limit: 5, offset: body.items.length });
  } finally {
    await mock.close();
  }
});
