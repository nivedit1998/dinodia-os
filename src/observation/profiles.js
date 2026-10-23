// Observation profiles: how each supported value of each device type is kept fresh, and for how
// long one measured value counts. See Code Planning/DINODIA_HUB_OBSERVATION_POLICY_PLAN_20261023.md.
//
// A profile matches one exact control: integration, manufacturer/model (and firmware where it
// matters), endpoint, Zigbee cluster/attribute, exposed property and semantic role. A device never
// borrows another endpoint's guarantee. The lifetime is fixed for the match, so runtime failure or
// loss of verification can never lengthen it.

// Coverage allowance for radio retries and MQTT delivery after a promised report; not a missed report.
const DELIVERY_GRACE_SECONDS = 60;
// Missed reports tolerated before the value is Unknown (owner decision D9: none).
const MISSED_REPORTS_TOLERATED = 0;
// Bounded device reads: reply timeout counted into the lifetime so successful reads leave no gap.
const READ_REPLY_TIMEOUT_SECONDS = 30;

function periodicLifetime(maxIntervalSeconds) {
  return maxIntervalSeconds * (1 + MISSED_REPORTS_TOLERATED) + DELIVERY_GRACE_SECONDS;
}

function boundedReadLifetime(intervalSeconds) {
  return intervalSeconds * (1 + MISSED_REPORTS_TOLERATED) + READ_REPLY_TIMEOUT_SECONDS + DELIVERY_GRACE_SECONDS;
}

const PROFILES = Object.freeze([
  Object.freeze({
    id: "zigbee.sonoff.trvzb.running_state",
    version: 1,
    integration: "zigbee",
    manufacturer: "SONOFF",
    model: "TRVZB",
    endpoint: "1",
    cluster: "hvacThermostat",
    attribute: "runningState",
    property: "running_state",
    semanticRole: "active_heat_demand",
    power: "battery",
    strategy: "report_on_change_plus_periodic",
    desired: Object.freeze({ minimumReportInterval: 0, maximumReportInterval: 600, reportableChange: 0 }),
    lifetimeSeconds: periodicLifetime(600),
    // Owner-approved 22 Oct 2026 ("configure the radiator to report its heating state at least
    // every 10 minutes"); configuration read back on the live valve. Cadence verified at runtime.
    approvedForAutomaticConfiguration: true,
  }),
  Object.freeze({
    id: "zigbee.generic.mains_light.on_off",
    version: 1,
    integration: "zigbee",
    manufacturer: null,
    model: null,
    endpoint: null, // the control's own endpoint
    cluster: "genOnOff",
    attribute: "onOff",
    property: "state",
    semanticRole: "power",
    power: "mains",
    strategy: "report_on_change_plus_periodic",
    desired: Object.freeze({ minimumReportInterval: 0, maximumReportInterval: 300, reportableChange: 0 }),
    lifetimeSeconds: periodicLifetime(300),
    // Framework only: no light is paired and no model has been verified.
    approvedForAutomaticConfiguration: false,
    requiresModelApproval: true,
  }),
  Object.freeze({
    id: "zigbee.generic.mains_device.bounded_read",
    version: 1,
    integration: "zigbee",
    manufacturer: null,
    model: null,
    endpoint: null,
    cluster: null,
    attribute: null,
    property: null,
    semanticRole: null,
    power: "mains",
    strategy: "bounded_read",
    readIntervalSeconds: 600,
    lifetimeSeconds: boundedReadLifetime(600),
    approvedForAutomaticConfiguration: false,
    requiresModelApproval: true,
  }),
]);

function normalized(value) {
  return value === null || value === undefined ? "" : String(value).trim().toLowerCase();
}

function entityEndpoint(entity) {
  return String(entity?.endpointId ?? entity?.binding?.endpoint ?? entity?.expose?.endpoint ?? "").trim();
}

function entityProperty(entity) {
  return String(entity?.stateKey || entity?.binding?.property || "").trim();
}

/// The single profile that matches this exact control, or null. Generic profiles that require a
/// model approval match only once that model is listed in `approvedModels`.
function matchObservationProfile(device, entity, { approvedModels = [] } = {}) {
  if (!device || !entity) return null;
  const integration = normalized(device.protocol);
  const manufacturer = normalized(device.metadata?.manufacturer || device.metadata?.vendor);
  const model = normalized(device.metadata?.model || device.metadata?.model_id);
  const endpoint = entityEndpoint(entity);
  const property = entityProperty(entity);
  const role = String(entity.capability?.semanticRole || "");
  if (entity.capability?.observable !== true) return null;
  const matches = PROFILES.filter((profile) => {
    if (profile.strategy === "bounded_read") return false; // only selected explicitly per model
    if (normalized(profile.integration) !== integration) return false;
    if (profile.manufacturer && normalized(profile.manufacturer) !== manufacturer) return false;
    if (profile.model && normalized(profile.model) !== model) return false;
    if (profile.endpoint !== null && profile.endpoint !== endpoint) return false;
    if (profile.property && profile.property !== property) return false;
    if (profile.semanticRole && profile.semanticRole !== role) return false;
    if (profile.requiresModelApproval && !approvedModels.some((entry) => entry.profileId === profile.id
      && normalized(entry.manufacturer) === manufacturer && normalized(entry.model) === model)) return false;
    return true;
  });
  // Exact (model-specific) profiles win over generic ones; ambiguity matches nothing.
  const specific = matches.filter((profile) => profile.model);
  const chosen = specific.length ? specific : matches;
  return chosen.length === 1 ? chosen[0] : null;
}

/// The exact Zigbee2MQTT reporting entry for a profile on its control's own endpoint (from a
/// bridge/devices entry), or null. Never borrows another endpoint's entry.
function cachedReportingFor(rawDevice, profile, endpoint) {
  const entry = rawDevice?.endpoints?.[String(endpoint)];
  const reportings = Array.isArray(entry?.configured_reportings) ? entry.configured_reportings : [];
  const match = reportings.filter((item) => item?.cluster === profile.cluster && item?.attribute === profile.attribute);
  if (match.length !== 1) return null;
  const item = match[0];
  return {
    minimumReportInterval: Number(item.minimum_report_interval),
    maximumReportInterval: Number(item.maximum_report_interval),
    reportableChange: item.reportable_change === undefined || item.reportable_change === null ? null : Number(item.reportable_change),
  };
}

function reportingMatches(actual, desired) {
  if (!actual || !desired) return false;
  return Number(actual.minimumReportInterval) === desired.minimumReportInterval
    && Number(actual.maximumReportInterval) === desired.maximumReportInterval
    && (desired.reportableChange === undefined || actual.reportableChange === null
      || Number(actual.reportableChange) === desired.reportableChange);
}

module.exports = {
  DELIVERY_GRACE_SECONDS,
  MISSED_REPORTS_TOLERATED,
  PROFILES,
  READ_REPLY_TIMEOUT_SECONDS,
  boundedReadLifetime,
  cachedReportingFor,
  entityEndpoint,
  entityProperty,
  matchObservationProfile,
  periodicLifetime,
  reportingMatches,
};
