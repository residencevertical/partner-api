/* Demo storefront script. The browser talks ONLY to this site's own backend — it never sees the
   ResidenceVertical API key and never calls the Partner API directly. */

const PROPERTY = {
  street: "Strada Turda", streetNumber: "94", city: "București", county: "București",
  postalCode: "011332", propertyType: "apartment",
};

const STATUS_TEXT = {
  pending: "Cumpărătorul a plătit — raportul se generează. Comisionul devine earned la finalizare.",
  earned: "Raport generat — comisionul este al tău și intră în următoarea plată de luni.",
  void: "Această recomandare nu se va plăti (raport eșuat sau plată rambursată).",
};

const ERROR_TEXT = {
  validation_error: "Datele proprietății sunt incomplete sau invalide.",
  unauthorized: "Cheia API nu este validă pentru acest mediu.",
  partner_suspended: "Contul de partener este suspendat.",
  partner_api_disabled: "API-ul pentru parteneri este momentan indisponibil.",
  network_error: "Backend-ul nu a putut contacta ResidenceVertical.",
  timeout: "ResidenceVertical nu a răspuns la timp.",
};

const $ = (id) => document.getElementById(id);
const lei = (cents) => `${(cents / 100).toFixed(2).replace(".", ",")} lei`;
const when = (iso) => (iso ? new Date(iso).toLocaleString("ro-RO") : "—");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]
));

let currentLeadId = null;
let leadTimer = null;

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

/* The link-only tier: the /p/<slug> URL from GET /me, pre-filled for this listing through the
   documented query parameters (guide §3). Nothing on the server is needed for this one. */
async function loadAccount() {
  try {
    const account = await (await fetch("/api/account")).json();
    if (account.error) throw new Error(account.error.code);
    const url = new URL(account.referral.referralUrl);
    url.searchParams.set("street", PROPERTY.street);
    url.searchParams.set("number", PROPERTY.streetNumber);
    url.searchParams.set("city", PROPERTY.city);
    url.searchParams.set("type", PROPERTY.propertyType);
    const link = $("referral-link");
    link.href = url.toString();
    link.textContent = url.toString();
    $("referral-meta").textContent = ` · atribuit contului „${account.name}”`;
    $("commission").textContent = `${account.commissionPct}% din 50 lei`;
  } catch {
    $("referral-link").textContent = "linkul de recomandare nu a putut fi citit";
  }
}

function renderLead(lead) {
  const box = $("status");
  box.classList.remove("hidden", "ok", "err", "warn");
  if (lead.error) {
    box.classList.add("err");
    $("status-text").textContent = ERROR_TEXT[lead.error.code] ?? "Linkul de comandă nu a putut fi generat.";
    $("status-meta").textContent = `${lead.error.code}${lead.error.requestId ? ` · X-RV-Request-Id: ${lead.error.requestId}` : ""}`;
    return;
  }
  const referral = lead.referral;
  if (!referral) {
    box.classList.add("warn");
    $("status-text").textContent = "Nicio conversie încă pentru acest lead.";
    $("status-meta").textContent = "Verificăm registrul GET /referrals periodic — nu există webhook, se face polling.";
    return;
  }
  box.classList.add(referral.status === "earned" ? "ok" : referral.status === "void" ? "err" : "warn");
  $("status-text").textContent = STATUS_TEXT[referral.status] ?? referral.status;
  $("status-meta").textContent = `referralId ${referral.referralId} · ${lei(referral.commissionCents)}`
    + `${referral.paidAt ? ` · plătit la ${when(referral.paidAt)}` : ""}`;
}

/* Your backend correlates the ledger with your leads; the browser just asks for the lead. */
function pollLead(leadId) {
  clearTimeout(leadTimer);
  leadTimer = setTimeout(async () => {
    try {
      const lead = await (await fetch(`/api/leads/${encodeURIComponent(leadId)}`)).json();
      renderLead(lead);
    } catch { /* the demo backend is restarting — keep trying */ }
    pollLead(leadId);
  }, 5000);
}

/* The API-backed tier: ONE call to this site's backend mints a server-attributed checkout link
   for the listing; the returned URL is safe to hand to the browser (it carries no API key) and
   stays reusable until it expires. */
async function mintCheckoutLink() {
  const button = $("checkout-link");
  button.disabled = true;
  button.textContent = "Se generează…";
  $("checkout-result").classList.add("hidden");
  try {
    const response = await fetch("/api/checkout-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...PROPERTY, ...(currentLeadId ? { leadId: currentLeadId } : {}) }),
    });
    const lead = await response.json();
    if (!response.ok) {
      renderLead({ error: lead.error ?? { code: "network_error" } });
      return;
    }
    currentLeadId = lead.leadId;
    const open = $("checkout-open");
    open.href = lead.checkoutUrl;
    $("checkout-meta").textContent =
      ` · refolosibil până la ${when(lead.checkoutExpiresAt)} · lead: ${lead.leadId}`;
    $("checkout-result").classList.remove("hidden");
    // In production this is where you redirect the buyer; the demo opens the landing in a tab.
    window.open(lead.checkoutUrl, "_blank", "noopener");
    renderLead(lead);
    pollLead(lead.leadId);
  } catch {
    renderLead({ error: { code: "network_error" } });
  } finally {
    button.disabled = false;
    button.textContent = "Vezi raportul ResidenceVertical";
  }
}

/* "Conversiile mele": the ledger, read through this site's backend (which polls GET /referrals). */
function renderReferrals(items) {
  const body = $("referrals");
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Nicio conversie încă.</td></tr>';
    $("referral-totals").textContent = "";
    return;
  }
  body.innerHTML = items.map((row) => `<tr>
    <td>${escapeHtml(when(row.createdAt))}</td>
    <td>${escapeHtml(row.externalReference ?? "— (link de recomandare)")}</td>
    <td><span class="state ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td>
    <td>${escapeHtml(lei(row.commissionCents))}</td>
    <td>${escapeHtml(row.paidAt ? when(row.paidAt) : row.status === "earned" ? "următoarea luni" : "—")}</td>
  </tr>`).join("");
  const sum = (rows) => rows.reduce((total, row) => total + row.commissionCents, 0);
  const earnedUnpaid = items.filter((row) => row.status === "earned" && !row.paidAt);
  const paid = items.filter((row) => row.paidAt);
  $("referral-totals").textContent =
    `De încasat la următoarea plată: ${lei(sum(earnedUnpaid))} · plătit până acum: ${lei(sum(paid))}`
    + " · pentru suma plătită emiți factură de comision către ResidenceVertical.";
}

async function refreshReferrals() {
  try {
    const { items } = await (await fetch("/api/referrals")).json();
    if (items) renderReferrals(items);
  } catch { /* the demo backend is restarting — ignore */ }
  setTimeout(refreshReferrals, 5000);
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

async function refreshWireLog() {
  try {
    const { entries } = await (await fetch("/api/wire-log")).json();
    renderWireLog(entries);
  } catch { /* the demo backend is restarting — ignore */ }
  setTimeout(refreshWireLog, 1500);
}

$("checkout-link").addEventListener("click", mintCheckoutLink);
loadConfig();
loadAccount();
refreshReferrals();
refreshWireLog();
