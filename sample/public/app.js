/* Demo storefront script. The browser talks ONLY to this site's own backend — it never sees the
   ResidenceVertical API key and never calls the Partner API directly. */

const SCENARIOS = {
  normal: { street: "Strada Turda", streetNumber: "94", city: "București", county: "București", postalCode: "011332" },
  slow: { street: "Strada Slow", streetNumber: "1", city: "București" },
  fail: { street: "Strada Fail", streetNumber: "1", city: "București" },
  boom: { street: "Strada Boom", streetNumber: "1", city: "București" },
  cap: { street: "Strada Cap", streetNumber: "1", city: "București" },
  maintenance: { street: "Strada Maintenance", streetNumber: "1", city: "București" },
  geo: { street: "Strada Geo", streetNumber: "1", city: "București" },
};

const STATUS_TEXT = {
  pending: "Trimitem cererea către ResidenceVertical…",
  processing: "Raport în curs de generare — durează de obicei ~4 minute.",
  generated: "Raportul este gata.",
  failed: "Generarea raportului a eșuat.",
  create_failed: "Cererea nu a putut fi înregistrată.",
};

const FAILURE_TEXT = {
  report_failed: "Generarea a eșuat definitiv și nu se reia. Nu ți se facturează nimic.",
  report_cancelled: "Cererea a fost anulată de un operator.",
  report_service_error: "Serviciul de generare nu a putut fi contactat.",
};

const ERROR_TEXT = {
  daily_cap_exceeded: "Limita zilnică de rapoarte a contului a fost atinsă. Reîncearcă mâine.",
  maintenance: "Platforma este în mentenanță. Reîncearcă în câteva minute.",
  partner_api_disabled: "API-ul pentru parteneri este momentan indisponibil.",
  geocoding_failed: "Adresa nu a putut fi localizată. Verifică adresa sau trimite coordonatele.",
  report_service_unavailable: "Serviciul de generare nu a acceptat cererea. Reîncearcă în câteva minute.",
  validation_error: "Datele proprietății sunt incomplete sau invalide.",
  unauthorized: "Cheia API nu este validă pentru acest mediu.",
};

const $ = (id) => document.getElementById(id);
let pollTimer = null;
let currentOrderId = null;

async function loadConfig() {
  try {
    const config = await (await fetch("/api/config")).json();
    $("mode").textContent = config.mode === "mock"
      ? "mod MOCK · mock-rv-api.js"
      : `mod REAL · ${new URL(config.apiBaseUrl).host}`;
  } catch {
    $("mode").textContent = "backend indisponibil";
  }
}

function renderStatus(order) {
  const box = $("status");
  box.classList.remove("hidden", "ok", "err", "warn");

  if (order.status === "generated") box.classList.add("ok");
  else if (order.status === "failed" || order.status === "create_failed") box.classList.add("err");

  $("status-text").textContent = order.error
    ? (ERROR_TEXT[order.error.code] ?? STATUS_TEXT.create_failed)
    : (STATUS_TEXT[order.status] ?? order.status);

  const meta = [];
  if (order.reportRequestId) meta.push(`reportRequestId: ${order.reportRequestId}`);
  if (order.failureReason) meta.push(FAILURE_TEXT[order.failureReason] ?? order.failureReason);
  if (order.error) meta.push(`${order.error.code}${order.error.requestId ? ` · X-RV-Request-Id: ${order.error.requestId}` : ""}`);
  if (order.notifiedBy) meta.push(order.notifiedBy === "webhook" ? "aflat prin webhook semnat" : "aflat prin polling");
  $("status-meta").textContent = meta.join(" · ");

  // The deliverable is the interactive web page (viewUrl, opened directly — it needs no key);
  // the PDF is the secondary export (proxied through this site, because that endpoint does).
  const ready = order.status === "generated";
  $("actions").classList.toggle("hidden", !ready);
  $("view-note").classList.toggle("hidden", !ready);
  if (order.downloadPath) $("download").href = order.downloadPath;
  const view = $("view");
  view.href = order.viewUrl || "#";
  // No viewUrl on a generated report means view links are switched off on that environment —
  // the PDF is still there, so degrade instead of breaking.
  view.classList.toggle("hidden", !order.viewUrl);
  $("pdf-note").textContent = order.viewUrl ? "PDF-ul este disponibil și pe pagina raportului." : "";
  $("view-expiry").textContent = order.viewExpiresAt
    ? `Linkul către raport expiră la ${new Date(order.viewExpiresAt).toLocaleString("ro-RO")}.`
    : "";

  const done = ["generated", "failed", "create_failed"].includes(order.status);
  $("generate").disabled = !done;
  $("generate").textContent = done ? "Generează un raport nou" : "Se generează…";
  return done;
}

function poll(orderId) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      const order = await (await fetch(`/api/orders/${orderId}`)).json();
      if (!renderStatus(order)) poll(orderId);
    } catch {
      poll(orderId);
    }
  }, 2000); // the browser polls THIS site; this site polls ResidenceVertical at most every 3 s
}

async function generate() {
  const scenario = $("scenario").value;
  const property = { ...SCENARIOS[scenario], propertyType: "apartment", priceEur: 148500, surfaceSqm: 72 };
  $("title").textContent = `${property.street} ${property.streetNumber}, ${property.city}`;
  $("generate").disabled = true;
  $("generate").textContent = "Se generează…";
  $("actions").classList.add("hidden");
  $("view-note").classList.add("hidden");
  renderStatus({ status: "pending" });

  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(property),
    });
    const order = await response.json();
    currentOrderId = order.orderId;
    if (!renderStatus(order)) poll(order.orderId);
  } catch {
    renderStatus({ status: "create_failed", error: { code: "network" } });
  }
}

/* The real operational pattern: don't cache a view URL forever — when it lapses, ask for a new
   one. Older links keep working until their own expiry, so re-minting is always safe. */
async function reissueViewLink() {
  if (!currentOrderId) return;
  const button = $("reissue");
  button.disabled = true;
  button.textContent = "Se emite…";
  try {
    const response = await fetch(`/api/orders/${currentOrderId}/view-link`, { method: "POST" });
    if (response.ok) renderStatus(await response.json());
  } catch { /* the demo backend is restarting — the button stays available */ }
  button.disabled = false;
  button.textContent = "Link expirat? Re-emite";
}

/* REFERRAL mode's recommended tier: ONE call to this site's backend mints a server-attributed
   checkout link for the selected address; the returned URL is safe to hand to the browser (it
   carries no API key) and stays reusable until it expires. */
async function mintCheckoutLink() {
  const scenario = SCENARIOS[$("scenario").value];
  const button = $("checkout-link");
  button.disabled = true;
  button.textContent = "Se generează…";
  $("checkout-result").classList.add("hidden");
  try {
    const response = await fetch("/api/checkout-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...scenario, propertyType: "apartment" }),
    });
    const body = await response.json();
    if (!response.ok) {
      $("checkout-meta").textContent = ERROR_TEXT[body?.error?.code] ?? "Linkul de comandă nu a putut fi generat.";
      $("checkout-open").classList.add("hidden");
      $("checkout-result").classList.remove("hidden");
      return;
    }
    const open = $("checkout-open");
    open.href = body.url;
    open.classList.remove("hidden");
    $("checkout-meta").textContent =
      `Refolosibil până la ${new Date(body.expiresAt).toLocaleString("ro-RO")} · referință: ${body.externalReference}`;
    $("checkout-result").classList.remove("hidden");
  } catch {
    $("checkout-meta").textContent = "Backend-ul demo nu a răspuns.";
    $("checkout-open").classList.add("hidden");
    $("checkout-result").classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "Generează link checkout";
  }
}

function renderWireLog(entries) {
  const list = $("wire-log");
  if (!entries.length) return;
  list.innerHTML = entries.map((entry) => {
    const status = entry.status === undefined ? "" : String(entry.status);
    const bad = entry.status >= 400 || entry.status === 0;
    return `<li>
      <span class="time">${entry.at.slice(11, 19)}</span>
      <span class="dir ${entry.direction}">${entry.direction === "out" ? "→" : entry.direction === "in" ? "←" : "·"}</span>
      <span class="label">${escapeHtml(entry.label)}</span>
      ${status ? `<span class="code ${bad ? "bad" : "good"}">${status}${entry.code ? ` ${escapeHtml(entry.code)}` : ""}</span>` : ""}
      <span class="note">${escapeHtml(entry.note ?? "")}</span>
    </li>`;
  }).join("");
}

const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]
));

async function refreshWireLog() {
  try {
    const { entries } = await (await fetch("/api/wire-log")).json();
    renderWireLog(entries);
  } catch { /* the demo backend is restarting — ignore */ }
  setTimeout(refreshWireLog, 1500);
}

$("generate").addEventListener("click", generate);
$("reissue").addEventListener("click", reissueViewLink);
$("checkout-link").addEventListener("click", mintCheckoutLink);
loadConfig();
refreshWireLog();
