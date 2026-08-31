import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, ConfigError } from "../server.js";
import { sign } from "../lib/webhookSignature.js";
import { deliveryIdFor } from "../mock/webhookSender.js";
import { startMock, startPartner, waitFor, TEST_KEY, TEST_WEBHOOK_SECRET } from "./helpers.js";

const PROPERTY = {
  street: "Strada Turda", streetNumber: "94", city: "București", county: "București",
  postalCode: "011332", propertyType: "apartment",
};

/** Partner backend + mock, wired together on ephemeral ports. */
async function withStack(run, { mockOptions = {}, partnerOverrides = {} } = {}) {
  const mock = await startMock(mockOptions);
  const partner = await startPartner({
    baseUrl: mock.baseUrl, apiKey: TEST_KEY, webhookSecret: TEST_WEBHOOK_SECRET, ...partnerOverrides,
  });
  try {
    await run({ mock, partner });
  } finally {
    await partner.close();
    await mock.close();
  }
}

const postOrder = (partner, body = PROPERTY) => fetch(`${partner.baseUrl}/api/orders`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const webhookBody = (report, event = "report.generated") => JSON.stringify({
  event,
  deliveryId: deliveryIdFor(report.reportRequestId, event),
  sentAt: new Date().toISOString(),
  data: report,
});

function signedHeaders(body, secret = TEST_WEBHOOK_SECRET, event = "report.generated", deliveryId) {
  const { timestamp, signature } = sign(body, secret);
  return {
    "Content-Type": "application/json",
    "X-RV-Event": event,
    "X-RV-Delivery-Id": deliveryId ?? JSON.parse(body).deliveryId,
    "X-RV-Timestamp": timestamp,
    "X-RV-Signature": signature,
    "User-Agent": "ResidenceVertical-Webhooks/1.0",
  };
}

test("order → poll → PDF proxy (the browser never sees the API key)", async () => {
  await withStack(async ({ partner }) => {
    const created = await postOrder(partner);
    assert.equal(created.status, 201);
    const order = await created.json();
    assert.ok(order.orderId);
    assert.ok(order.reportRequestId, "the create response carries our reportRequestId");
    assert.equal(order.status, "processing");
    assert.equal(order.downloadPath, null);

    const generated = await waitFor(async () => {
      const current = await (await fetch(`${partner.baseUrl}/api/orders/${order.orderId}`)).json();
      return current.status === "generated" ? current : null;
    }, { label: "the partner's own order to become generated" });
    assert.equal(generated.downloadPath, `/api/orders/${order.orderId}/pdf`);

    const pdfResponse = await fetch(`${partner.baseUrl}${generated.downloadPath}`);
    assert.equal(pdfResponse.status, 200);
    assert.equal(pdfResponse.headers.get("content-type"), "application/pdf");
    assert.match(pdfResponse.headers.get("content-disposition"), /^attachment; filename="raport-imobiliar-.+\.pdf"$/);
    const bytes = Buffer.from(await pdfResponse.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(bytes.length > 500);

    // The demo page only ever talks to this backend; nothing it can reach exposes the key.
    const config = await (await fetch(`${partner.baseUrl}/api/config`)).json();
    assert.equal(config.mode, "mock");
    assert.equal(JSON.stringify(config).includes(TEST_KEY), false, "the API key must never be exposed");
    const wire = await (await fetch(`${partner.baseUrl}/api/wire-log`)).json();
    assert.equal(JSON.stringify(wire).includes(TEST_KEY), false, "the API key must never be logged");
    assert.ok(wire.entries.some((entry) => entry.label === "POST /reports" && entry.status === 202));
  });
});

test("a generated order carries the report web link, and can re-mint it on demand", async () => {
  await withStack(async ({ partner }) => {
    const order = await (await postOrder(partner)).json();
    assert.equal(order.viewUrl, null, "there is no web page before the report is generated");

    const generated = await waitFor(async () => {
      const current = await (await fetch(`${partner.baseUrl}/api/orders/${order.orderId}`)).json();
      return current.status === "generated" ? current : null;
    }, { label: "the partner's own order to become generated" });

    // Stored next to the order — this is the URL your "Vezi raportul" button points at. It goes
    // straight to the browser: unlike downloadUrl, it carries no API key.
    assert.ok(generated.viewUrl, "the order carries the signed link to the report web page");
    assert.equal(new URL(generated.viewUrl).pathname, `/raport/${generated.reportRequestId}`);
    assert.ok(Date.parse(generated.viewExpiresAt) > Date.now());
    assert.equal(partner.store.get(order.orderId).viewUrl, generated.viewUrl, "persisted, not just echoed");

    // "The link expired — give me a new one." One call, and older links keep working.
    const reissued = await fetch(`${partner.baseUrl}/api/orders/${order.orderId}/view-link`, { method: "POST" });
    assert.equal(reissued.status, 200);
    const refreshed = await reissued.json();
    assert.equal(new URL(refreshed.viewUrl).pathname, `/raport/${generated.reportRequestId}`);
    assert.equal(partner.store.get(order.orderId).viewUrl, refreshed.viewUrl);

    // The demo never exposes the key, not even on the new route.
    const wire = await (await fetch(`${partner.baseUrl}/api/wire-log`)).json();
    assert.equal(JSON.stringify(wire).includes(TEST_KEY), false);
    assert.ok(wire.entries.some((entry) => entry.label.includes("/view-link") && entry.status === 200));
  });
});

test("re-minting a link is a 409 while the report is still processing", async () => {
  await withStack(async ({ partner }) => {
    const order = await (await postOrder(partner)).json();
    const response = await fetch(`${partner.baseUrl}/api/orders/${order.orderId}/view-link`, { method: "POST" });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).status, "processing");
  }, { mockOptions: { reportSeconds: 30 } });
});

test("the PDF endpoint answers 409 while the report is still processing", async () => {
  await withStack(async ({ partner }) => {
    const order = await (await postOrder(partner)).json();
    const early = await fetch(`${partner.baseUrl}/api/orders/${order.orderId}/pdf`);
    assert.equal(early.status, 409);
    assert.equal((await early.json()).status, "processing");
  });
});

test("one order id = one report: re-posting the same orderId replays, never bills twice", async () => {
  await withStack(async ({ partner }) => {
    const first = await (await postOrder(partner, { ...PROPERTY, orderId: "ord-fixed" })).json();
    const second = await (await postOrder(partner, { ...PROPERTY, orderId: "ord-fixed" })).json();
    assert.equal(second.reportRequestId, first.reportRequestId);
    const list = await (await fetch(`${partner.baseUrl}/api/wire-log`)).json();
    assert.ok(list.entries.some((entry) => entry.label === "idempotent replay (200)"));
  });
});

test("a create rejected upstream surfaces the error code instead of a stack trace", async () => {
  await withStack(async ({ partner }) => {
    const response = await postOrder(partner, { ...PROPERTY, street: "Strada Maintenance", streetNumber: "1" });
    assert.equal(response.status, 502);
    const order = await response.json();
    assert.equal(order.status, "create_failed");
    assert.equal(order.error.code, "maintenance");
    assert.ok(order.error.requestId, "the X-RV-Request-Id is kept for support");
  });
});

test("the webhook endpoint accepts a correctly signed delivery and applies it", async () => {
  await withStack(async ({ partner }) => {
    const order = await (await postOrder(partner)).json();
    const report = {
      reportRequestId: order.reportRequestId,
      reportId: order.reportId,
      status: "generated",
      failureReason: null,
      createdAt: order.createdAt,
      generatedAt: new Date().toISOString(),
      downloadUrl: `http://example.invalid/api/partner/v1/reports/${order.reportRequestId}/pdf`,
      externalReference: order.orderId,
      address: { street: PROPERTY.street, streetNumber: PROPERTY.streetNumber, city: PROPERTY.city, county: null, postalCode: null },
      coordinates: { lat: 44.46, lng: 26.05 },
      propertyType: "apartment",
    };
    const body = webhookBody(report);
    const response = await fetch(`${partner.baseUrl}/webhooks/residencevertical`, {
      method: "POST", headers: signedHeaders(body), body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true });

    const stored = partner.store.get(order.orderId);
    assert.equal(stored.status, "generated");
    assert.equal(stored.notifiedBy, "webhook");
    assert.equal(stored.lastDeliveryId, deliveryIdFor(order.reportRequestId, "report.generated"));
  });
});

test("the webhook endpoint rejects a bad signature with 401 and changes nothing", async () => {
  await withStack(async ({ partner }) => {
    const order = await (await postOrder(partner)).json();
    const body = webhookBody({ reportRequestId: order.reportRequestId, status: "generated", externalReference: order.orderId });

    const forged = await fetch(`${partner.baseUrl}/webhooks/residencevertical`, {
      method: "POST", headers: signedHeaders(body, "whsec_attacker_secret"), body,
    });
    assert.equal(forged.status, 401);

    const tamperedBody = body.replace('"generated"', '"failed"');
    const tampered = await fetch(`${partner.baseUrl}/webhooks/residencevertical`, {
      method: "POST", headers: signedHeaders(body), body: tamperedBody,
    });
    assert.equal(tampered.status, 401);

    assert.equal(partner.store.get(order.orderId).status, "processing", "a rejected delivery must not mutate state");
  });
});

test("a duplicate deliveryId is acknowledged but processed only once", async () => {
  await withStack(async ({ partner }) => {
    const order = await (await postOrder(partner)).json();
    const report = {
      reportRequestId: order.reportRequestId, status: "generated", failureReason: null,
      generatedAt: "2026-08-18T10:03:12Z", externalReference: order.orderId,
    };
    const body = webhookBody(report);
    const send = () => fetch(`${partner.baseUrl}/webhooks/residencevertical`, {
      method: "POST", headers: signedHeaders(body), body,
    });

    assert.deepEqual(await (await send()).json(), { received: true });
    const replay = await send();
    assert.equal(replay.status, 200, "a duplicate must still be acknowledged, or we keep retrying it");
    assert.deepEqual(await replay.json(), { received: true, duplicate: true });

    const wire = await (await fetch(`${partner.baseUrl}/api/wire-log`)).json();
    assert.equal(wire.entries.filter((entry) => entry.note?.includes("duplicate deliveryId ignored")).length, 1);
  });
});

test("end to end: the mock signs a real delivery and the partner endpoint accepts it", async () => {
  await withStack(async ({ mock, partner }) => {
    // The account webhook URL is configured out-of-band on the real platform; here we point the
    // mock at the partner backend that just came up on its ephemeral port.
    mock.server.setAccountWebhookUrl(`${partner.baseUrl}/webhooks/residencevertical`);

    const order = await (await postOrder(partner)).json();
    // Nothing polls in this test: the ONLY thing that can move this order is the signed webhook.
    const stored = await waitFor(
      () => {
        const current = partner.store.get(order.orderId);
        return current.notifiedBy === "webhook" ? current : null;
      },
      { label: "a signed webhook delivery from the mock" },
    );
    assert.equal(stored.status, "generated");
    assert.equal(stored.lastDeliveryId, deliveryIdFor(order.reportRequestId, "report.generated"));
    // The delivery alone carried a ready-to-use link: nothing polled, nothing called view-link,
    // and the order can already show "Vezi raportul".
    assert.ok(stored.viewUrl, "report.generated carries viewUrl — no follow-up call needed");
    assert.equal(new URL(stored.viewUrl).pathname, `/raport/${order.reportRequestId}`);
    assert.ok(Date.parse(stored.viewExpiresAt) > Date.now());
  }, { mockOptions: { webhookSecret: TEST_WEBHOOK_SECRET } });
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
    RV_WEBHOOK_SECRET: "whsec_abc",
    PORT: "4321",
  });
  assert.equal(remote.mockMode, false);
  assert.equal(remote.baseUrl, "https://gamma.residencevertical.ro");
  assert.equal(remote.port, 4321);
});
