# ResidenceVertical Partner API — reference integration (Node.js)

A complete, runnable integration you can read in 20 minutes and copy from: a demo property page,
the partner backend behind it, and **a local mock of the ResidenceVertical Partner API** so you can
build and test everything **before we issue you an API key**.

- **Zero dependencies.** Node.js ≥ 20 built-ins only (`node:http`, `node:crypto`, global `fetch`,
  `node:test`). No `npm install`, no build step, no framework.
- Point it at the real environment with **two environment variables** — no code change.
- Contract source of truth: the [Partner API integration guide](../../docs/integrations/partner-api.md)
  and the OpenAPI document served at `GET /api/partner/v1/openapi.yaml`
  (`curl https://gamma.residencevertical.ro/api/partner/v1/openapi.yaml`).

## 60-second start

```bash
cd samples/partner-api-node

node mock-rv-api.js     # terminal 1 — the fake ResidenceVertical API on :4010
node server.js          # terminal 2 — your demo site + backend on :4000
```

Open **http://localhost:4000**, pick a scenario and press *"Generează raportul ResidenceVertical"*.
The report becomes `generated` after 20 seconds (`MOCK_REPORT_SECONDS`) — then click
**"Vezi raportul"**: the report page opens in a new tab. That is the success criterion, and it is
exactly what your user will do in production. A secondary *"Descarcă PDF"* button serves the
optional PDF export, and the panel at the bottom shows every HTTP exchange between the backend and
the API, including the signed webhook coming back.

A second box on the same page demonstrates **referral mode's recommended tier** (guide §2.1):
*"Generează link checkout"* asks the backend to mint a server-attributed checkout link for the
selected address (`POST /checkout-links`, keyed by its own lead id as `externalReference`), then
*"Deschide linkul de comandă"* opens the `/c/<token>` stand-in landing — the mock's sketch of the
ResidenceVertical checkout, prefilled, under the "Comandă prin partener" chip.

Nothing is installed, nothing is persisted: both processes are in-memory.

## The page is the deliverable; the PDF is an optional export

What your user gets is the report **web page** (`viewUrl`) — the same interactive report
ResidenceVertical's own buyers read, with the PDF download offered on the page itself. The PDF
endpoint (`downloadUrl`) exists for flows that need the file server-side, and the demo shows both:

| | The web page (`viewUrl`) — the deliverable | The PDF (`downloadUrl`) — optional export |
|---|---|---|
| Who fetches it | your **user's browser**, directly | your **backend**, then you serve it |
| Credential | the signed `?t=` token in the URL — **no API key** | your `Authorization: Bearer rvp_…` key |
| Lifetime | expires (30 days by default), re-mintable | permanent, as long as you keep the file |
| What you do | store `viewUrl`, put it behind a button | download once, cache, serve from your storage |

One link gives your user everything. The page carries no ResidenceVertical purchase CTAs and
nothing about your commercial relationship with us.

## What the flow looks like

```
browser ──POST /api/orders────────► partner backend ──POST /reports (Bearer key)──► ResidenceVertical
        ◄─ your order (processing)                  ◄─ 202 { reportRequestId }
        ──GET /api/orders/:id (2 s)─►               ──GET /reports/{id} (≤ 1 per 3 s)──►
                                                    ◄─ POST /webhooks/… (signed, carries viewUrl)

        ──"Vezi raportul" ─────────────────────────────────────────────────────────────►
          the browser opens viewUrl on ResidenceVertical directly — your backend is not
          in the path. THIS is the deliverable.

        ──GET /api/orders/:id/pdf──►               ──GET /reports/{id}/pdf ─────────────►
        ◄─ application/pdf                          ◄─ PDF bytes        (optional export)
```

The browser only ever talks to **your** backend, with one deliberate exception: the report page,
which is on our domain and needs no key. The API key stays server-side, and the PDF is proxied —
`downloadUrl` is never handed to a browser (it requires your key).

## Files — what to copy, what to throw away

| File | Keep? | What it is |
|---|---|---|
| `lib/webhookSignature.js` | **copy verbatim** | Signature verification. Raw body, constant-time compare, 300 s tolerance. The one file you must not improvise. |
| `lib/rvClient.js` | **copy and adapt** | The API client: typed `RvApiError`, `Retry-After` handling, `createViewLink`, the retry policy that matches the documented semantics. |
| `lib/store.js` | **read the comment, then replace** | Models the one table you really need (your order ↔ our `reportRequestId`). Its header lists the recommended columns. |
| `server.js` | **read as a worked example** | Your backend: create, poll-with-cache, PDF proxy, webhook endpoint. ~300 lines, no framework. |
| `public/*` | throw away | The demo storefront (Romanian) + the live wire log. |
| `mock-rv-api.js`, `mock/*` | throw away | The local mock of our API. Useful until you have a key — and afterwards for tests and CI. |
| `test/*` | steal the ideas | `node:test` suites for the signature, the client and the backend. |

## Environment variables

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `RV_API_BASE_URL` | `http://localhost:4010` | `server.js` | Where the Partner API lives. `https://gamma.residencevertical.ro` for the test environment, `https://residencevertical.ro` for production. |
| `RV_API_KEY` | a fake key in mock mode | `server.js` | Your key. **Required** as soon as `RV_API_BASE_URL` is not localhost. `rvp_test_…` = gamma, `rvp_live_…` = production. |
| `RV_WEBHOOK_SECRET` | the mock's secret in mock mode | `server.js` | The `whsec_…` secret. Without it, deliveries cannot be verified and are rejected with 401 (polling still works). |
| `PORT` | `4000` | `server.js` | Port of the demo site. |
| `RV_STATUS_CACHE_MS` | `3000` | `server.js` | How long a report status may be served from cache before asking us again. |
| `MOCK_PORT` | `4010` | mock | Port of the mock. |
| `MOCK_REPORT_SECONDS` | `20` | mock | Seconds until a report becomes `generated`. The real one takes up to ~4 minutes. |
| `MOCK_WEBHOOK_URL` | `http://localhost:4000/webhooks/residencevertical` | mock | The **account** webhook URL — the mock's stand-in for the URL our team configures on your account. Empty = no webhooks. |
| `MOCK_WEBHOOK_SECRET` | `whsec_local_mock_secret` | mock | The secret the mock signs with. Must match `RV_WEBHOOK_SECRET`. |
| `MOCK_WEBHOOK_RETRY_DELAYS_MS` | `60000,300000,900000,3600000,10800000` | mock | Retry schedule after a failed delivery (production values). Shorten it to watch retries. |
| `MOCK_VIEW_LINK_TTL_SECONDS` | `2592000` (30 days) | mock | How long a report view link stays valid. **Set it to a few seconds to watch a link expire** (see below). |
| `MOCK_VIEW_TOKEN_SECRET` | `mock-view-token-secret` | mock | The secret the mock signs view tokens with. You never need this against a real environment — ResidenceVertical mints the links. |
| `MOCK_CHECKOUT_LINK_TTL_SECONDS` | *(unset — honour `expiresInHours`)* | mock | **Mock-only demo lever**: when set, every checkout link lives this many seconds regardless of the request's `expiresInHours` (whose 1..720 validation is unchanged), so you can watch a link expire into the calm state without waiting an hour. |
| `MOCK_BOOM_FAILURES` | `1` | mock | How many consecutive `502`s the `Boom` hook answers before succeeding. Set it high to test a persistent outage. |
| `MOCK_DAILY_CAP` | `100` | mock | Daily report cap before `429 daily_cap_exceeded`. |
| `MOCK_COMMISSION_PCT` | `15` | mock | What `GET /me` reports as your revenue share. |

See `.env.example`. There is no dotenv — export the variables or prefix the command.

## Test hooks (mock only)

The mock is driven by the **address**, so you can exercise every branch in seconds instead of
waiting for the real thing. A hook fires when `address.street` contains the keyword **as a whole
word**, case-insensitively (so a real street like *Strada Căpitan Ioan* never trips `Cap`).

| Street contains | What the mock does | The code path you are testing |
|---|---|---|
| *(nothing special)* | `202` → `processing` → `generated` after `MOCK_REPORT_SECONDS` | The happy path. |
| `Fail` | `202`, then the report ends `status=failed`, `failureReason=report_failed`, and a `report.failed` webhook fires | Terminal failure: tell your user, do not retry the same request. Nothing is billed. |
| `Slow` | Generation takes **3×** as long | Your "still processing" UI, and the fact that polling has to keep going. |
| `Cap` | `429 daily_cap_exceeded` + `Retry-After` (seconds until midnight, Europe/Bucharest) | Your queue's back-pressure. Never sleep on this `Retry-After` — reschedule. |
| `Maintenance` | `503 maintenance` + `Retry-After: 60` | A deploy window on our side. Retry after the delay. |
| `Boom` | `502 report_service_unavailable` for the first `MOCK_BOOM_FAILURES` attempts, then succeeds | Transient upstream failure. **The `Idempotency-Key` is not consumed** — retrying with the same key creates a fresh attempt, so you are never billed twice. A `report.failed` (`report_service_error`) webhook may still arrive for the failed attempt; correlate it by `data.externalReference`. |
| `Geo` | `502 geocoding_failed` (only when you send no `coordinates`) | An address we cannot resolve. Fix the address or send `coordinates` — the key is not consumed. |

Other things the mock reproduces faithfully: `401 unauthorized` for anything that is not a
`rvp_test_…` key, `400 validation_error` with the real per-field messages in `error.fields`,
`409 idempotency_conflict`, `409 report_not_ready` before the report exists, `404 not_found`,
`X-RV-Request-Id` on every response, and a **genuinely valid PDF** (it opens in any viewer and
carries the address and `reportRequestId` on the page).

`GET /settlements` (guide §16) returns one canned weekly settlement — status `invoiced`, last
complete Monday→Sunday week, `net = gross − commission` on 7-day terms — so you can build your
invoice reconciliation before a real week has ever settled.

`GET /referrals` and the `referral` block on `GET /me` (guide §2) serve a canned **referral-mode**
ledger — one row per state (`pending`, `earned` unpaid, `earned` paid out, `void`) with the `/me`
totals computed from the same rows, so the two surfaces always agree and you can build your
payout reconciliation before a single real referral exists. Rows attributed through a checkout
link carry `externalReference` + `checkoutLinkId` (the per-lead tracking); zero-code `/p` rows
carry `null` for both.

**Checkout links** (guide §2.1 — referral mode's recommended tier) are fully implemented:
`POST /checkout-links` mints a `pcl_…` token (Bearer key; address/propertyType validation, the
1..720 `expiresInHours` bounds, default 48 h), the **public** `GET /checkout-links/{token}/resolve`
answers the documented `200` / `410 checkout_link_expired` / `404`, links stay **reusable until
expiry** (resolving never consumes one), and `/c/{token}` serves a clearly labelled stand-in of
the checkout landing — prefilled form sketch, "Comandă prin partener" chip, and the calm
*"Linkul de comandă nu mai este valid"* state once the link lapses.

### Watching a view link expire

Links are the one part of the contract that changes over time, so the mock lets you compress 30
days into a few seconds:

```bash
MOCK_VIEW_LINK_TTL_SECONDS=10 node mock-rv-api.js
```

Generate a report, open *"Vezi raportul"*, then reload the page ten seconds later: it flips to the
same *"Linkul nu mai este valid"* state your user would see, and *"Link expirat? Re-emite"* on the
demo storefront calls `POST /reports/{id}/view-link` and hands you a working link again. Older
links are never revoked by minting a new one — they simply run out on their own schedule.

The tokens are real HMACs, minted with the documented recipe
(`<expiryEpochMillis>.<hex hmac_sha256(secret, "partner-report-view|<id>|<expiryEpochMillis>")>`,
see `mock/viewTokens.js`), so tampering with one in the URL bar gets it refused exactly as it would
be in production. You never mint these yourself against a real environment — we do, and you store
the finished `viewUrl`.

Three deliberate differences from the real service: `GET /openapi.yaml` returns a short stub that
points at the authoritative document, the reports are fake (the mock never generates real property
intelligence), and `/raport/{id}` is a **clearly labelled placeholder** — it performs the same two
token-authenticated calls the real page performs and renders the report's sections as simple
titled blocks, a sketch of (not a substitute for) the full interactive report.

## Pointing it at gamma

Once ResidenceVertical has issued your key and configured your webhook URL:

```bash
RV_API_BASE_URL=https://gamma.residencevertical.ro \
RV_API_KEY=rvp_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
RV_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxx \
node server.js
```

The banner says `Mode: REMOTE`. Nothing else changes — the same `server.js`, the same client.

Notes for the real environment:

- Reports take **up to ~4 minutes**; the demo's status text already says so.
- Your webhook URL must be reachable from the public internet (loopback and private addresses are
  rejected). For local development use a tunnel (`cloudflared`, `ngrok`) and give us the public
  URL — or simply keep using the mock, which is what it is for.
- Start with `GET /me`: it is the cheapest way to prove a key works.
  `curl -H "Authorization: Bearer $RV_API_KEY" https://gamma.residencevertical.ro/api/partner/v1/me`
- Every **generated** report is billable at the list price on a real environment — settled weekly
  by invoice, with your commission as a visible negative line (guide §16). Reports that end
  `failed` are never billed.

## Tests

```bash
node --test          # 59 tests, ~1.8 s, no dependencies (npm test runs the same thing)
```

- `test/webhookSignature.test.js` — valid delivery, wrong secret, tampered body, stale/future
  timestamp, missing headers, malformed `v1=` prefix, non-hex digest.
- `test/rvClient.test.js` — create → poll → `generated` → PDF bytes starting with `%PDF-`; the
  401, 429 (`Retry-After` is surfaced, not slept on), 502-then-same-key-retry and validation-error
  paths; idempotent replay and conflict; listing and `GET /me`.
- `test/viewLink.test.js` — `viewUrl` present only once generated; `createViewLink` minting a fresh
  link without revoking the old one; the token opening the page data and the PDF with no API key;
  tampered / expired / foreign / unknown-id tokens all refused identically; the `/raport` stand-in
  rendering the report as titled sections (never raw JSON) while a tampered token still gets 401;
  and the guarantee that nothing commercial (your customer's email included) reaches the page
  payload.
- `test/server.test.js` — order → poll → PDF proxy; the order carrying `viewUrl` and re-minting it;
  the webhook endpoint accepting a correctly signed delivery (which already carries a usable link),
  rejecting a forged one with 401, and ignoring a duplicate `deliveryId`; the configuration errors.
- `test/settlements.test.js` — the canned weekly settlement: Bearer-auth like every endpoint, the
  documented wire shape (status `invoiced`, series + number invoice), a complete Monday→Sunday
  period, `net = gross − commission` following the account's percentage, 7-day terms, and the
  shared `{ items, count, limit, offset }` envelope.
- `test/referrals.test.js` — the referral-mode surfaces: Bearer-auth, the documented row shape
  with `pending` / `earned` / `void` states and `paidAt` as the paid marker, commission following
  the account's percentage on every row, the v1.4 per-lead fields (`externalReference` +
  `checkoutLinkId`, together or both `null`), no buyer PII anywhere, and the `/me` referral block
  (`/p/<slug>` link + totals) agreeing with the ledger sums exactly.
- `test/checkoutLinks.test.js` — checkout links (guide §2.1): the Bearer-keyed mint and its 201
  shape (`pcl_` + 32 alphanumerics, `/c/<token>` URL, 48 h default expiry), the address +
  `expiresInHours` 1..720 validation, the public resolve round-tripping the minted address with
  no API key, a link staying reusable across resolves, `410 checkout_link_expired` vs
  `404 not_found`, the `/c` landing's calm expired state, and the storefront button path
  (partner backend mints → the browser gets a prefilled landing URL).

The clock is driven by configuration (`reportSeconds`, `statusCacheMs`), never by sleeping for the
full 20 seconds. Everything listens on ephemeral ports, so the suite never collides with a running
demo.

## Production checklist

- [ ] **Put `viewUrl` behind your "Vezi raportul" button.** The report page is the deliverable —
      store `viewUrl` + `viewExpiresAt` next to the order the moment the report is generated. Do
      not build the URL yourself, and do not treat it as permanent: when it lapses, call
      `POST /reports/{id}/view-link` for a fresh one.
- [ ] **Store the mapping.** `order_id ↔ reportRequestId` in your own table (see `lib/store.js`),
      plus `status`, `report_id` and the last `X-RV-Request-Id`. Support conversations start there.
- [ ] **One stable `Idempotency-Key` per lead.** Use your own order id. A retry with the same key
      replays instead of creating (and billing) a second report. Disable the button after a click.
- [ ] **Never expose the key.** Server-side only — not in browser JS, mobile apps, or a public
      repo. Do not hotlink `downloadUrl`; if you serve the PDF at all, proxy it through your own
      authenticated route. The link that belongs in front of a browser is `viewUrl`.
- [ ] **Verify every webhook signature** over the raw body, in constant time, with the 300 s
      timestamp tolerance. Reject anything that fails with 401.
- [ ] **De-duplicate by `X-RV-Delivery-Id`** (stable across retries of one event) and answer 2xx
      within 10 seconds — do the slow work afterwards, in a job.
- [ ] **Keep polling as a fallback.** Webhooks can be delayed or, after 6 failed attempts,
      abandoned. If you have heard nothing ~6 minutes after creating a request, poll
      `GET /reports/{id}` (then slowly in the background — a request can stay `processing` for
      hours in the worst case).
- [ ] **Handle 429 and 503 by `Retry-After`.** Reschedule; never block a web request on them.
- [ ] **Treat a later status as the truth.** `failed → generated` is rare but real (an operator
      recovery); let the later event overwrite the earlier one.
- [ ] **(Optional) cache the PDF** — the PDF proxy is optional; your user already gets the PDF
      from the report page. If your flow does fetch the file, download once after `generated` and
      serve every later view from your storage.
- [ ] **Log `X-RV-Request-Id`** next to your own request id on every call, success or failure.
- [ ] **Check `GET /me`** to show remaining headroom (`reportsToday` vs `dailyReportCap`) and to
      reconcile `usageThisMonth` against your own numbers.

## Support

`support@residencevertical.ro` — include the environment (test/live), the `reportRequestId`, the
`X-RV-Request-Id` of the failing call, the UTC timestamp and the HTTP status + `error.code`.
