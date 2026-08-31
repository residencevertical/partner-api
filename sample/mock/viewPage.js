/**
 * MOCK ONLY (throw this file away) — a STAND-IN for the ResidenceVertical report web page.
 *
 * On a real environment `viewUrl` opens `https://<env>.residencevertical.ro/raport/<id>?t=…`: the
 * full interactive report, THE deliverable you put in front of your user — the PDF is offered on
 * that page as a secondary export. The mock has no SPA, so this placeholder does the one thing
 * that makes the demo honest — it performs exactly the two calls the real page performs, from the
 * browser, with the token as the only credential:
 *
 *     GET /api/partner/v1/reports/{id}/view-data?t=…   → the report JSON (rendered below)
 *     GET /api/partner/v1/reports/{id}/pdf?t=…         → the "Descarcă PDF" button
 *
 * No API key is involved on either. That is the whole point of a view link, and it is why this
 * page can be opened by your end user directly.
 *
 * The states (loading / expired / error / ready) and their Romanian copy mirror the real page, and
 * the ready state renders the report's sections as titled blocks — a rough sketch of the real
 * layout — never as a raw JSON dump, so the demo reads like a report, not like an API response.
 */

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
));

/** Safe to embed in a <script>: JSON, with the one sequence that could close the tag neutralised. */
const toScriptJson = (value) => JSON.stringify(value ?? null).replace(/</g, "\\u003c");

/**
 * Renders the report payload as titled section blocks, generically: a string becomes a paragraph,
 * an object a few key/value rows, an array a count plus its first items. PURE and self-contained
 * (its own escaping, no outer references), because it runs in two places: inlined verbatim into
 * the page's <script> via `.toString()`, and imported directly by the tests.
 */
export function renderReportSections(report) {
  const esc = (value) => String(value).replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
  const titleOf = (key) => {
    const words = String(key).replace(/_/g, " ").trim();
    return esc(words.charAt(0).toUpperCase() + words.slice(1));
  };
  const isPrimitive = (value) => value == null || ["string", "number", "boolean"].includes(typeof value);
  const primitive = (value) => (value == null || value === "" ? "—" : esc(String(value)));
  const countLabel = (n) => (n === 1 ? "1 element" : n + " elemente");

  // One line for a nested value: primitives verbatim, an object as its first primitive fields,
  // an array as a count. Deeper nesting is deliberately not walked — this is a sketch, not the SPA.
  const summarize = (value) => {
    if (isPrimitive(value)) return primitive(value);
    if (Array.isArray(value)) return countLabel(value.length);
    const inner = Object.entries(value)
      .filter((entry) => isPrimitive(entry[1]))
      .slice(0, 3)
      .map((entry) => titleOf(entry[0]) + ": " + primitive(entry[1]))
      .join(" · ");
    return inner || Object.keys(value).length + " câmpuri";
  };

  const sectionBody = (value) => {
    if (isPrimitive(value)) return "<p>" + primitive(value) + "</p>";
    if (Array.isArray(value)) {
      const items = value.slice(0, 3).map((item) => "<li>" + summarize(item) + "</li>").join("");
      const more = value.length > 3 ? "<li class='more'>… încă " + (value.length - 3) + "</li>" : "";
      return "<p class='count'>" + countLabel(value.length) + "</p><ul>" + items + more + "</ul>";
    }
    const entries = Object.entries(value);
    const rows = entries.slice(0, 8)
      .map((entry) => "<div class='row'><dt>" + titleOf(entry[0]) + "</dt><dd>" + summarize(entry[1]) + "</dd></div>")
      .join("");
    const more = entries.length > 8 ? "<p class='more'>… încă " + (entries.length - 8) + " câmpuri</p>" : "";
    return "<dl>" + rows + "</dl>" + more;
  };

  return Object.entries(report || {})
    .filter((entry) => entry[0] !== "premium_pdf_title") // already the page header
    .map((entry) => "<section class='card'><h2>" + titleOf(entry[0]) + "</h2>" + sectionBody(entry[1]) + "</section>")
    .join("");
}

export function renderViewPage({ reportRequestId, token }) {
  return `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raport ResidenceVertical (MOCK) — ${escapeHtml(reportRequestId)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: #10233a; background: #f4f7fa; }
  .mockbar { background: #7a2e12; color: #fff; padding: 10px 20px; font-size: 13px; }
  .mockbar strong { text-transform: uppercase; letter-spacing: .04em; }
  header { background: #fff; border-bottom: 1px solid rgba(16,185,129,.28); padding: 20px; }
  .wrap { max-width: 900px; margin: 0 auto; }
  .brand { font-weight: 800; letter-spacing: -.02em; }
  .brand span { color: #0e9f6e; }
  h1 { font-size: 20px; margin: 12px 0 4px; }
  .meta { color: #55697f; font-size: 13px; margin: 0; }
  .provided { color: #78889b; font-size: 12px; margin-top: 8px; }
  main { padding: 24px 20px 48px; }
  .cta { display: inline-block; background: #0e9f6e; color: #fff; text-decoration: none;
         padding: 10px 18px; border-radius: 8px; font-weight: 600; }
  /* The display rule on .cta would otherwise beat the browser default for the hidden attribute,
     and the PDF button would sit there on a page that has no report to download. */
  [hidden] { display: none !important; }
  .panel { background: #fff; border-radius: 12px; padding: 24px; margin-top: 20px; }
  .panel.warn { background: #fffbeb; border: 1px solid #fcd34d; }
  .panel.err { background: #fff1f2; border: 1px solid #fda4af; }
  .panel h2 { margin: 0 0 8px; font-size: 17px; }
  .hint { color: #55697f; font-size: 13px; }
  .card { background: #fff; border-radius: 12px; padding: 20px 24px; margin-top: 16px;
          border: 1px solid #e4ebf2; }
  .card h2 { margin: 0 0 12px; font-size: 16px; color: #0b5c42; border-bottom: 1px solid #e4ebf2;
             padding-bottom: 8px; }
  .card p { margin: 0 0 6px; }
  .card dl { margin: 0; }
  .card .row { display: grid; grid-template-columns: 220px 1fr; gap: 12px; padding: 5px 0;
               border-bottom: 1px dotted #edf2f7; }
  .card .row:last-child { border-bottom: 0; }
  .card dt { color: #55697f; font-size: 13px; }
  .card dd { margin: 0; }
  .card ul { margin: 6px 0 0; padding-left: 20px; }
  .card .count { color: #55697f; font-size: 13px; margin: 0 0 4px; }
  .card .more { color: #78889b; font-size: 12.5px; }
</style>
</head>
<body>
<div class="mockbar">
  <strong>Pagină demonstrativă</strong> — pe mediul real se deschide pagina ResidenceVertical
  (<code>https://gamma.residencevertical.ro/raport/&lt;id&gt;?t=…</code>): raportul interactiv
  complet, cu toate secțiunile. Aici randăm doar o schiță a acestora.
</div>

<header><div class="wrap">
  <div class="brand">Residence<span>Vertical</span></div>
  <h1 id="address">Se încarcă raportul</h1>
  <p class="meta" id="meta"></p>
  <p class="provided" id="provided"></p>
  <p style="margin-top:16px"><a class="cta" id="pdf" href="#" download hidden>Descarcă PDF</a></p>
</div></header>

<main class="wrap" id="main">
  <div class="panel" id="state">
    <h2>Se încarcă raportul</h2>
    <p class="hint">Raportul are zeci de secțiuni, așa că prima încărcare poate dura până la un minut.</p>
  </div>
</main>

<script>
const reportRequestId = ${toScriptJson(reportRequestId)};
const token = ${toScriptJson(token)};
const state = document.getElementById("state");
// The exact same renderer the tests exercise — inlined so browser and test share one implementation.
const renderReportSections = ${renderReportSections.toString()};

function show(kind, title, hint) {
  state.className = "panel" + (kind ? " " + kind : "");
  state.innerHTML = "<h2></h2><p class='hint'></p>";
  state.querySelector("h2").textContent = title;
  state.querySelector(".hint").textContent = hint;
}

async function load() {
  if (!token) {
    // Same thing as a refused token, for the reader: the link no longer opens the report.
    show("warn", "Linkul nu mai este valid",
      "Linkul nu mai este valid. Solicită un link nou de la partenerul care ți l-a trimis.");
    document.getElementById("address").textContent = "Link invalid";
    return;
  }
  const base = "/api/partner/v1/reports/" + encodeURIComponent(reportRequestId);
  let response;
  try {
    response = await fetch(base + "/view-data?t=" + encodeURIComponent(token));
  } catch (error) {
    show("err", "Nu am putut încărca raportul", "A apărut o problemă temporară. Reîncearcă în câteva momente.");
    return;
  }
  if (response.status === 401) {
    show("warn", "Linkul nu mai este valid",
      "Linkul nu mai este valid. Solicită un link nou de la partenerul care ți l-a trimis.");
    document.getElementById("address").textContent = "Link expirat sau invalid";
    document.getElementById("meta").textContent =
      "invalid_or_expired_view_token — pe partea ta: POST /reports/" + reportRequestId + "/view-link emite un link nou.";
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    show("err", "Nu am putut încărca raportul", (body && body.error && body.error.code) || ("HTTP " + response.status));
    return;
  }

  const payload = await response.json();
  const address = payload.address || {};
  document.getElementById("address").textContent =
    [address.street, address.streetNumber].filter(Boolean).join(" ") + (address.city ? ", " + address.city : "");
  document.getElementById("meta").textContent =
    [payload.generatedAt ? "Generat la " + payload.generatedAt : null, payload.propertyType]
      .filter(Boolean).join(" · ");
  if (payload.partnerName) {
    document.getElementById("provided").textContent = "Raport furnizat prin " + payload.partnerName;
  }
  const pdf = document.getElementById("pdf");
  pdf.href = base + "/pdf?t=" + encodeURIComponent(token);
  pdf.hidden = false;

  // The report itself: every top-level section as a titled block, like the real page's layout.
  document.getElementById("main").innerHTML = renderReportSections(payload.report);
}

load();
</script>
</body>
</html>
`;
}
