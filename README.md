# ResidenceVertical — Partner API

Everything you need to put **ResidenceVertical property reports** in front of your own users.

ResidenceVertical sells a premium verification report for Romanian residential property —
developer identity and litigation history, seismic-risk registry matches, building permits at
the address, real comparable prices, neighbourhood signals. One report, one price, delivered
as a PDF and as a web page.

This repository is for developers and product owners at a **partner company** — a real-estate
portal, agency or broker network — integrating that report into their own product.

---

## Start here

| | |
|---|---|
| **[GUIDE.md](GUIDE.md)** | The integration guide. Both modes, every endpoint, webhooks, commissions, settlement. Start at §1. |
| **[docs/](docs/)** | The same guide as a PDF, if you would rather read or circulate it that way. |
| **[sample/](sample/)** | A runnable reference integration **and a local mock of our API**. Zero dependencies. |

## Two ways to integrate

**Referral mode** — you send your users to our checkout, we handle payment, delivery and
support, and you earn a commission on every report generated. Works with no backend at all
(a link), or with a backend (server-minted checkout links, exact attribution, per-lead
tracking). This is the recommended starting point.

**API mode** — you call the API server-to-server, receive the report, and present it inside
your own product. You are billed for what you generate.

Both can run at the same time on one partner account. [GUIDE.md §1](GUIDE.md) compares them.

## Try it before you have a key

The sample ships with a **local mock of the Partner API**, so you can build and test the whole
integration — checkout links, webhooks with real HMAC signatures, report polling, PDF
download, view links, the referral ledger — before we issue you anything.

```bash
cd sample
node mock-rv-api.js     # the mock API, port 4010
node server.js          # the reference partner site, port 4000  (second terminal)
```

Then open <http://localhost:4000>. No API key, no network, no `npm install` — Node.js 20+
built-ins only. `node --test` runs the sample's own suite.

See [sample/README.md](sample/README.md) for the full walkthrough.

## Getting a key

Partner accounts are provisioned by us, per environment. Contact
**partners@residencevertical.ro** with your company details and intended integration mode, and
we will issue a test key plus a testing environment to point it at.

Keys are `rvp_test_…` (testing) and `rvp_live_…` (production). They are **server-side only** —
never ship one to a browser, a mobile app, or a public repository.

## Support

- Integration questions, key requests, webhook configuration: **partners@residencevertical.ro**
- Include your partner slug and, where relevant, the `externalReference` or report id — it
  makes tracing an individual request much faster.

## Scope of this repository

This repo contains the partner-facing integration guide and a reference sample. It is **not**
the ResidenceVertical platform source, and the sample is illustrative — production-shaped
(idempotency, signature verification, retries, error handling) but written to be read and
adapted, not deployed as-is.

The API contract is versioned; breaking changes get a new version and advance notice. See the
changelog at the end of [GUIDE.md](GUIDE.md).
