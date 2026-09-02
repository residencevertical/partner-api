# Security

## Reporting a vulnerability

Email **security@residencevertical.ro** with enough detail to reproduce the issue. Please do
not open a public issue for anything exploitable.

We will acknowledge within **2 business days** and keep you updated until it is resolved. If
you would like credit once a fix ships, say so and we will include it.

Please do not test against production. If you need an environment to demonstrate something,
tell us and we will arrange one.

## Scope

**In scope** — this repository: the reference integration and the mock in `sample/`, and any
security-relevant guidance in [GUIDE.md](GUIDE.md) (for example, if the key-handling rules in
§6, or the warning in §10.1 that a checkout link exposes its address and buyer email to
whoever opens it, are wrong or weak).

**Out of scope for this repo** — the ResidenceVertical platform and API themselves. Report
those to the same address; they are simply not defects in this repository.

## For integrators

Two things carry the security weight of a partner integration:

**Your API key is server-side only.** `rvp_test_…` and `rvp_live_…` keys must never reach a
browser, a mobile app, or a public repository. They authenticate as your account — whoever
holds one can mint checkout links in your name and read your referral ledger. If one is
exposed, email us and we will revoke and reissue it.

**A checkout link is for one buyer.** The `/c/<token>` URL you mint carries the address and,
if you sent it, the buyer's email — the public resolve endpoint returns them to whoever opens
the link ([GUIDE.md §10.1](GUIDE.md)). Send a link only to the buyer it was minted for, and
never publish one.

There is **no webhook** in the referral program today — you learn of conversions by polling
`GET /referrals` ([GUIDE.md §2.3](GUIDE.md)), so nothing calls your servers. Should a signed
notification be introduced, it will use HMAC-SHA256 over the raw body with a timestamp replay
window, and [`sample/lib/webhookSignature.js`](sample/lib/webhookSignature.js) is the
verification we will point you at: constant-time comparison, raw bytes, 300 s tolerance.

The mock accepts any `rvp_test_…` key; the values in `sample/.env.example` are local test
values with no meaning against a real environment.
