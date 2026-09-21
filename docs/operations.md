# Hive operations runbook

## Normal setup

Open the dashboard at the named Cloudflare hostname and choose **Pair a device → Hive**. Enter the Hive account owner's email and password, then the SMS code if Hive asks for one. No boiler, receiver, thermostat, serial-port, or model-number entry is required. A discovered heating zone is shown as **Needs setup** until its name, provisioned area, and `Boiler` label are confirmed.

## Reauthentication

If the Hive row says **Action needed**, choose **Reconnect account** and repeat the owner-account flow. A failed token refresh does not delete zones, areas, labels, or assignments. Dinodia OS stops Hive polling and rejects controls until authentication succeeds; Zigbee, Matter, Thread, Cloudflare, and the HA-compatible API continue independently.

## Cloud outage

During a Hive outage the integration changes to degraded/unavailable with a bounded retry. The dashboard and core health endpoint remain available. Do not repeatedly submit credentials. Check the Activity section for one parent Hive incident, restore internet access, and use **Refresh Hive devices** after recovery.

## Hide, restore, and disconnect

- **Remove paired device** hides one local Hive zone and records a cloud-ID tombstone. It does not alter the customer's Hive account or physical boiler. Use **Restore** in the Hive details row to make it eligible for discovery again.
- **Disconnect Hive** attempts the supported remote deregistration operation, then removes the encrypted account record, all local Hive devices/entities/aliases/states, the `ce_hive` entry, and tombstones. If remote deregistration cannot be confirmed, the UI must require an explicit local-only confirmation.

## Dependency updates

Review the upstream Hive integration and Home Assistant compatibility before changing `pyhive-integration`. Regenerate `requirements-hive.lock` for Python 3.10–3.13 on aarch64, preserve hashes, run the offline/mock suite, build both deployment paths, and record the new version and audit date in `THIRD_PARTY_NOTICES.md`. Never use an unconstrained version on an installed hub.

## Backup and rollback

Run `npm run backup` before an update. The encrypted backup contains the encrypted Hive vault record and the non-secret store snapshot; the plain data store never contains Hive passwords or tokens. Keep the matching machine key. If the update fails, stop the service, restore the previous application/data backup, and restart; do not delete `/var/lib/dinodia-os`.

## Pi checks

```bash
sudo systemctl status dinodia-os --no-pager
curl -fsS http://127.0.0.1:8123/api/health
# Dashboard integration status requires an authenticated Company Portal operator session.
sudo journalctl -u dinodia-os -n 100 --no-pager
```

The second endpoint is intentionally sanitized. Do not paste credentials, SMS codes, vault files, or raw Hive responses into support tickets.

## Google Nest operations

The Google Nest integration is optional and Sandbox beta only. Configure the encrypted operator record with `scripts/configure-google-nest.js` while `dinodia-os` is stopped. Register the exact HTTPS callback in Google Cloud and use the Cloudflare dashboard for customer authorization. A short-lived access token refreshes automatically; a `reauth_required` state means Google revoked or expired the refresh authorization and the owner must reconnect.

For a temporary Google outage, leave the hub running: cached thermostat cards remain available with degraded status and polling backs off. Use **Refresh Google Nest** after recovery. **Remove paired device** removes only the local Dinodia projection and creates a hidden-device tombstone. **Disconnect Google Nest** revokes the refresh token where possible and removes all local Nest devices; it never deletes Google Home devices or schedules. If revocation cannot be confirmed, use local-only removal only after explicit approval.

```bash
sudo systemctl status dinodia-os --no-pager
curl -fsS http://127.0.0.1:8123/api/health
# Dashboard integration status requires an authenticated Company Portal operator session.
sudo journalctl -u dinodia-os -n 100 --no-pager | rg -i 'google-nest|google nest'
```

Never copy the encrypted vault, callback query string, OAuth URL, client secret, refresh token, access token, full SDM resource name, or raw Google response into a ticket.
## Native V2 automations

The store schema is version 10. On the first normal write after an upgrade,
legacy nested rules are retained in `legacyAutomations`; only definitions that
already have the native schedule/action shape are placed into normalized
automation, trigger, and action maps. Migration is deterministic and safe to
repeat. Removing a device does not delete a native definition: its health
becomes `needs_attention` so the operator can repair it after rediscovery.

The native scheduler is local to the hub. It claims each occurrence using the
automation ID, revision, local calendar date, and scheduled minute, so a second
tick or a repeated daylight-saving hour cannot run it twice. A process restart
marks unfinished occurrences interrupted and leaves uncertain action outcomes
for review. Routine action failures stay in local automation history and do not
become company incidents by default.

Before enabling this on a production hub, review the catalogue in read-only
mode and take a backup. Set `DINODIA_NATIVE_AUTOMATIONS_MODE=enabled` only in a
controlled maintenance window, then monitor `/api/status` and the automation
execution endpoint. Revert to `read_only` to stop new native writes and
scheduling while leaving definitions and history intact.
