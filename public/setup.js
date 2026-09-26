const status = document.getElementById("status");
const button = document.getElementById("generate");
const qr = document.getElementById("qr");
const supportTicket = document.getElementById("support-ticket");
const supportCode = document.getElementById("support-code");
const supportRedeem = document.getElementById("support-redeem");
const supportRevoke = document.getElementById("support-revoke");
const supportStatus = document.getElementById("support-status");
const supportOnly = window.location.pathname === "/support-access";
let supportExpiryTimer = null;
function clearSupportSecrets() {
  supportCode.value = "";
}
function scheduleSupportSecretClear(expiresAt) {
  if (supportExpiryTimer) clearTimeout(supportExpiryTimer);
  const delay = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  supportExpiryTimer = setTimeout(() => {
    clearSupportSecrets();
    supportStatus.textContent = "The support code has expired. Request a new approved session.";
    supportRevoke.hidden = true;
  }, delay);
}
function cookie(name) {
  const prefix = `${name}=`;
  const entry = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
}
function show(value, isError = false) {
  status.textContent = value;
  status.setAttribute("aria-invalid", String(isError));
  status.focus({ preventScroll: true });
}
async function refresh() {
  if (supportOnly) return;
  const response = await fetch("/_dinodia/setup/status", { cache: "no-store" });
  const data = await response.json();
  show(data.identity?.serial ? `Hub serial: ${data.identity.serial}\nState: ${data.pairing?.state || "not issued"}` : "Hub identity unavailable.");
}
async function registerOperatorBrowserAttempt() {
  if (!supportOnly || !window.opener) return;
  try {
    const response = await fetch("/_dinodia/setup/operator-attempt", { method: "POST", headers: { "content-type": "application/json", "x-dinodia-setup-csrf": cookie("dinodia_setup_csrf") }, body: "{}", cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.setupAttemptId !== "string") throw new Error(data.error || "The hub could not register this browser.");
    let targetOrigin = "*";
    try { if (document.referrer) targetOrigin = new URL(document.referrer).origin; } catch {}
    window.opener.postMessage({ type: "dinodia-operator-attempt", setupAttemptId: data.setupAttemptId }, targetOrigin);
    show("This locked browser is ready for the Company Portal handoff.");
  } catch (error) {
    show(error instanceof Error ? error.message : "The hub could not register this browser.", true);
  }
}
button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    const response = await fetch("/_dinodia/setup/pairing", { method: "POST", headers: { "content-type": "application/json", "x-dinodia-setup-csrf": cookie("dinodia_setup_csrf") }, body: JSON.stringify({}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not generate a pairing code.");
    qr.innerHTML = data.qrSvg || "";
    qr.style.display = data.qrSvg ? "block" : "none";
    show(`Pairing code:\n${data.code}\n\nExpires: ${new Date(data.expiresAt).toLocaleString()}`);
  } catch (error) { show(error.message, true); }
  button.disabled = false;
});
refresh().catch((error) => show(error.message, true));
if (supportOnly) {
  button.hidden = true;
  document.getElementById("qr").hidden = true;
  document.getElementById("support-access").open = true;
  show("Enter the values from an approved Company Portal support ticket.");
  registerOperatorBrowserAttempt().catch(() => {});
}

supportRedeem.addEventListener("click", async () => {
  supportRedeem.disabled = true;
  try {
    const response = await fetch("/_dinodia/setup/support-access", { method: "POST", headers: { "content-type": "application/json", "x-dinodia-setup-csrf": cookie("dinodia_setup_csrf") }, body: JSON.stringify({ action: "redeem", ticketId: supportTicket.value.trim(), code: supportCode.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Support access was not accepted.");
    clearSupportSecrets();
    supportStatus.textContent = `Support session active until ${new Date(data.expiresAt).toLocaleString()}.`;
    supportRevoke.hidden = false;
    scheduleSupportSecretClear(data.expiresAt);
  } catch (error) { supportStatus.textContent = error.message; }
  supportRedeem.disabled = false;
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") clearSupportSecrets();
});
window.addEventListener("pagehide", clearSupportSecrets);

supportRevoke.addEventListener("click", async () => {
  supportRevoke.disabled = true;
  try {
    const response = await fetch("/_dinodia/setup/support-access", { method: "POST", headers: { "content-type": "application/json", "x-dinodia-setup-csrf": cookie("dinodia_setup_csrf") }, body: JSON.stringify({ action: "revoke" }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Support access could not be revoked.");
    supportStatus.textContent = data.message || "Support access revoked.";
    supportRevoke.hidden = true;
  } catch (error) { supportStatus.textContent = error.message; }
  supportRevoke.disabled = false;
});

// Company Portal delivers only the ticket reference through the opened setup
// window. The encrypted employee proof is fetched by the hub itself over its
// authenticated machine channel and is never rendered, copied or persisted by
// the browser.
window.addEventListener("message", (event) => {
  if (event.origin !== "https://dinodia-platform-v2.vercel.app" || event.source !== window.opener) return;
  const message = event.data;
  if (message && message.type === "dinodia-operator-handoff" && typeof message.handoffId === "string") {
    // The hub creates the browser binding and setup-attempt cookies. The
    // portal may deliver only an opaque handoff reference to this window.
    fetch("/_dinodia/setup/operator-session", { method: "POST", headers: { "content-type": "application/json", "x-dinodia-setup-csrf": cookie("dinodia_setup_csrf") }, body: JSON.stringify({ handoffId: message.handoffId }) })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "The operator handoff was rejected.");
        // Verify the newly set HttpOnly cookie by calling an authenticated,
        // read-only OS endpoint before telling Company Portal the session works.
        const sessionCheck = await fetch("/_dinodia/admin/api/status", { cache: "no-store", credentials: "same-origin" });
        if (!sessionCheck.ok) throw new Error("The hub did not confirm the new operator session.");
        if (window.opener) window.opener.postMessage({ type: "dinodia-operator-session-established" }, "https://dinodia-platform-v2.vercel.app");
        window.location.assign("/");
      })
      .catch((error) => show(error.message, true));
    return;
  }
  if (!message || message.type !== "dinodia-support-proof" || typeof message.ticketId !== "string") return;
  supportTicket.value = message.ticketId;
  supportStatus.textContent = "Company Portal support request received. Enter only the customer-approved one-use code.";
});
