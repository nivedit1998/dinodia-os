# Hive testing guide

## Offline CI checks

Run from the Dinodia OS directory:

```bash
npm run check
npm test
npm run check:generated
npm run test:hive-python
npm run check:hive-lock
```

The fixtures under `test/fixtures/hive` contain no customer credentials. Node tests cover identity stability, friendly naming, duplicate zones, infrastructure/hot-water filtering, climate projection, commands, removal/tombstones, secure HTTP routes, worker correlation, and account cleanup. Python tests replace `apyhiveapi` with a fake client and cover login, discovery, mapping, commands, session stop, and error redaction.

## Failure injection

The worker boundary must be tested with an absent dependency, malformed JSON, oversized output, timeout, child crash, rejected request, HTTP 401/403/429/500, DNS failure, and no internet. Expected behavior is a bounded Hive degradation and a healthy core process. No test may use a real Hive account.

## Physical acceptance

With the homeowner present, use the secure Cloudflare hostname and have the owner enter their own credentials and SMS code. Confirm the correct heating-zone count, no hub/receiver duplicate cards, one `Boiler` assignment per zone, current/target temperature, `auto`, `heat`, and `off`, and command results in the native Hive app. Change a target in Hive and confirm the next Dinodia poll updates the standard climate state. Reboot, briefly remove Ethernet, test reauthentication, remove/restore one zone, disconnect/reconnect the account, and confirm non-Hive devices and integrations remain unchanged.

For the final release, run a 72-hour soak with existing Zigbee, Matter, Thread, Cloudflare, platform heartbeat, Activity, and automations enabled. Record CPU/RAM, poll success/failure counts, restart count, and any incident IDs without recording credentials or raw cloud payloads.

## Native V2 automation checks

Run the deterministic native suite with no hardware:

```bash
npm run check
npm test -- test/native-automation.test.js
```

The suite covers the version-10 migration, normalized child rows, typed target
validation, safe public catalogue projection, timezone/ISO weekday matching,
idempotent creation, optimistic revision checks, ordered execution, durable
duplicate suppression, and conservative restart recovery. The complete
`npm test` command remains mandatory because the legacy Home Assistant-shaped
automation path must continue to pass.

For a Pi smoke check, first copy the build and restart the service in a
controlled window. Confirm the authenticated responses from
`GET /api/health`, `GET /api/status`, and `GET /api/automations/catalog`, then
create a test schedule for a real safe device. Close the phone/dashboard,
capture the single occurrence and ordered action outcomes from
`GET /api/automations/<id>/executions`, restart before a second tick, and
confirm no duplicate occurrence is created. Do not use real momentary or
destructive controls for this test. A production Pi must remain in
`read_only` until the operator has reviewed catalogue and migration evidence.

## Google Nest beta testing

Run `npm run test:google-nest` and the complete regression commands before using a real account. Mock tests cover OAuth state/replay, token exchange and refresh, SDM validation, trait normalization, climate projection, commands, removal, callback security, and secret redaction. The physical Sandbox check must use an allowlisted test Google account and a real supported thermostat: authorize through Cloudflare, assign an existing area and `Boiler`, verify current/target/mode/heating state against Google Home, wait for an external change to poll through, restart the Pi, simulate token expiry and Ethernet loss, revoke/reauthorize, remove/restore, and disconnect. Keep the feature disabled for general customer homes until Google's commercial and OAuth gates are cleared.
