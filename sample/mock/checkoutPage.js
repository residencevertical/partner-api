/**
 * MOCK ONLY (throw this file away) — a STAND-IN for the ResidenceVertical CHECKOUT LANDING a
 * checkout link opens (`/c/<token>`, guide §4.1).
 *
 * On a real environment the buyer's browser opens `https://<env>.residencevertical.ro/c/<token>`
 * and the page resolves the token, stores the partner attribution and continues into the normal
 * order form with the address prefilled and the discreet co-branding chip
 * "Comandă prin partener: <name>". The mock has no SPA, so this placeholder does the one thing
 * that keeps the demo honest — it performs exactly the ONE public call the real page performs,
 * from the browser, with the token as the only credential:
 *
 *     GET /api/partner/v1/checkout-links/{token}/resolve   → the prefill payload (rendered below)
 *
 * No API key is involved. The states mirror the real page:
 *   - 200 → the order-form sketch, prefilled, with the co-branding chip;
 *   - 410 / 404 / network → the calm state ("Linkul de comandă nu mai este valid. Cere
 *     partenerului un link nou.") with a "Mergi la formular" way out — never a dead end.
 */

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
));

/** Safe to embed in a <script>: JSON, with the one sequence that could close the tag neutralised. */
const toScriptJson = (value) => JSON.stringify(value ?? null).replace(/</g, "\\u003c");

export function renderCheckoutLandingPage({ token }) {
  return `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Comandă raport ResidenceVertical (MOCK)</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: #10233a; background: #f4f7fa; }
  .mockbar { background: #7a2e12; color: #fff; padding: 10px 20px; font-size: 13px; }
  .mockbar strong { text-transform: uppercase; letter-spacing: .04em; }
  header { background: #fff; border-bottom: 1px solid rgba(16,185,129,.28); padding: 20px; }
  .wrap { max-width: 640px; margin: 0 auto; }
  .brand { font-weight: 800; letter-spacing: -.02em; }
  .brand span { color: #0e9f6e; }
  main { padding: 24px 20px 48px; }
  .chip { display: inline-block; background: #eef7f2; color: #0b5c42; border: 1px solid rgba(14,159,110,.35);
          border-radius: 999px; padding: 4px 12px; font-size: 12.5px; margin-bottom: 14px; }
  .panel { background: #fff; border-radius: 12px; padding: 24px; margin-top: 16px; }
  .panel.warn { background: #fffbeb; border: 1px solid #fcd34d; }
  .panel h2 { margin: 0 0 8px; font-size: 17px; }
  .hint { color: #55697f; font-size: 13px; }
  .field { margin: 12px 0; }
  .field label { display: block; font-size: 12.5px; color: #55697f; margin-bottom: 4px; }
  .field input { width: 100%; box-sizing: border-box; font: inherit; padding: 9px 12px;
                 border: 1px solid #d5deea; border-radius: 8px; background: #f8fafc; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
  .cta { display: inline-block; background: #0e9f6e; color: #fff; border: 0; font: inherit; font-weight: 600;
         padding: 10px 18px; border-radius: 8px; cursor: not-allowed; opacity: .8; }
  .cta.link { cursor: pointer; opacity: 1; text-decoration: none; }
  .price { font-weight: 700; }
  .expiry { color: #78889b; font-size: 12.5px; margin-top: 14px; }
</style>
</head>
<body>
<div class="mockbar">
  <strong>Pagină demonstrativă</strong> — pe mediul real, un link de comandă deschide
  checkout-ul ResidenceVertical (<code>https://gamma.residencevertical.ro/c/&lt;token&gt;</code>):
  formularul de comandă cu adresa precompletată, plata cu cardul și livrarea raportului. Aici
  randăm doar o schiță a acestuia, după același apel public de rezolvare a tokenului.
</div>

<header><div class="wrap">
  <div class="brand">Residence<span>Vertical</span></div>
</div></header>

<main class="wrap" id="main">
  <div class="panel" id="state">
    <h2>Se deschide comanda</h2>
    <p class="hint">Verificăm linkul de comandă…</p>
  </div>
</main>

<script>
const token = ${toScriptJson(token)};
const main = document.getElementById("main");
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
));

/* The calm state the real page shows for an expired, unknown or unreachable link — the buyer is
   pointed forward (the plain order form), never at a dead end. Attribution is simply lost. */
function showInvalidLink() {
  main.innerHTML = '<div class="panel warn">'
    + '<h2>Linkul de comandă nu mai este valid. Cere partenerului un link nou.</h2>'
    + '<p class="hint">Poți comanda raportul în continuare, completând adresa manual.</p>'
    + '<p style="margin-top:14px"><a class="cta link" href="/">Mergi la formular</a></p>'
    + '<p class="hint">(Pe mediul real, butonul deschide formularul de comandă ResidenceVertical.)</p>'
    + '</div>';
}

function field(label, value) {
  return '<div class="field"><label>' + esc(label) + '</label>'
    + '<input value="' + esc(value ?? "") + '" readonly></div>';
}

/* The prefilled order-form sketch: what the buyer sees after the resolve succeeds — the
   co-branding chip, the address already filled in, and our normal 50 lei checkout. */
function showPrefilledCheckout(payload) {
  const address = payload.address || {};
  main.innerHTML = '<span class="chip">Comandă prin partener: ' + esc(payload.partnerName) + '</span>'
    + '<div class="panel">'
    + '<h2>Raport premium pentru proprietatea ta</h2>'
    + field("Stradă", address.street)
    + '<div class="grid">'
    + field("Număr", address.streetNumber)
    + field("Localitate", address.city)
    + '</div>'
    + (address.postalCode ? field("Cod poștal", address.postalCode) : "")
    + field("Tip proprietate", payload.propertyType === "house" ? "casă" : "apartament")
    + (payload.customerEmail ? field("Email (precompletat de partener)", payload.customerEmail) : "")
    + '<p class="price">Preț raport: 50 lei</p>'
    + '<button class="cta" disabled>Continuă către plată (demo)</button>'
    + '<p class="expiry">Linkul de comandă este refolosibil până la '
    + esc(new Date(payload.expiresAt).toLocaleString("ro-RO")) + '.</p>'
    + '</div>';
}

async function load() {
  if (!token) return showInvalidLink();
  let response;
  try {
    response = await fetch("/api/partner/v1/checkout-links/" + encodeURIComponent(token) + "/resolve");
  } catch {
    return showInvalidLink();
  }
  if (!response.ok) return showInvalidLink(); // 410 expired, 404 unknown — same calm state
  showPrefilledCheckout(await response.json());
}

load();
</script>
</body>
</html>
`;
}
