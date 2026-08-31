/**
 * The report WEB VIEW: the signed link you hand to your end user, and the two token-authenticated
 * endpoints the page behind it calls.
 *
 * These assert the contract you actually depend on:
 *   - a generated report carries `viewUrl` + `viewExpiresAt`; a processing one carries neither;
 *   - `POST /reports/{id}/view-link` mints a fresh link, and answers 409 before generation;
 *   - the token opens the page data and the PDF, with NO API key;
 *   - a tampered, expired, or foreign-report token is refused — and so is an unknown id, with the
 *     SAME error, so the endpoint never reveals which ids exist;
 *   - nothing commercial (your customer's email, ids, prices) reaches the page payload.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRvClient, RvApiError } from "../lib/rvClient.js";
import { mint, signedPayload, verify } from "../mock/viewTokens.js";
import { renderReportSections } from "../mock/viewPage.js";
import { startMock, waitFor, TEST_KEY, addressBody } from "./helpers.js";

const VIEW_SECRET = "test-view-token-secret";

/**
 * Reports settle instantly here (`reportSeconds: 0`) — only the 409 test needs one to linger, and
 * it says so itself. A fresh 202 still reports `processing`, exactly like the real API.
 */
async function withMock(options, run) {
  const mock = await startMock({ reportSeconds: 0, viewTokenSecret: VIEW_SECRET, ...options });
  try {
    await run(mock);
  } finally {
    await mock.close();
  }
}

const clientFor = (mock) => createRvClient({ baseUrl: mock.baseUrl, apiKey: TEST_KEY, maxRetryDelayMs: 200 });

/** Create a report and wait for it to be generated — the only state that has a web page. */
async function generatedReport(rv, overrides = {}) {
  const { report } = await rv.createReport(addressBody(overrides), { idempotencyKey: `view-${Math.random()}` });
  return waitFor(async () => {
    const current = await rv.getReport(report.reportRequestId);
    return current.status === "generated" ? current : null;
  }, { label: "status=generated" });
}

const tokenOf = (viewUrl) => new URL(viewUrl).searchParams.get("t");

test("a generated report carries viewUrl + viewExpiresAt; a processing one carries neither", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    const { report } = await rv.createReport(addressBody(), { idempotencyKey: "view-pending" });
    assert.equal(report.status, "processing");
    assert.equal("viewUrl" in report, false, "a processing report has no web page yet");
    assert.equal("viewExpiresAt" in report, false);

    const generated = await waitFor(async () => {
      const current = await rv.getReport(report.reportRequestId);
      return current.status === "generated" ? current : null;
    }, { label: "status=generated" });

    assert.ok(generated.viewUrl, "a generated report carries a ready-to-use view link");
    // `<publicBaseUrl>/raport/<reportRequestId>?t=<token>` — the page route, not an API path.
    const url = new URL(generated.viewUrl);
    assert.equal(url.pathname, `/raport/${generated.reportRequestId}`);
    assert.match(url.searchParams.get("t"), /^\d+\.[0-9a-f]{64}$/);
    assert.ok(Date.parse(generated.viewExpiresAt) > Date.now(), "the link expires in the future");
    // The pair sits between downloadUrl and externalReference — the documented key order.
    const keys = Object.keys(generated);
    assert.equal(keys[keys.indexOf("downloadUrl") + 1], "viewUrl");
    assert.equal(keys[keys.indexOf("viewUrl") + 1], "viewExpiresAt");
  });
});

test("createViewLink mints a FRESH link and never revokes the previous one", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    const generated = await generatedReport(rv);

    const link = await rv.createViewLink(generated.reportRequestId);
    assert.equal(link.reportRequestId, generated.reportRequestId);
    assert.ok(link.viewUrl.includes(`/raport/${generated.reportRequestId}?t=`));
    assert.ok(Date.parse(link.viewExpiresAt) > Date.now());

    // Both the link from the status read and the freshly minted one still open the report.
    for (const url of [generated.viewUrl, link.viewUrl]) {
      const response = await fetch(`${mock.baseUrl}/api/partner/v1/reports/${generated.reportRequestId}/view-data?t=${tokenOf(url)}`);
      assert.equal(response.status, 200, "minting a new link must not invalidate an older one");
    }
  });
});

test("view-link is a 409 report_not_ready before the report is generated, 404 for a foreign id", async () => {
  await withMock({ reportSeconds: 30 }, async (mock) => {
    const rv = clientFor(mock);
    const { report } = await rv.createReport(addressBody(), { idempotencyKey: "view-409" });
    await assert.rejects(
      () => rv.createViewLink(report.reportRequestId),
      (error) => error instanceof RvApiError && error.status === 409 && error.code === "report_not_ready",
    );
    await assert.rejects(
      () => rv.createViewLink("00000000-0000-4000-8000-000000000000"),
      (error) => error.status === 404 && error.code === "not_found",
    );
  });
});

test("the view token opens the page data and the PDF — with no API key at all", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    const generated = await generatedReport(rv, { customer: { email: "buyer@example.com", name: "Ion Popescu" } });
    const base = `${mock.baseUrl}/api/partner/v1/reports/${generated.reportRequestId}`;
    const token = tokenOf(generated.viewUrl);

    const response = await fetch(`${base}/view-data?t=${token}`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(Object.keys(payload),
      ["reportRequestId", "generatedAt", "address", "propertyType", "partnerName", "report"]);
    assert.equal(payload.reportRequestId, generated.reportRequestId);
    assert.equal(payload.address.street, "Strada Turda");
    assert.ok(payload.report, "the premium report payload the page renders");

    // Nothing about the commercial relationship may reach a page an end user opens.
    const serialised = JSON.stringify(payload);
    assert.equal(serialised.includes("buyer@example.com"), false, "the customer email must never reach the page");
    for (const forbidden of ["customerEmail", "paymentId", "commission", "reportPriceCents"]) {
      assert.equal(serialised.includes(forbidden), false, `${forbidden} must never reach the page`);
    }

    // The same token also downloads the PDF — that is the page's "Descarcă PDF" button.
    const pdf = await fetch(`${base}/pdf?t=${token}`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");

    // No credential at all is still the plain 401 it always was.
    const naked = await fetch(`${base}/pdf`);
    assert.equal(naked.status, 401);
    assert.equal((await naked.json()).error.code, "unauthorized");
  });
});

test("a tampered, expired, foreign or unknown-report token is refused the same way", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    const generated = await generatedReport(rv);
    const other = await generatedReport(rv, { externalReference: "another-report" });
    const id = generated.reportRequestId;
    const base = `${mock.baseUrl}/api/partner/v1/reports`;
    const token = tokenOf(generated.viewUrl);

    const refusals = {
      "a flipped signature byte": `${base}/${id}/view-data?t=${token.replace(/.$/, (c) => (c === "a" ? "b" : "a"))}`,
      "an expiry pushed out by hand": `${base}/${id}/view-data?t=${Date.now() + 9e9}.${token.split(".")[1]}`,
      "a token that has expired": `${base}/${id}/view-data?t=${mint(VIEW_SECRET, id, Date.now() - 1000)}`,
      "another report's token": `${base}/${id}/view-data?t=${tokenOf(other.viewUrl)}`,
      "a token signed with another secret": `${base}/${id}/view-data?t=${mint("someone-elses-secret", id, Date.now() + 60_000)}`,
      "no token at all": `${base}/${id}/view-data`,
      // An id that does not exist answers exactly like a bad token: the endpoint is reachable by
      // anyone, so it must never confirm which report requests exist.
      "an unknown report request": `${base}/00000000-0000-4000-8000-000000000000/view-data`
        + `?t=${mint(VIEW_SECRET, "00000000-0000-4000-8000-000000000000", Date.now() + 60_000)}`,
    };

    for (const [what, url] of Object.entries(refusals)) {
      const response = await fetch(url);
      assert.equal(response.status, 401, `${what} must be refused`);
      assert.equal((await response.json()).error.code, "invalid_or_expired_view_token", what);
    }

    // …and the PDF path is guarded by the very same grant.
    const pdf = await fetch(`${base}/${id}/pdf?t=${mint(VIEW_SECRET, id, Date.now() - 1000)}`);
    assert.equal(pdf.status, 401);
    assert.equal((await pdf.json()).error.code, "invalid_or_expired_view_token");
  });
});

test("MOCK_VIEW_LINK_TTL_SECONDS drives the link lifetime (the expiry demo hook)", async () => {
  await withMock({ viewLinkTtlSeconds: 3600 }, async (mock) => {
    const generated = await generatedReport(clientFor(mock));
    const lifetimeMs = Date.parse(generated.viewExpiresAt) - Date.now();
    assert.ok(lifetimeMs > 3_500_000 && lifetimeMs <= 3_600_000, `expected a ~1h link, got ${lifetimeMs}ms`);
  });
});

test("the mock serves the report page at /raport/{id}, with no API key", async () => {
  await withMock({}, async (mock) => {
    const generated = await generatedReport(clientFor(mock));
    const response = await fetch(generated.viewUrl);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /Pagină demonstrativă/, "the placeholder says plainly that it is not the real page");
    assert.ok(html.includes(generated.reportRequestId));
    // The PDF button starts `hidden` and is revealed only once the report data loads. The .cta
    // display rule would otherwise beat the browser default and offer a download on a page that
    // refused the token — so the stylesheet has to neutralise [hidden] explicitly.
    assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
      "a refused page must not offer a download button it cannot serve");
  });
});

test("the report page renders titled sections, not raw JSON — and a tampered token is still refused", async () => {
  await withMock({}, async (mock) => {
    const rv = clientFor(mock);
    const generated = await generatedReport(rv);
    const base = `${mock.baseUrl}/api/partner/v1/reports/${generated.reportRequestId}`;
    const token = tokenOf(generated.viewUrl);

    // The section renderer is the one the page inlines (`renderReportSections.toString()`), so
    // running it over the exact payload the page fetches proves what the browser would show:
    // one titled block per top-level report section, humanized titles, no JSON punctuation.
    const payload = await (await fetch(`${base}/view-data?t=${token}`)).json();
    const sections = renderReportSections(payload.report);
    assert.match(sections, /<h2>Analiza zona<\/h2>/, "report keys become section titles");
    assert.match(sections, /<h2>Evaluare investitie<\/h2>/);
    assert.match(sections, /<h2>Location<\/h2>/);
    assert.equal(sections.includes("premium_pdf_title"), false, "raw keys never reach the reader");
    assert.equal(sections.includes("{"), false, "no raw JSON reaches the page");

    // The served HTML carries that renderer instead of the old JSON.stringify dump.
    const html = await (await fetch(generated.viewUrl)).text();
    assert.ok(html.includes("renderReportSections"), "the page embeds the section renderer");
    assert.equal(html.includes("JSON.stringify(payload.report"), false, "the raw JSON dump is gone");

    // A prettier page changes nothing about auth: a tampered token is refused exactly as before.
    const tampered = token.replace(/.$/, (c) => (c === "a" ? "b" : "a"));
    const refused = await fetch(`${base}/view-data?t=${tampered}`);
    assert.equal(refused.status, 401);
    assert.equal((await refused.json()).error.code, "invalid_or_expired_view_token");
  });
});

test("the token format is exactly the documented recipe", () => {
  const id = "0d5f7c1e-8f2b-4c1a-9a1e-3b7d2f6a1c00";
  const expiry = 1789430400000;
  assert.equal(signedPayload(id, expiry), `partner-report-view|${id}|${expiry}`);

  const token = mint(VIEW_SECRET, id, expiry);
  const [expiryPart, digestPart] = token.split(".");
  assert.equal(expiryPart, String(expiry), "the expiry is part of the SIGNED token, not a hint");
  assert.match(digestPart, /^[0-9a-f]{64}$/, "hex hmac-sha256");
  assert.match(token, /^[0-9a-f.]+$/, "the alphabet needs no URL escaping");

  const now = expiry - 1000;
  assert.equal(verify(VIEW_SECRET, id, token, now), true);
  assert.equal(verify(VIEW_SECRET, id, token, expiry), false, "an expiry exactly at now is expired");
  assert.equal(verify(VIEW_SECRET, "another-report", token, now), false);
  assert.equal(verify("another-secret", id, token, now), false);
  for (const malformed of ["", "   ", "no-dot", `${expiry}.`, `.${digestPart}`, `abc.${digestPart}`]) {
    assert.equal(verify(VIEW_SECRET, id, malformed, now), false, `malformed: "${malformed}"`);
  }
});
