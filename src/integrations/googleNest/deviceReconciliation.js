function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

function resourceName(device) {
  return String(device?.protocolIdentity?.resourceName || device?.metadata?.resource_name || "").trim();
}

function accountFingerprint(device) {
  return normalized(device?.protocolIdentity?.accountFingerprint || device?.metadata?.account_fingerprint);
}

function matchingScore(incoming, existing) {
  if (!incoming || !existing || normalized(incoming.protocol) !== "google_nest" || normalized(existing.protocol) !== "google_nest") return 0;
  if (resourceName(incoming) && resourceName(incoming) === resourceName(existing)) return 100;

  const incomingAccount = accountFingerprint(incoming);
  const existingAccount = accountFingerprint(existing);
  if (incomingAccount && existingAccount && incomingAccount !== existingAccount) return 0;

  const incomingModel = normalized(incoming.metadata?.model || incoming.definition?.model);
  const existingModel = normalized(existing.metadata?.model || existing.definition?.model);
  const incomingRoom = normalized(incoming.metadata?.room_hint);
  const existingRoom = normalized(existing.metadata?.room_hint);
  let score = 0;
  if (incomingModel && existingModel && incomingModel === existingModel) score += 3;
  if (incomingRoom && existingRoom && incomingRoom === existingRoom) score += 4;
  return score;
}

function selectLegacyGoogleNestDevice({ incoming, existingDevices = [], incomingDevices = [], usedIds = new Set() } = {}) {
  const candidates = existingDevices
    .filter((device) => device && normalized(device.protocol) === "google_nest")
    .filter((device) => !usedIds.has(String(device.id)))
    .map((device) => ({ device, score: matchingScore(incoming, device) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (candidates.length && (candidates.length === 1 || candidates[0].score > candidates[1].score)) return candidates[0].device;

  // A hub supports one Google Nest account. If it has exactly one existing
  // thermostat and Google returns exactly one now, a changed SDM resource ID
  // can be safely reconciled even when the room hint is unavailable.
  const currentDevices = incomingDevices.filter((device) => device && normalized(device.protocol) === "google_nest");
  const currentExisting = existingDevices.filter((device) => device && normalized(device.protocol) === "google_nest" && !usedIds.has(String(device.id)));
  if (currentDevices.length === 1 && currentExisting.length === 1) {
    const candidate = currentExisting[0];
    const incomingAccount = accountFingerprint(incoming);
    const existingAccount = accountFingerprint(candidate);
    if (!incomingAccount || !existingAccount || incomingAccount === existingAccount) return candidate;
  }
  return null;
}

module.exports = { matchingScore, selectLegacyGoogleNestDevice };
