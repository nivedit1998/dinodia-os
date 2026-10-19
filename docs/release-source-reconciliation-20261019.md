# Native V2 Hub source reconciliation and sync-loop repair

Date: 2026-10-19

## Live Hub evidence

At initial reconciliation, a read-only SSH check of `dinodia@192.168.0.110` reported build `native-v2-cb8fdabed761a404b0fb7f32`. After the reviewed batching release was installed, the live build is `native-v2-6b64d60ad5caee80b54bb871`; the code rollback target is `native-v2-cb8fdabed761a404b0fb7f32`. Current live source hashes for `src/platformPairing.js`, `src/server.js`, `src/store.js`, `src/mqttBridge.js`, and `src/sync/usageBuckets.js` are respectively:

- `a5c690a31fea6b0e3588cd4c084b346b24cc5b40b8d40a6c3beb62f677b349a6`
- `c47d4ed5bfd9e06f4377da20955cbe8266b019cf96f0d223c74fbf3ab3980426`
- `b564003a2e7835ba98e8de27c843114d30b23260717e72039db0f9459731c605`
- `d76484635f516f8e2080f2f262ca50aa71d3776dec435a57c53c38923d7a15b9`
- `ce5bc60547bddfd759bb9ee3a1d36c11e1389b9dedaecc2e9ec2163f0d256d2d`

These live files are byte-identical to the reviewed release branch. The Pi is running the idle sync cadence and 10-second deferred Store persistence code. The deferred path is reached from `src/mqttBridge.js` for Zigbee state reports.

The original Stage 12 checkout had 41 changed/untracked paths (27 tracked modifications and 14 additions). Comparing those contents with the live-source reconciliation isolated the substantive conflict to these three files: `src/platformPairing.js`, `src/server.js`, and `src/store.js`. The dirty-checkout variants were not selected because the Pi's hashes matched the reconciled release versions. The rest of the required source snapshot was imported from the verified release package; incident-only materials were separated as described below.

## Deferred persistence finding and correction

The Store's `updateDeviceState(..., { deferPersist: true })` scheduled telemetry persistence, but `MqttBridge.handleMessage()` then called `Store.addEvent()` for every state report. `addEvent()` persisted the complete Store immediately, clearing the timer. Therefore the normal MQTT path did not actually coalesce the device state and its diagnostic event into the intended write window.

The repair gives `addEvent()` an opt-in `deferPersist` option and uses it only for the routine MQTT `device_state` event. A follow-up review found that the same deferred `updateDeviceState()` call can also mutate usage-accounting cursors and enqueue `usage.bucket` / `temperature.sample` events. Those are durable sync state—not diagnostics—and must not wait for the debounce window. The Store now distinguishes an accepted usage-source mutation from stale/duplicate observations and forces persistence immediately whenever usage state or an analytics outbox event changes. Only the local `device_state` diagnostic remains coalesced; sync, command, policy, and usage state retain immediate durability.

`test/protocol-bridges.test.js` exercises the real MQTT handler: for an ordinary report with no durable sync mutation, it verifies no early disk write, one combined write at the deadline, immediate flush on a configuration mutation, no duplicate timer write, and immediate durability for a non-telemetry event. `test/radiator-observation-repair.test.js` also verifies that a deferred radiator report has already persisted its usage cursor and `usage.bucket` / `temperature.sample` outbox events when the update resolves. This is behavioral test evidence; an independent production filesystem-write-rate measurement has not yet been made.

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

The source reconciliation was built from local Stage 12 commit `71e9093`. A remote review base, `review/native-v2-stage12-base-20261019`, points at that commit. PR [#1](https://github.com/nivedit1998/dinodia-os/pull/1) is open against that base from `release/native-v2-cb8fdab-sync-loop-20261019`; it is not merged. The PR contains the reconciliation, sync-loop, LAN-guard, and Store-persistence history. Integration of the broader Stage 12 stack into `main` remains a separate decision.

## Verification and limits

- Final full Node suite after the analytics durability correction: 512 tests, 508 passed, 0 failed, 4 skipped.
- Focused protocol bridge, radiator observation, and usage-bucket tests: 33 passed, 0 failed in the targeted run; the final full-suite run also includes the added accepted/duplicate/stale mutation assertions.
- Python Hive adapter tests: 4 passed. Syntax, Native V2 boundary, and Hive lock checks passed.
- A previous packaged-source baseline passed 510 tests: 506 passed, 0 failed, 4 skipped.
- The Pi install log reports the sync-loop fix is installed on build `native-v2-cb8fdabed761a404b0fb7f32`. The user relayed Claude's read-only Vercel Observability measurement for 21:18–22:18 UTC after installation: 52 `sync` calls, 52 `token-state` calls, 190 total function calls, compared with about 1,300 calls for each hub route and 2,800 total in the earlier comparison window. These reported figures imply roughly 96% fewer calls across those two hub routes and 93% fewer total calls; Codex has not independently queried Vercel. A longer 24-hour comparison remains useful but is not required to show the short-term reduction.
- The Store batching release was installed on build `native-v2-6b64d60ad5caee80b54bb871`, with `native-v2-cb8fdabed761a404b0fb7f32` retained as its code rollback target. The install output reports the private backup manifest passed, Store schema 10, the Zigbee configuration unchanged, and local installation checks passed. A subsequent read-only check confirmed the live build, health, MQTT/Matter connectivity, active services, zero service restarts, and no recent Dinodia OS error entries.
- A read-only 60-second sample used one-second `stat` sampling of `dinodia.json` metadata only (inode, size, mtime, ctime); it detected 5 metadata transitions. Compared with the owner-provided earlier baseline of about 57 writes/minute on `cb8fdabe`, this idle sample is clearly lower, but it is not a controlled same-window comparison or syscall-level count; multiple writes between samples could appear as one transition. No Store contents were read by the sampler.
- One owner-initiated Radiator 1 control change and confirmation/receipt timing check is still pending. No control was issued by Codex.
- The original working checkout and its 41 pre-existing modified/untracked paths have not been staged, reset, or edited.
- Repository public visibility is intentional per the owner; no visibility change was requested or made.
