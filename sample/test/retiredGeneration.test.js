/**
 * The RETIRED partner-generated-report API (guide §13). ResidenceVertical never bills a partner:
 * `POST /reports` is refused with `403 billed_generation_retired`, and the mock reproduces that
 * answer so code copied from an old integration fails loudly here rather than in production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startMock, TEST_KEY, linkBody } from "./helpers.js";

/**
 * The refusal the real service returns, character for character. The mock claims to reproduce it
 * (`sample/README.md`), so the claim is pinned here rather than left to a loose `/earn a
 * commission/` match that an out-of-sync rewording would still satisfy.
 */
const REAL_SERVICE_MESSAGE =
  "Partner-billed report generation is not offered. Reports are sold through checkout links "
  + "(POST /api/partner/v1/checkout-links): your customer pays ResidenceVertical and you earn "
  + "a referral commission.";

test("POST /reports answers 403 billed_generation_retired and points at checkout links", async () => {
  const mock = await startMock();
  try {
    const response = await fetch(`${mock.baseUrl}/api/partner/v1/reports`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(linkBody()),
    });
    assert.equal(response.status, 403);
    assert.ok(response.headers.get("x-rv-request-id"), "even the refusal carries X-RV-Request-Id");
    const { error } = await response.json();
    assert.equal(error.code, "billed_generation_retired");
    assert.equal(error.message, REAL_SERVICE_MESSAGE, "the mock repeats the real refusal word for word");
  } finally {
    await mock.close();
  }
});

test("the retired endpoint still requires a key, and nothing else under /reports is served", async () => {
  const mock = await startMock();
  try {
    const naked = await fetch(`${mock.baseUrl}/api/partner/v1/reports`, { method: "POST" });
    assert.equal(naked.status, 401, "authentication comes first, exactly like the real service");

    const headers = { Authorization: `Bearer ${TEST_KEY}` };
    for (const path of ["/reports", "/reports/some-id", "/reports/some-id/pdf", "/settlements"]) {
      const response = await fetch(`${mock.baseUrl}/api/partner/v1${path}`, { headers });
      assert.equal(response.status, 404, `${path} is not part of the referral program`);
      assert.equal((await response.json()).error.code, "not_found");
    }

    const openapi = await (await fetch(`${mock.baseUrl}/api/partner/v1/openapi.yaml`)).text();
    assert.equal(openapi.includes("/reports"), false, "the OpenAPI stub lists only the referral endpoints");
    assert.equal(openapi.includes("/settlements"), false);
    for (const path of ["/checkout-links:", "/checkout-links/{token}/resolve:", "/me:", "/referrals:"]) {
      assert.ok(openapi.includes(path), `${path} is listed`);
    }
  } finally {
    await mock.close();
  }
});
