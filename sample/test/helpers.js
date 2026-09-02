/** Test helpers: start the mock and the partner backend on ephemeral ports, no fixed ports. */
import { once } from "node:events";
import { createMockServer } from "../mock-rv-api.js";
import { createPartnerServer } from "../server.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

export async function startMock(options = {}) {
  const server = createMockServer({ quiet: true, ...options });
  const baseUrl = await listen(server);
  return { server, baseUrl, close: () => closeServer(server) };
}

/** The partner backend, with the ledger cache off so every read hits the mock. */
export async function startPartner(config) {
  const server = createPartnerServer({ mockMode: true, ledgerCacheMs: 0, ...config });
  const baseUrl = await listen(server);
  return { server, baseUrl, store: server.store, close: () => closeServer(server) };
}

export function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const TEST_KEY = "rvp_test_0123456789012345678901234567890123456789";

/** A valid `POST /checkout-links` body, with overrides merged one level deep. */
export const linkBody = (overrides = {}) => ({
  address: {
    street: "Strada Turda", streetNumber: "94", city: "București", postalCode: "011332",
    ...overrides.address,
  },
  propertyType: "apartment",
  externalReference: "lead-84213",
  ...overrides,
});
