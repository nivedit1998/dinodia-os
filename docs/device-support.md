# Device support

Dinodia OS uses Zigbee2MQTT's bundled, version-pinned `zigbee-herdsman-converters` for Zigbee matching, decoding, exposes, and commands. The OS consumes the device definition and live exposes; it does not execute converter templates or load arbitrary Python/ZHA quirks.

Matter is introspected from the commissioned node's live endpoints and clusters. The checked-in catalogue is only typed model metadata used to validate safe mappings.

## Unsupported or partial devices

An unsupported device remains visible as **Needs device support** with model, manufacturer, endpoints, interview status, converter/model version, and sanitized diagnostics. It is not given a raw cluster-write form.

To investigate, download the authenticated support bundle, remove any local-identifying information that is not needed, and add a fixture plus a reviewed normalizer change. External converters are disabled by default. Any future Dinodia converter bundle must be versioned, checksum verified, tested on arm64, and reversible before installation.

The four user labels are fixed for now: `Light`, `Boiler`, `Radiator`, and `Tenant Device`.

After a Zigbee interview or Matter commissioning, the dashboard asks for one optional device name, one provisioned area, and exactly one of those labels. The presentation engine then creates bounded household control surfaces from the retained converter/cluster metadata. Raw battery, voltage, link quality, calibration, schedule, and other diagnostic entities remain available to authenticated Dinodia OS support views but are not sent as household tiles.

Surface IDs are stable for the same physical device, protocol endpoint, and semantic domain. A device name change changes the display name only. A device-level area or label change rebuilds the surfaces atomically and the Home Assistant-compatible registry inherits the same area and device label.
