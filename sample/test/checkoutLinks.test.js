/**
 * Server-minted CHECKOUT LINKS — the API-backed tier (guide §4.1).
 *
 * These assert the contract you actually depend on:
 *   - the mint is a normal partner endpoint (Bearer key, 401 without it) and answers 201 with
 *     the documented shape: an opaque `pcl_` + 32-alphanumeric token, the `/c/<token>` URL on
 *     the environment's own public base, the expiry (default 48 h, `expiresInHours` 1..720)
 *     and the echoed `externalReference`;
 *   - the public resolve round-trips the minted address with NO API key (the token is the
 *     whole credential), the link stays REUSABLE (a second resolve works — reloads never brick
 *     the buyer), an expired link answers `410 checkout_link_expired`, an unknown token `404`;
 *   - the `/c/<token>` stand-in landing serves the prefill flow and the calm expired-state copy;
 *   - the storefront button path: the partner backend mints through `POST /api/checkout-links`
 *     and hands the browser a URL that opens the checkout landing prefilled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startMock, startPartner, TEST_KEY, linkBody } from "./helpers.js";
import { CHECKOUT_TOKEN_PATTERN } from "../mock/checkoutLinks.js";

const HOUR_MS = 3600_000;

async function mint(mock, body, { key = TEST_KEY } = {}) {
  const response = await fetch(`${mock.baseUrl}/api/partner/v1/checkout-links`, {
    method: "POST",
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function resolve(mock, token) {
  const response = await fetch(
    `${mock.baseUrl}/api/partner/v1/checkout-links/${encodeURIComponent(token)}/resolve`,
  );
  return { response, body: await response.json() };
}

test("minting a checkout link requires the key and answers the documented 201 shape", async () => {
  const mock = await startMock();
  try {
    const unauthorized = await mint(mock, linkBody(), { key: null });
    assert.equal(unauthorized.response.status, 401);
    assert.equal(unauthorized.body.error.code, "unauthorized");

    const before = Date.now();
    const { response, body } = await mint(mock, linkBody());
    assert.equal(response.status, 201);
    assert.ok(response.headers.get("x-rv-request-id"), "every response carries X-RV-Request-Id");
    assert.deepEqual(Object.keys(body), ["checkoutLinkId", "url", "expiresAt", "externalReference"],
      "the documented wire shape, field for field");
    assert.match(body.checkoutLinkId, CHECKOUT_TOKEN_PATTERN,
      "the token is pcl_ + 32 alphanumeric characters — opaque, never sequential");
    assert.equal(body.url, `${mock.server.baseUrl()}/c/${body.checkoutLinkId}`,
      "the url is /c/<token> on this environment's own public base");
    assert.equal(body.externalReference, "lead-84213", "the lead id is echoed back");

    const expiresInMs = Date.parse(body.expiresAt) - before;
    assert.ok(expiresInMs > 47.9 * HOUR_MS && expiresInMs < 48.1 * HOUR_MS,
      "expiry defaults to 48 hours when expiresInHours is omitted");

    const second = await mint(mock, linkBody());
    assert.notEqual(second.body.checkoutLinkId, body.checkoutLinkId,
      "every mint is a fresh token — links are per mint, not per address");
  } finally {
    await mock.close();
  }
});

test("mint validation: the address rules plus the 1..720 expiresInHours bounds", async () => {
  const mock = await startMock();
  try {
    const missing = await mint(mock, { propertyType: "apartment" });
    assert.equal(missing.response.status, 400);
    assert.equal(missing.body.error.code, "validation_error");
    for (const field of ["address.street", "address.streetNumber", "address.city"]) {
      assert.ok(missing.body.error.fields[field], `field error for ${field}`);
    }

    for (const expiresInHours of [0, 721, 1.5]) {
      const { response, body } = await mint(mock, linkBody({ expiresInHours }));
      assert.equal(response.status, 400, `expiresInHours=${expiresInHours} is out of bounds`);
      assert.ok(body.error.fields.expiresInHours.includes("between 1 and 720"));
    }

    const before = Date.now();
    const max = await mint(mock, linkBody({ expiresInHours: 720 }));
    assert.equal(max.response.status, 201);
    const expiresInMs = Date.parse(max.body.expiresAt) - before;
    assert.ok(expiresInMs > 719 * HOUR_MS && expiresInMs < 721 * HOUR_MS,
      "an explicit expiresInHours is honoured up to the 720 h (30 day) maximum");

    const badEmail = await mint(mock, linkBody({ customer: { email: "not-an-email" } }));
    assert.equal(badEmail.response.status, 400);
    assert.ok(badEmail.body.error.fields["customer.email"], "customer.email must be RFC-shaped");
  } finally {
    await mock.close();
  }
});

test("the public resolve round-trips the minted address with no API key, and the link stays reusable", async () => {
  const mock = await startMock();
  try {
    const minted = await mint(mock, linkBody({ customer: { email: "Buyer@Example.com" } }));
    const token = minted.body.checkoutLinkId;

    const { response, body } = await resolve(mock, token);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), [
      "partnerSlug", "partnerName", "address", "propertyType", "customerEmail", "expiresAt",
    ], "the documented resolve shape, field for field");
    assert.equal(body.partnerSlug, "portal-imobiliar-mock");
    assert.ok(body.partnerName, "partnerName feeds the 'Comandă prin partener' chip");
    assert.deepEqual(body.address, {
      street: "Strada Turda", streetNumber: "94", city: "București", county: null, postalCode: "011332",
    }, "the address round-trips exactly; optional fields you did not send come back null");
    assert.equal(body.propertyType, "apartment");
    assert.equal(body.customerEmail, "buyer@example.com", "the optional prefill email, normalised");
    assert.equal(body.expiresAt, minted.body.expiresAt, "resolve reports the same expiry the mint did");

    // REUSABLE by design: a reload or back button must never brick the buyer.
    const again = await resolve(mock, token);
    assert.equal(again.response.status, 200, "a link is not consumed by use");

    const unknown = await resolve(mock, "pcl_00000000000000000000000000000000");
    assert.equal(unknown.response.status, 404);
    assert.equal(unknown.body.error.code, "not_found");
  } finally {
    await mock.close();
  }
});

test("an expired link resolves 410 checkout_link_expired; the /c landing serves the calm state", async () => {
  // MOCK-ONLY lever: every link lives 0 s, so the expiry branch is deterministic in a test.
  const mock = await startMock({ checkoutLinkTtlSeconds: 0 });
  try {
    const minted = await mint(mock, linkBody());
    const token = minted.body.checkoutLinkId;

    const { response, body } = await resolve(mock, token);
    assert.equal(response.status, 410, "expired is 410, distinct from unknown's 404");
    assert.equal(body.error.code, "checkout_link_expired");

    // The landing itself still answers 200 HTML — the state is decided by the resolve call the
    // page makes, and the buyer gets the calm way-out copy, never a dead end.
    const page = await fetch(`${mock.baseUrl}/c/${token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.ok(html.includes("Linkul de comandă nu mai este valid. Cere partenerului un link nou."),
      "the calm expired-state copy");
    assert.ok(html.includes("Mergi la formular"), "always a way forward for the buyer");
    assert.ok(html.includes("/resolve"), "the page resolves the token through the public endpoint");
  } finally {
    await mock.close();
  }
});

test("storefront button path: the partner backend mints and the landing opens prefilled", async () => {
  const mock = await startMock();
  const partner = await startPartner({ baseUrl: mock.baseUrl, apiKey: TEST_KEY });
  try {
    const response = await fetch(`${partner.baseUrl}/api/checkout-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        street: "Strada Turda", streetNumber: "94", city: "București",
        postalCode: "011332", propertyType: "apartment",
      }),
    });
    assert.equal(response.status, 201);
    const link = await response.json();
    assert.match(link.checkoutLinkId, CHECKOUT_TOKEN_PATTERN);
    assert.ok(link.checkoutUrl.startsWith(`${mock.server.baseUrl()}/c/`),
      "the browser gets a ResidenceVertical URL — the partner backend is out of the buyer's path");
    assert.match(link.leadId, /^lead-/,
      "the backend keyed the mint by its own lead id — the per-lead tracking handle");

    // The minted link round-trips: our checkout landing would prefill exactly what was sent.
    const { response: resolved, body } = await resolve(mock, link.checkoutLinkId);
    assert.equal(resolved.status, 200);
    assert.deepEqual(body.address, {
      street: "Strada Turda", streetNumber: "94", city: "București", county: null, postalCode: "011332",
    });

    // And the URL the buyer clicks serves the landing with the co-branding chip flow.
    const page = await fetch(link.checkoutUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes("Comandă prin partener"), "the discreet co-branding chip copy");
    assert.ok(html.includes(link.checkoutLinkId), "the landing carries the token it will resolve");
  } finally {
    await partner.close();
    await mock.close();
  }
});
