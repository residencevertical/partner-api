/** Test helpers: start the mock and the partner backend on ephemeral ports, no fixed ports. */
import { once } from "node:events";
import { createMockServer } from "../mock-rv-api.js";
import { createPartnerServer } from "../server.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Reports settle in half a second here (the real thing takes ~4 minutes, the mock defaults to
 * 20 s). Long enough that `processing` is observable, short enough that the suite stays fast —
 * the clock is driven by config, never by a `sleep(20_000)`.
 */
export const TEST_REPORT_SECONDS = 0.5;

export async function startMock(options = {}) {
  const server = createMockServer({
    reportSeconds: TEST_REPORT_SECONDS, webhookUrl: null, quiet: true, ...options,
  });
  const baseUrl = await listen(server);
  return { server, baseUrl, close: () => closeServer(server) };
}

export async function startPartner(config) {
  const server = createPartnerServer({ mockMode: true, statusCacheMs: 0, ...config });
  const baseUrl = await listen(server);
  return { server, baseUrl, store: server.store, close: () => closeServer(server) };
}

export function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `check` until it returns a truthy value, or fail after `timeoutMs`. */
export async function waitFor(check, { timeoutMs = 5000, intervalMs = 25, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

export const TEST_KEY = "rvp_test_0123456789012345678901234567890123456789";
export const TEST_WEBHOOK_SECRET = "whsec_test_secret";

export const addressBody = (overrides = {}) => ({
  address: { street: "Strada Turda", streetNumber: "94", city: "București", ...overrides.address },
  propertyType: "apartment",
  ...overrides,
});
