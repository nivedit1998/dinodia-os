# Native V2 Hub source reconciliation and sync-loop repair

Date: 2026-10-19

## Live Hub evidence

A read-only SSH check of `dinodia@192.168.0.110` reported installed build `native-v2-cb8fdabed761a404b0fb7f32`. Before this branch's telemetry-event correction, the live source hashes for `src/platformPairing.js`, `src/server.js`, and `src/store.js` were respectively:

- `a5c690a31fea6b0e3588cd4c084b346b24cc5b40b8d40a6c3beb62f677b349a6`
- `c47d4ed5bfd9e06f4377da20955cbe8266b019cf96f0d223c74fbf3ab3980426`
- `70ea4dad7681744adc7e6d78827dc1dfddaae769f874abce825d9974a00ee21e`

Those three files were byte-identical to the reconciled source branch before the changes below. The Pi's source also confirmed the idle sync cadence and the 10-second deferred Store persistence code are installed. The deferred persistence path is reached from `src/mqttBridge.js` for Zigbee state reports.

The original Stage 12 checkout had 41 changed/untracked paths (27 tracked modifications and 14 additions). Comparing those contents with the live-source reconciliation isolated the substantive conflict to these three files: `src/platformPairing.js`, `src/server.js`, and `src/store.js`. The dirty-checkout variants were not selected because the Pi's hashes matched the reconciled release versions. The rest of the required source snapshot was imported from the verified release package; incident-only materials were separated as described below.

## Deferred persistence finding and correction

The Store's `updateDeviceState(..., { deferPersist: true })` scheduled telemetry persistence, but `MqttBridge.handleMessage()` then called `Store.addEvent()` for every state report. `addEvent()` persisted the complete Store immediately, clearing the timer. Therefore the normal MQTT path did not actually coalesce the device state and its diagnostic event into the intended write window.

The repair gives `addEvent()` an opt-in `deferPersist` option and uses it only for the routine MQTT `device_state` event. State and event now share the existing 10-second persistence window. Other event callers retain immediate durability. Any normal Store mutation still flushes the scheduled write, and shutdown still calls `flushPersist()`.

`test/protocol-bridges.test.js` now exercises the real MQTT handler: it verifies no early disk write, one combined write at the deadline, immediate flush on a configuration mutation, no duplicate timer write, and immediate durability for a non-telemetry event. The focused protocol bridge suite passed 14/14 after this correction. This is behavioral test evidence; an independent production filesystem-write-rate measurement has not yet been made.

## Source history and incident-tool separation

The source packet `DINODIA_HUB_SYNC_LOOP_FIX_PACKET_20261019/dinodia-os-source.tar.gz` has SHA-256 `a4d0110f3b7f5c0b437e53cf367ae35a2cfeac0ea8e07aac861b72ecec047b9b` and contains 174 packaged source/runtime files. The sync-loop patch was kept as its own reviewable commit after importing the pre-fix package source.

The published product history intentionally excludes these Pi-incident-only files and their fixed Home/device/hash/network details:

- `scripts/install-store-recovery.sh`
- `scripts/recover-store.js`
- `scripts/recover-sync-request-loss.js`
- `scripts/repair-lan-network.js`
- `test/recover-store.test.js`

`src/dockerNetworkGuard.js` and `test/docker-network-guard.test.js` are retained: they implement and verify a generic production guard against Docker bridge subnets overlapping host LAN/VPN routes. Only `scripts/repair-lan-network.js`, which performs a fixed incident-specific repair, is excluded. The installer no longer exposes the one-off `DINODIA_STORE_RECOVERY_MODE=incident-20261016` path. Generic Store durability, backup, restore, and signed request-loss recovery code/tests remain. The removed incident materials, including the historical installer version that referenced them, were preserved outside the repository in a mode-0700 private directory; the archive SHA-256 is `f2b74f7ec6e4251d92782f46708df339cbf60e0aaa6175e4fc31d13281a4ea06`.

## Branch and integration target

The source reconciliation was built from local Stage 12 commit `71e9093`. GitHub currently exposes only `main` (`80e9390`) and `stage-01-security` (`dc87f7f`); there is no remote Stage 12 branch. The reviewed branch is `release/native-v2-cb8fdab-sync-loop-20261019`. The intended PR base is `main`, because this branch contains the completed Stage 2–12 stack and is an ancestor of the integration branch. Targeting `stage-01-security` would send the downstream stack backwards into an early-stage branch. This is a broad PR (129 commits beyond `main` before the repair commits), not a narrow fix; push it as a review branch and do not merge without a full-stack review. No production installation is implied by this record.

## Verification and limits

- The pre-existing reconciliation branch's patched source previously passed 515 tests: 511 passed, 0 failed, 4 skipped. The final reviewed branch is being rerun after the deferred-event correction and incident-path removal.
- The focused MQTT/protocol bridge suite after the correction: 14 passed, 0 failed.
- A previous packaged-source baseline passed 510 tests: 506 passed, 0 failed, 4 skipped.
- The Pi install log reports the sync-loop fix is installed on build `native-v2-cb8fdabed761a404b0fb7f32`; Platform-call reduction still needs a representative Vercel Observability window to quantify.
- The original working checkout and its 41 pre-existing modified/untracked paths have not been staged, reset, or edited.
