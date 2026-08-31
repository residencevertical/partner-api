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
security-relevant guidance in [GUIDE.md](GUIDE.md) (for example, if the documented webhook
signature verification is wrong or weak).

**Out of scope for this repo** — the ResidenceVertical platform and API themselves. Report
those to the same address; they are simply not defects in this repository.

## For integrators

Two things carry the security weight of a partner integration:

**Your API key is server-side only.** `rvp_test_…` and `rvp_live_…` keys must never reach a
browser, a mobile app, or a public repository. They authenticate as your account. If one is
exposed, email us and we will revoke and reissue it.

**Verify every webhook before you trust it.** Deliveries are signed
(`X-RV-Signature: v1=…`, `X-RV-Timestamp`). Compare with a constant-time comparison, reject
timestamps outside the replay window, and verify against the **raw request body** — parsing
and re-serialising the JSON first will change the bytes and the signature will never match.
[GUIDE.md §10](GUIDE.md) documents the scheme, and
[`sample/lib/webhookSignature.js`](sample/lib/webhookSignature.js) is a working
implementation with tests you can copy.

The mock's secrets (`whsec_local_mock_secret` and similar in `.env.example`) are local test
values with no meaning against a real environment.
