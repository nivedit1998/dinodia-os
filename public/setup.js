const status = document.getElementById("status");
const button = document.getElementById("generate");
const qr = document.getElementById("qr");
const supportTicket = document.getElementById("support-ticket");
const supportCode = document.getElementById("support-code");
const supportProof = document.getElementById("support-proof");
const supportRedeem = document.getElementById("support-redeem");
const supportRevoke = document.getElementById("support-revoke");
const supportStatus = document.getElementById("support-status");
const supportOnly = window.location.pathname === "/support-access";
let supportExpiryTimer = null;
function clearSupportSecrets() {
  supportCode.value = "";
  supportProof.value = "";
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
}

supportRedeem.addEventListener("click", async () => {
  supportRedeem.disabled = true;
  try {
    const response = await fetch("/_dinodia/setup/support-access", { method: "POST", headers: { "content-type": "application/json", "x-dinodia-setup-csrf": cookie("dinodia_setup_csrf") }, body: JSON.stringify({ action: "redeem", ticketId: supportTicket.value.trim(), code: supportCode.value, employeeProof: supportProof.value }) });
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
