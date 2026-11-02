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
  return intervalSeconds * (1 + MISSED_REPORTS_TOLERATED) + DELIVERY_GRACE_SECONDS;
}

// Exact models the owner has approved for each model-gated profile (none at present: the mains on/off profile below is class-based).
// Adding a model is a deliberate, reviewed change here.
const APPROVED_MODELS = Object.freeze([]);

// A device is "mains powered" when its radio says so. Battery and unknown power sources are never configured automatically:
// a wrong reporting setting can drain a battery, so those need their own exact, owner-approved profile (like the TRVZB).
const MAINS_POWER_SOURCE = /mains|dc source|single.phase|three.phase/i;
function isBatteryPowered(device) { return /battery/i.test(String(device?.metadata?.power_source || "")); }
// A battery device is only configured when its battery level is readable, because the drain watch needs it.
function batteryEntity(device) {
  return Object.values(device?.entities || {}).find((entity) => entity && String(entity.stateKey || "") === "battery"
    && entity.capability?.readable === true) || null;
}
function isMainsPowered(device) {
  return MAINS_POWER_SOURCE.test(String(device?.metadata?.power_source || ""))
    && !/battery/i.test(String(device?.metadata?.power_source || ""));
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
    // The id keeps its old name so the record of an already-configured light carries over; it now covers every mains device with
    // a standard on/off state (lights, dimmers, plugs, relays, wall switches) of any brand.
    id: "zigbee.generic.mains_light.on_off",
    version: 2,
    integration: "zigbee",
    manufacturer: null,
    model: null,
    endpoint: null, // the control's own endpoint
    cluster: "genOnOff",
    attribute: "onOff",
    property: null,
    propertyPattern: /^state(_[a-z0-9]+)?$/i, // "state", or one channel of a multi-gang device ("state_l1")
    semanticRole: "power",
    power: "mains",
    requiresMainsPower: true,
    strategy: "report_on_change_plus_periodic",
    desired: Object.freeze({ minimumReportInterval: 0, maximumReportInterval: 300, reportableChange: 0 }),
    lifetimeSeconds: periodicLifetime(300),
    // Owner-approved 2 Nov 2026 ("same as the radiators", then "automatic for all mains on/off and dimmer devices, keep battery
    // devices gated"): the hub asks a mains-powered device to report its on/off state on change and at least every 5 minutes, reads
    // the setting back, verifies the cadence from real reports, and is bound by the reconciler's daily write budget, one-request-at-a-time
    // spacing and silence detection. The exact endpoint must carry the genOnOff cluster; otherwise there is no match.
    approvedForAutomaticConfiguration: true,
    requiresModelApproval: false,
  }),
  Object.freeze({
    // Mains-powered heating devices with a standard thermostat (boiler receivers, wall thermostats, mains radiator controllers): any brand.
    id: "zigbee.generic.mains_thermostat.heat_demand",
    version: 1,
    integration: "zigbee",
    manufacturer: null,
    model: null,
    endpoint: null,
    cluster: "hvacThermostat",
    attribute: "runningState",
    property: "running_state",
    semanticRole: "active_heat_demand",
    power: "mains",
    requiresMainsPower: true,
    strategy: "report_on_change_plus_periodic",
    desired: Object.freeze({ minimumReportInterval: 0, maximumReportInterval: 300, reportableChange: 0 }),
    lifetimeSeconds: periodicLifetime(300),
    // Owner-approved 2 Nov 2026, same rails as the mains on/off profile.
    approvedForAutomaticConfiguration: true,
    requiresModelApproval: false,
  }),
  Object.freeze({
    // Battery radiator valves and thermostats of any brand. The exact TRVZB profile above wins for that model. A battery device is
    // configured only when (a) its original reporting setting was read back first so it can be restored, (b) its battery level is
    // readable, and (c) the reconciler's battery drain watch stays on: if the battery drains faster than the limit, or runs low, the
    // original setting is restored automatically and the device is never configured again without a person approving it.
    id: "zigbee.generic.battery_thermostat.heat_demand",
    version: 1,
    integration: "zigbee",
    manufacturer: null,
    model: null,
    endpoint: null,
    cluster: "hvacThermostat",
    attribute: "runningState",
    property: "running_state",
    semanticRole: "active_heat_demand",
    power: "battery",
    requiresBatteryPower: true,
    requiresBatteryReading: true,
    requiresBatteryWatch: true,
    strategy: "report_on_change_plus_periodic",
    desired: Object.freeze({ minimumReportInterval: 0, maximumReportInterval: 600, reportableChange: 0 }),
    lifetimeSeconds: periodicLifetime(600),
    approvedForAutomaticConfiguration: true,
    requiresModelApproval: false,
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
    readIntervalSeconds: 300,
    lifetimeSeconds: boundedReadLifetime(300),
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

/// The Zigbee endpoint that actually carries a cluster for this control. Zigbee2MQTT exposes some
/// values without an endpoint (stored as "0"/empty); then the endpoint is resolved only when exactly
/// one endpoint of the device carries the cluster. Otherwise there is no match (never a guess).
function resolvedEndpoint(device, entity, cluster) {
  const declared = entityEndpoint(entity);
  if (declared && declared !== "0") return declared;
  if (!cluster) return declared;
  const endpoints = device?.metadata?.endpoints && typeof device.metadata.endpoints === "object" ? device.metadata.endpoints : {};
  const carrying = Object.entries(endpoints).filter(([, endpoint]) => {
    const input = endpoint?.clusters?.input;
    return Array.isArray(input) && input.includes(cluster);
  }).map(([id]) => String(id));
  return carrying.length === 1 ? carrying[0] : null;
}

function entityProperty(entity) {
  return String(entity?.stateKey || entity?.binding?.property || "").trim();
}

/// The single profile that matches this exact control, or null. Generic profiles that require a
/// model approval match only once that model is listed in `approvedModels`.
function matchObservationProfile(device, entity, { approvedModels = APPROVED_MODELS } = {}) {
  if (!device || !entity) return null;
  const integration = normalized(device.protocol);
  const manufacturer = normalized(device.metadata?.manufacturer || device.metadata?.vendor);
  const model = normalized(device.metadata?.model || device.metadata?.model_id);
  const property = entityProperty(entity);
  const role = String(entity.capability?.semanticRole || "");
  if (entity.capability?.observable !== true) return null;
  const matches = PROFILES.filter((profile) => {
    if (profile.strategy === "bounded_read") return false; // only selected explicitly per model
    if (normalized(profile.integration) !== integration) return false;
    if (profile.manufacturer && normalized(profile.manufacturer) !== manufacturer) return false;
    if (profile.model && normalized(profile.model) !== model) return false;
    if (profile.endpoint !== null && profile.endpoint !== resolvedEndpoint(device, entity, profile.cluster)) return false;
    // A generic profile names no endpoint, so the control's own endpoint must be one that really carries the cluster: never a guess.
    if (profile.endpoint === null && profile.cluster) {
      const endpoint = resolvedEndpoint(device, entity, profile.cluster);
      const input = device?.metadata?.endpoints?.[endpoint]?.clusters?.input;
      if (!endpoint || !Array.isArray(input) || !input.includes(profile.cluster)) return false;
    }
    if (profile.propertyPattern ? !profile.propertyPattern.test(property) : profile.property && profile.property !== property) return false;
    if (profile.requiresMainsPower && !isMainsPowered(device)) return false;
    if (profile.requiresBatteryPower && !isBatteryPowered(device)) return false;
    if (profile.requiresBatteryReading && !batteryEntity(device)) return false;
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
  APPROVED_MODELS,
  batteryEntity,
  isBatteryPowered,
  isMainsPowered,
  DELIVERY_GRACE_SECONDS,
  MISSED_REPORTS_TOLERATED,
  PROFILES,
  READ_REPLY_TIMEOUT_SECONDS,
  boundedReadLifetime,
  cachedReportingFor,
  entityEndpoint,
  entityProperty,
  matchObservationProfile,
  resolvedEndpoint,
  periodicLifetime,
  reportingMatches,
};
