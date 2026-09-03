/**
 * `server.js` — the partner backend — wired to the mock on ephemeral ports.
 *
 * These assert the contract you actually depend on:
 *   - configuration: mock mode needs nothing, a real environment needs a matching key;
 *   - the button path: one lead = one checkout link, reused while valid, never a duplicate;
 *   - the lead view correlates with the ledger (`GET /referrals`) by `externalReference`, which
 *     is how a backend learns a lead converted;
 *   - the storefront's account panel and referral panel read through the backend;
 *   - the API key never reaches anything the browser can fetch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, ConfigError } from "../server.js";
import { startMock, startPartner, TEST_KEY } from "./helpers.js";

const PROPERTY = {
  street: "Strada Turda", streetNumber: "94", city: "București", county: "București",
  postalCode: "011332", propertyType: "apartment",
};

/** Partner backend + mock, wired together on ephemeral ports. */
async function withStack(run, { mockOptions = {}, partnerOverrides = {} } = {}) {
  const mock = await startMock(mockOptions);
  const partner = await startPartner({ baseUrl: mock.baseUrl, apiKey: TEST_KEY, ...partnerOverrides });
  try {
    await run({ mock, partner });
  } finally {
    await partner.close();
    await mock.close();
  }
}

const postLink = (partner, body = PROPERTY) => fetch(`${partner.baseUrl}/api/checkout-links`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("the button path: one lead mints one checkout link, and a re-click reuses it", async () => {
  await withStack(async ({ mock, partner }) => {
    const created = await postLink(partner);
    assert.equal(created.status, 201);
    const lead = await created.json();
    assert.match(lead.leadId, /^lead-/, "the backend keyed the mint by its own lead id");
    assert.match(lead.checkoutLinkId, /^pcl_[A-Za-z0-9]{32}$/);
    assert.ok(lead.checkoutUrl.startsWith(`${mock.server.baseUrl()}/c/`),
      "the browser gets a ResidenceVertical URL — the partner backend is out of the buyer's path");
    assert.ok(Date.parse(lead.checkoutExpiresAt) > Date.now());
    assert.equal(lead.referral, null, "no conversion yet");
    assert.equal(partner.store.get(lead.leadId).checkoutUrl, lead.checkoutUrl, "persisted, not just echoed");

    // A re-click for the SAME lead must not mint a second link while the first is still valid.
    const again = await postLink(partner, { ...PROPERTY, leadId: lead.leadId });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).checkoutLinkId, lead.checkoutLinkId);
    const wire = await (await fetch(`${partner.baseUrl}/api/wire-log`)).json();
    assert.equal(wire.entries.filter((entry) => entry.label === "POST /checkout-links").length, 1, "exactly one mint upstream");
    assert.ok(wire.entries.some((entry) => entry.label === "checkout link reused"));
  });
});

test("an expired stored link is replaced by a fresh mint on the next click", async () => {
  // MOCK-ONLY lever: every link lives 0 s, so the stored one is already dead on the re-click.
  await withStack(async ({ partner }) => {
    const first = await (await postLink(partner, { ...PROPERTY, leadId: "lead-expired" })).json();
    const second = await (await postLink(partner, { ...PROPERTY, leadId: "lead-expired" })).json();
    assert.notEqual(second.checkoutLinkId, first.checkoutLinkId, "a dead link is never served again");
  }, { mockOptions: { checkoutLinkTtlSeconds: 0 } });
});

test("the lead view learns of a conversion by correlating the ledger on externalReference", async () => {
  await withStack(async ({ mock, partner }) => {
    // The mock's canned ledger carries a PENDING referral for lead-84213 — mint under that id.
    const ledger = await (await fetch(`${mock.baseUrl}/api/partner/v1/referrals`, {
      headers: { Authorization: `Bearer ${TEST_KEY}` },
    })).json();
    const canned = ledger.items.find((row) => row.externalReference === "lead-84213");
    assert.equal(canned.status, "pending");

    const lead = await (await postLink(partner, { ...PROPERTY, leadId: "lead-84213" })).json();
    assert.equal(lead.referral, null, "the ledger has not been read yet");

    const seen = await (await fetch(`${partner.baseUrl}/api/leads/lead-84213`)).json();
    assert.deepEqual(seen.referral, {
      referralId: canned.referralId,
      status: "pending",
      commissionCents: canned.commissionCents,
      createdAt: canned.createdAt,
      earnedAt: null,
      paidAt: null,
    }, "the lead carries the ledger row that matched its externalReference");

    const stranger = await (await postLink(partner, { ...PROPERTY, leadId: "lead-nobody-bought" })).json();
    const unmatched = await (await fetch(`${partner.baseUrl}/api/leads/${stranger.leadId}`)).json();
    assert.equal(unmatched.referral, null, "a lead nobody converted stays unmatched");

    const missing = await fetch(`${partner.baseUrl}/api/leads/no-such-lead`);
    assert.equal(missing.status, 404);
  });
});

test("the storefront panels read the ledger and the account through the backend, never the key", async () => {
  await withStack(async ({ partner }) => {
    const referrals = await (await fetch(`${partner.baseUrl}/api/referrals`)).json();
    assert.ok(referrals.items.length >= 4, "the canned ledger flows through");
    assert.ok(referrals.items.every((row) => ["pending", "earned", "void"].includes(row.status)));

    const account = await (await fetch(`${partner.baseUrl}/api/account`)).json();
    assert.deepEqual(Object.keys(account), ["name", "slug", "commissionPct", "referral"], "only the safe subset of /me");
    assert.equal(account.commissionPct, 15);
    assert.ok(account.referral.referralUrl.endsWith(`/p/${account.slug}`));

    const config = await (await fetch(`${partner.baseUrl}/api/config`)).json();
    assert.equal(config.mode, "mock");
    for (const surface of [referrals, account, config, await (await fetch(`${partner.baseUrl}/api/wire-log`)).json()]) {
      assert.equal(JSON.stringify(surface).includes(TEST_KEY), false, "the API key must never be exposed");
    }
  });
});

test("a mint rejected upstream surfaces the error code instead of a stack trace", async () => {
  await withStack(async ({ partner }) => {
    const response = await postLink(partner, { ...PROPERTY, propertyType: "villa" });
    assert.equal(response.status, 400, "a validation failure is the caller's problem — 400, not 502");
    const lead = await response.json();
    assert.equal(lead.error.code, "validation_error");
    assert.ok(lead.error.requestId, "the X-RV-Request-Id is kept for support");
    assert.equal(lead.checkoutUrl, null);
  });
});

test("resolveConfig: mock mode needs nothing, a real environment needs a key", () => {
  const mock = resolveConfig({});
  assert.equal(mock.mockMode, true);
  assert.equal(mock.baseUrl, "http://localhost:4010");
  assert.ok(mock.apiKey.startsWith("rvp_test_"));

  assert.throws(
    () => resolveConfig({ RV_API_BASE_URL: "https://gamma.residencevertical.ro" }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /RV_API_KEY is required/);
      assert.match(error.message, /rvp_test_/);
      return true;
    },
  );

  assert.throws(
    () => resolveConfig({ RV_API_BASE_URL: "https://residencevertical.ro", RV_API_KEY: "rvp_test_abc" }),
    (error) => error instanceof ConfigError && /environment-scoped/.test(error.message),
  );

  assert.throws(
    () => resolveConfig({ RV_API_BASE_URL: "https://gamma.residencevertical.ro", RV_API_KEY: "not-a-key" }),
    (error) => error instanceof ConfigError && /does not look like a Partner API key/.test(error.message),
  );

  const remote = resolveConfig({
    RV_API_BASE_URL: "https://gamma.residencevertical.ro/",
    RV_API_KEY: "rvp_test_abc",
    PORT: "4321",
    RV_LEDGER_CACHE_MS: "30000",
  });
  assert.equal(remote.mockMode, false);
  assert.equal(remote.baseUrl, "https://gamma.residencevertical.ro");
  assert.equal(remote.port, 4321);
  assert.equal(remote.ledgerCacheMs, 30000);
});
