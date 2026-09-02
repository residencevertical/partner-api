# ResidenceVertical Partner API — reference integration (Node.js)

A complete, runnable integration you can read in 15 minutes and copy from: a demo property page,
the partner backend behind it, and **a local mock of the ResidenceVertical Partner API** so you can
build and test everything **before we issue you an API key**.

It implements the **API-backed tier of the referral program** (guide §4): your backend mints a
checkout link per lead, the buyer pays ResidenceVertical directly, and you learn which leads
converted by polling the referral ledger. The link-only tier (guide §3) is shown too — it needs
no code at all.

- **Zero dependencies.** Node.js ≥ 20 built-ins only (`node:http`, `node:crypto`, global `fetch`,
  `node:test`). No `npm install`, no build step, no framework.
- Point it at the real environment with **two environment variables** — no code change.
- Contract source of truth: the [Partner API integration guide](../GUIDE.md)
  and the OpenAPI document served at `GET /api/partner/v1/openapi.yaml`
  (`curl https://gamma.residencevertical.ro/api/partner/v1/openapi.yaml`).

## 60-second start

```bash
cd sample

node mock-rv-api.js     # terminal 1 — the fake ResidenceVertical API on :4010
node server.js          # terminal 2 — your demo site + backend on :4000
```

Open **http://localhost:4000** and press *"Vezi raportul ResidenceVertical"*. The backend mints a
checkout link for the listing (`POST /checkout-links`, keyed by its own lead id as
`externalReference`) and the browser opens the `/c/<token>` stand-in landing — the mock's sketch of
the ResidenceVertical checkout, prefilled, under the *"Comandă prin partener"* chip. That is the
whole hand-off: the buyer pays us, you earn the commission.

The **"Conversiile mele"** panel is your referral ledger, read through the backend from
`GET /referrals` — the canned rows the mock ships, one per state (`pending`, `earned` unpaid,
`earned` paid, `void`). The box under the button shows the link-only alternative: the
`/p/<slug>` URL from `GET /me`, pre-filled with the listing's address through query parameters.
The panel at the bottom shows every HTTP exchange between the backend and the API.

Nothing is installed, nothing is persisted: both processes are in-memory.

## What the flow looks like

```
browser ──POST /api/checkout-links──► partner backend ──POST /checkout-links (Bearer key)──► ResidenceVertical
        ◄─ { checkoutUrl: https://…/c/<token> }       ◄─ 201 { checkoutLinkId, url, expiresAt }

        ──opens checkoutUrl ───────────────────────────────────────────────────────────────►
          the buyer lands on OUR checkout, address prefilled, pays 50 lei to us — your
          backend is not in the payment path. THIS is the hand-off.

        ──GET /api/leads/:id (5 s)──►               ──GET /referrals (cached, ≤ 1 per 5 s)──►
        ◄─ lead + { referral: pending|earned|void }  ◄─ the ledger, matched on externalReference
```

The browser only ever talks to **your** backend, with one deliberate exception: the checkout
landing, which is on our domain and needs no key. The API key stays server-side. There is no
webhook — conversions are read by polling (guide §2.3).

## Files — what to copy, what to throw away

| File | Keep? | What it is |
|---|---|---|
| `lib/rvClient.js` | **copy and adapt** | The API client: `createCheckoutLink`, `listReferrals`, `me`, a typed `RvApiError`, `Retry-After` handling, and the retry policy that matches the documented semantics. |
| `lib/store.js` | **read the comment, then replace** | Models the one table you really need (your lead ↔ our checkout link ↔ the referral row it produced). Its header lists the recommended columns. |
| `server.js` | **read as a worked example** | Your backend: mint-per-lead with reuse, the ledger poll with a cache, the lead view, the account panel. ~250 lines, no framework. |
| `lib/webhookSignature.js` | **keep for later** | HMAC signature verification (raw body, constant time, 300 s tolerance). The referral program has no webhook today; this is the verification a signed notification would use if one is introduced. Tested, unused by `server.js`. |
| `public/*` | throw away | The demo storefront (Romanian) + the live wire log. |
| `mock-rv-api.js`, `mock/*` | throw away | The local mock of our API. Useful until you have a key — and afterwards for tests and CI. |
| `test/*` | steal the ideas | `node:test` suites for the client, the backend, the mock's contract and the signature helper. |

## Environment variables

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `RV_API_BASE_URL` | `http://localhost:4010` | `server.js` | Where the Partner API lives. `https://gamma.residencevertical.ro` for the test environment, `https://residencevertical.ro` for production. |
| `RV_API_KEY` | a fake key in mock mode | `server.js` | Your key. **Required** as soon as `RV_API_BASE_URL` is not localhost. `rvp_test_…` = gamma, `rvp_live_…` = production. |
| `PORT` | `4000` | `server.js` | Port of the demo site. |
| `RV_LEDGER_CACHE_MS` | `5000` | `server.js` | How long the backend serves the referral ledger from cache before polling `GET /referrals` again. Minutes are fine in production (guide §2.3). |
| `MOCK_PORT` | `4010` | mock | Port of the mock. |
| `MOCK_COMMISSION_PCT` | `15` | mock | The account's revenue share — what `GET /me` reports and what every canned referral row is computed with. |
| `MOCK_CHECKOUT_LINK_TTL_SECONDS` | *(unset — honour `expiresInHours`)* | mock | **Mock-only demo lever**: when set, every checkout link lives this many seconds regardless of the request's `expiresInHours` (whose 1..720 validation is unchanged), so you can watch a link expire into the calm state without waiting an hour. |
| `MOCK_PARTNER_NAME` | `Portal Imobiliar SRL (mock)` | mock | The account name — what the co-branding chip shows. |

See `.env.example`. There is no dotenv — export the variables or prefix the command.

## What the mock reproduces

- **Checkout links** (guide §4.1) are fully implemented: `POST /checkout-links` mints a `pcl_…`
  token (Bearer key; address/propertyType validation with the real per-field messages in
  `error.fields`, the 1..720 `expiresInHours` bounds, default 48 h), the **public**
  `GET /checkout-links/{token}/resolve` answers the documented `200` / `410 checkout_link_expired`
  / `404`, links stay **reusable until expiry** (resolving never consumes one), and `/c/{token}`
  serves a clearly labelled stand-in of the checkout landing — prefilled form sketch, "Comandă
  prin partener" chip, and the calm *"Linkul de comandă nu mai este valid"* state once the link
  lapses.
- **The referral ledger** (guide §4.2): `GET /referrals` serves a canned ledger — one row per
  state (`pending`, `earned` unpaid, `earned` paid out, `void`) — and the `referral` block on
  `GET /me` (guide §4.3) is computed from the same rows, so the two surfaces always agree and you
  can build your payout reconciliation before a single real referral exists. Rows attributed
  through a checkout link carry `externalReference` + `checkoutLinkId` (the per-lead tracking);
  link-only `/p` rows carry `null` for both.
- `401 unauthorized` for anything that is not a `rvp_test_…` key, `X-RV-Request-Id` on every
  response, and the shared `{ items, count, limit, offset }` list envelope.
- `POST /reports` — the retired partner-generated-report endpoint — answers
  `403 billed_generation_retired` with the real service's refusal message word for word (guide
  §13; `test/retiredGeneration.test.js` pins the string), so code copied from an old integration
  fails here exactly as it would in production.

Deliberate differences from the real service: `GET /openapi.yaml` returns a short stub that points
at the authoritative document, the referral rows are canned (a link you mint here never "converts"
— the real ledger fills in when a buyer pays), and `/c/{token}` is a **clearly labelled
placeholder** that performs the same public resolve call the real page performs.

### Watching a checkout link expire

```bash
MOCK_CHECKOUT_LINK_TTL_SECONDS=10 node mock-rv-api.js
```

Mint a link, open it, then reload ten seconds later: the landing flips to the same calm
*"Linkul de comandă nu mai este valid. Cere partenerului un link nou."* state your buyer would see,
and the next click on the storefront mints a fresh link for the lead (the backend never serves a
dead one).

## Pointing it at gamma

Once ResidenceVertical has issued your key:

```bash
RV_API_BASE_URL=https://gamma.residencevertical.ro \
RV_API_KEY=rvp_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
node server.js
```

The banner says `Mode: REMOTE`. Nothing else changes — the same `server.js`, the same client.

Notes for the real environment:

- Start with `GET /me`: it is the cheapest way to prove a key works.
  `curl -H "Authorization: Bearer $RV_API_KEY" https://gamma.residencevertical.ro/api/partner/v1/me`
- On gamma the checkout pages (`/c/<token>`, `/p/<slug>`) sit behind our team access wall; the
  API does not. An end-to-end purchase test is something we run together at onboarding
  (guide §4.4). Everything the sample does against `/api/partner` works with your test key at
  any time.
- Every referral that reaches `earned` on a real environment is a commission we pay you weekly
  by SEPA (guide §2.2); you invoice us for the paid amount. The ledger is the reconciliation
  surface.

## Tests

```bash
node --test          # 38 tests, < 1 s, no dependencies (npm test runs the same thing)
```

- `test/checkoutLinks.test.js` — checkout links (guide §4.1): the Bearer-keyed mint and its 201
  shape (`pcl_` + 32 alphanumerics, `/c/<token>` URL, 48 h default expiry), the address +
  `expiresInHours` 1..720 validation, the public resolve round-tripping the minted address with
  no API key, a link staying reusable across resolves, `410 checkout_link_expired` vs
  `404 not_found`, the `/c` landing's calm expired state, and the storefront button path.
- `test/referrals.test.js` — the ledger surfaces: Bearer-auth, the documented row shape with
  `pending` / `earned` / `void` states and `paidAt` as the paid marker, commission following the
  account's percentage on every row, the per-lead fields (`externalReference` +
  `checkoutLinkId`, together or both `null`), no buyer PII anywhere, and the `/me` referral block
  (`/p/<slug>` link + totals) agreeing with the ledger sums exactly.
- `test/rvClient.test.js` — the client: the mint's 201 shape, validation errors surfacing
  `error.fields`, ledger paging and `me()`, a 401 never retried; and the retry policy against a
  scripted `fetch` — network errors and `503 partner_api_disabled` retried within budget, a
  `Retry-After` beyond the budget surfaced instead of slept on, edge 429s and body-less 5xx
  retried, then given up after `maxAttempts`.
- `test/server.test.js` — the backend: one lead = one link, reused while valid and re-minted once
  expired; the lead view correlating with the ledger on `externalReference`; the storefront
  panels reading only a safe subset; upstream errors surfaced as codes; the configuration errors.
- `test/retiredGeneration.test.js` — `POST /reports` answering `403 billed_generation_retired`
  (after authentication) with the real service's message verbatim, nothing else under `/reports`
  or `/settlements` being served, and the OpenAPI stub listing only the referral endpoints.
- `test/webhookSignature.test.js` — the signature helper: valid delivery, wrong secret, tampered
  body, stale/future timestamp, missing headers, malformed `v1=` prefix, non-hex digest.

Everything listens on ephemeral ports, so the suite never collides with a running demo.

## Production checklist

- [ ] **One lead, one `externalReference`, one link.** Use your own lead id; reuse the stored
      link while it is valid (see `lib/store.js`), mint a fresh one when it has expired. Never
      build a `/c/<token>` URL yourself.
- [ ] **Send a checkout link only to the buyer it was minted for.** The public resolve returns
      the address and, if you sent it, the buyer's email to whoever opens the link (guide §10.1).
- [ ] **Never expose the key.** Server-side only — not in browser JS, mobile apps, or a public
      repo. The link that belongs in front of a browser is `checkoutUrl`.
- [ ] **Poll `GET /referrals` from a job**, not from a web request: match `externalReference`
      against your leads, let a later status overwrite an earlier one (`pending` → `earned`, or
      `void`), and treat `paidAt` as the paid marker. Minutes or hours between polls are fine —
      payment follows the weekly cycle regardless.
- [ ] **Reconcile the Monday payout** against the rows whose `paidAt` falls in that week, and
      issue your commission invoice for the amount the statement email names.
- [ ] **Handle 429 and 503 by `Retry-After`.** Reschedule; never block a web request on them.
- [ ] **Log `X-RV-Request-Id`** next to your own request id on every call, success or failure.

## Support

`support@residencevertical.ro` — include the environment (test/live), your partner slug, the
`externalReference` or `referralId`, the `X-RV-Request-Id` of the failing call, the UTC timestamp
and the HTTP status + `error.code`.
