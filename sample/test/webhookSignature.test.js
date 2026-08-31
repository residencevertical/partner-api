import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verify, sign, DEFAULT_TOLERANCE_SECONDS } from "../lib/webhookSignature.js";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({
  event: "report.generated",
  deliveryId: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
  sentAt: "2026-08-18T10:03:15Z",
  data: { reportRequestId: "0d5f7c1e-8f2b-4c1a-9a1e-3b7d2f6a1c00", status: "generated" },
});

const headersFor = (body, secret, timestamp) => {
  const { timestamp: ts, signature } = sign(body, secret, timestamp);
  return { "content-type": "application/json", "x-rv-timestamp": ts, "x-rv-signature": signature };
};

test("accepts a correctly signed delivery", () => {
  assert.equal(verify(BODY, headersFor(BODY, SECRET), SECRET), true);
});

test("accepts a Buffer body (raw bytes, as received off the wire)", () => {
  const raw = Buffer.from(BODY, "utf8");
  assert.equal(verify(raw, headersFor(raw, SECRET), SECRET), true);
});

test("the signature is exactly hex(hmac_sha256(secret, `${timestamp}.${rawBody}`))", () => {
  const timestamp = 1_800_000_000;
  const expected = createHmac("sha256", SECRET).update(`${timestamp}.${BODY}`, "utf8").digest("hex");
  assert.equal(sign(BODY, SECRET, timestamp).signature, `v1=${expected}`);
  assert.equal(verify(BODY, headersFor(BODY, SECRET, timestamp), SECRET, { nowSeconds: timestamp }), true);
});

test("rejects a signature made with the wrong secret", () => {
  assert.equal(verify(BODY, headersFor(BODY, "whsec_someone_else"), SECRET), false);
});

test("rejects a tampered body (one byte is enough)", () => {
  const headers = headersFor(BODY, SECRET);
  const tampered = BODY.replace('"generated"', '"failed"');
  assert.equal(verify(tampered, headers, SECRET), false);
});

test("rejects a stale timestamp outside the 300 s tolerance", () => {
  const now = 1_800_000_000;
  const headers = headersFor(BODY, SECRET, now - DEFAULT_TOLERANCE_SECONDS - 1);
  assert.equal(verify(BODY, headers, SECRET, { nowSeconds: now }), false);
  // …and accepts one just inside it (a replayed delivery is the threat, not a slow network).
  assert.equal(
    verify(BODY, headersFor(BODY, SECRET, now - DEFAULT_TOLERANCE_SECONDS + 1), SECRET, { nowSeconds: now }),
    true,
  );
});

test("rejects a timestamp too far in the FUTURE (clock skew is not a free pass)", () => {
  const now = 1_800_000_000;
  assert.equal(verify(BODY, headersFor(BODY, SECRET, now + 3600), SECRET, { nowSeconds: now }), false);
});

test("rejects missing headers", () => {
  const complete = headersFor(BODY, SECRET);
  assert.equal(verify(BODY, {}, SECRET), false);
  assert.equal(verify(BODY, { "x-rv-timestamp": complete["x-rv-timestamp"] }, SECRET), false);
  assert.equal(verify(BODY, { "x-rv-signature": complete["x-rv-signature"] }, SECRET), false);
});

test("rejects a malformed v1= prefix or a non-hex digest", () => {
  const { timestamp, signature } = sign(BODY, SECRET);
  const hex = signature.slice(3);
  const cases = [hex, `v2=${hex}`, `v1 ${hex}`, "v1=", `v1=${hex.slice(0, 63)}`, `v1=${"z".repeat(64)}`];
  for (const value of cases) {
    assert.equal(
      verify(BODY, { "x-rv-timestamp": timestamp, "x-rv-signature": value }, SECRET),
      false,
      `expected rejection for signature header: ${value.slice(0, 24)}…`,
    );
  }
});

test("rejects a non-numeric timestamp", () => {
  const { signature } = sign(BODY, SECRET);
  assert.equal(verify(BODY, { "x-rv-timestamp": "not-a-number", "x-rv-signature": signature }, SECRET), false);
});

test("rejects when no secret is configured", () => {
  assert.equal(verify(BODY, headersFor(BODY, SECRET), ""), false);
  assert.equal(verify(BODY, headersFor(BODY, SECRET), undefined), false);
});

test("header lookup is case-insensitive and works with a Headers object", () => {
  const { timestamp, signature } = sign(BODY, SECRET);
  assert.equal(verify(BODY, { "X-RV-Timestamp": timestamp, "X-RV-Signature": signature }, SECRET), true);
  assert.equal(
    verify(BODY, new Headers({ "x-rv-timestamp": timestamp, "x-rv-signature": signature }), SECRET),
    true,
  );
});

test("an uppercase hex digest is accepted (the comparison is case-insensitive, not the prefix)", () => {
  const { timestamp, signature } = sign(BODY, SECRET);
  const upper = `v1=${signature.slice(3).toUpperCase()}`;
  assert.equal(verify(BODY, { "x-rv-timestamp": timestamp, "x-rv-signature": upper }, SECRET), true);
});
