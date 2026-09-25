# Dinodia OS

Dinodia OS is the local-first Raspberry Pi hub that presents a Home Assistant-compatible API to the existing Dinodia platform and iOS app. It is designed for Raspberry Pi 4 Model B (2 GB, 64-bit Raspberry Pi OS) and keeps the existing Cloudflare, provisioning, heartbeat, area, label, and HA-compatible contracts intact.

## Quick start

1. Install 64-bit Raspberry Pi OS, enable SSH, and confirm `uname -m` is `aarch64`.
2. Copy this directory to the Pi and run `sudo bash scripts/install-pi.sh`.
3. Open the installer-only setup address `http://dinodia-<serial>.local/setup` and complete the paired Company Portal provisioning session. Production does not expose a reusable dashboard token.
4. Complete Cloudflare named-tunnel setup if remote access is required.
5. In **Radios & networks**, choose the connected supported coordinator from the dropdown. Dinodia writes a stable `/dev/serial/by-id` Zigbee2MQTT configuration. Select the separate OpenThread RCP for Thread.
6. Start Zigbee pairing or Matter commissioning from **Add devices**. Both protocols end in one device setup card: optional name, required provisioned area, and one fixed label. Dinodia then derives safe household controls from the device capability.

The unified Dinodia dashboard and Home Assistant-compatible API are on port `8123`; the local Hub Agent compatibility API is on `8099`. The existing Cloudflare hostname serves both the dashboard and API through the `8123` origin. There is no separate legacy dashboard listener.

## Zigbee and Matter

Zigbee uses pinned Zigbee2MQTT and its bundled `zigbee-herdsman-converters`; Matter uses live endpoint introspection plus the generated catalogue. See [docs/device-support.md](docs/device-support.md) and [docs/matter-networking.md](docs/matter-networking.md).

The production UI has no raw command editor or test device. Protocol diagnostics are authenticated and sanitized. Pairing is bounded and can be stopped safely.

### Hive heating

Open **Pair a device → Hive** and connect the homeowner's Hive owner account. No receiver or thermostat model number is needed: Dinodia discovers heating zones through the pinned `pyhive-integration` adapter. Hive SMS verification and any new-client registration are completed in the dashboard. Each discovered zone remains **Needs setup** until an area and the `Boiler` label are confirmed. The resulting standard `climate` surface is compatible with the existing Dinodia platform and iOS client.

Hive credentials, tokens, and client-registration data are held only in the encrypted local vault. Credential and MFA submissions require the secure Cloudflare dashboard in production; the development override is disabled by default. Hive uses an unofficial cloud API, so a cloud outage degrades Hive only and does not affect Zigbee, Matter, Thread, Cloudflare, or the HA-compatible API. Disconnecting Hive removes the local account, devices, projections, and secrets but does not reset physical Hive hardware or delete Hive schedules.

## Updates and rollback

Back up before updating with `npm run backup` or the dashboard backup action. The release image set is recorded in `docker/versions.env`; keep the previous application directory and image digests until the new version passes health, provisioning, Cloudflare, platform, and device checks. To roll back, stop the service, restore the previous application directory and data backup, then restart. Never delete the data directory as part of a normal update.

Dinodia OS is the first simple, local-first Dinodia Hub appliance for Raspberry Pi 4. It runs one small Node service and can connect to protocol services only when the relevant hardware is installed.

## What is included

- Unified local dashboard and Home Assistant-compatible REST/WebSocket API at `http://<pi-ip>:8123`
- Dinodia Hub Agent-compatible local API at `http://<pi-ip>:8099`
- Token-protected device, registry, service and automation APIs
- Native V2 schedule automations with a capability-driven editor, durable occurrences, and restart-safe local execution
- JSON persistence with atomic writes and rotating backups
- Zigbee2MQTT MQTT adapter for Zigbee devices
- Matter Server WebSocket adapter for Matter devices
- OpenThread Border Router deployment profile for Matter over Thread
- Optional Cloudflare Tunnel profile for remote access
- First-boot Cloudflare setup in the dashboard (temporary link or named tunnel)
- Room/area and fixed-label registry with device-level setup and dynamic control surfaces
- Hive owner-account integration for cloud heating zones, SMS verification, and standard Boiler/climate projection
- Bounded live Activity ledger with device filtering, retention, offline detection, and incident outbox
- Dinodia platform pairing, rotating hub-token synchronization, and area snapshots
- Raspberry Pi installer and systemd service
- Automated unit and HTTP API tests

### Important compatibility decision

ZHA is a Home Assistant integration. Because Dinodia OS replaces Home Assistant, it uses Zigbee2MQTT as the standalone Zigbee runtime while exposing the ZHA-compatible calls required by the unchanged Dinodia app. The app does not need to know that the radio is backed by Zigbee2MQTT.

## Fast local development

```bash
cp .env.example .env
npm install
npm test
npm run check
npm start
```

Open `http://127.0.0.1:8123` for the explicitly configured development compatibility harness. Production has no reusable dashboard password.

The dashboard can create a virtual test switch. This makes the core UI, device commands, persistence and automations testable without any radio hardware.

### Native V2 automations

Open **Automations → New automation** to choose a local schedule and one or more
safe controls from the live Dinodia OS catalogue. Dinodia stores the automation,
its schedule trigger, and each ordered device action as separate normalized
records. The hub executes enabled schedules locally, even when the phone or
internet connection is unavailable. Device and control changes are reconciled
at execution time; an invalid action is retained and shown as **Needs attention**
instead of being silently removed.

Native schedules are enabled by default for development. Production starts in
safe read-only mode until the operator explicitly sets
`DINODIA_NATIVE_AUTOMATIONS_MODE=enabled`. Set it to `off` to hide the native
catalogue and scheduler. Supported controls are derived from current writable
capabilities; unsafe toggle, unlock, reset, pairing, and configuration services
are never offered.

## Raspberry Pi 4 deployment

Raspberry Pi 4 Model B (including the 2GB model) is supported. Use Raspberry Pi OS 64-bit Lite, Ethernet where possible, reliable power, and a quality SD card or USB/NVMe boot device. The native installer uses Node.js 18+ and Python 3.10+ for the isolated Hive adapter; it installs Python venv support when needed. The Docker image uses a multi-architecture Node image and builds the same isolated Hive environment.

From the Pi:

```bash
sudo apt update
sudo apt install -y git nodejs npm openssl
git clone <your-Dinodia-OS-repository>
cd "Dinodia OS"
sudo bash scripts/install-pi.sh
```

The installer copies the service to `/opt/dinodia-os`, stores data in `/var/lib/dinodia-os`, and starts `dinodia-os.service` only after the two-phase manufacturing identity ceremony completes. Phase 1 generates and encrypts the signing/encryption keys locally on the hub; the offline manufacturing authority signs the printed public certificate; phase 2 verifies that signature on the hub before activation. No manufacturing-root private key is copied to the hub. The unified dashboard and HA compatibility surface is on `8123`; the Hub Agent compatibility surface is on `8099`. For the bundled Mosquitto/Zigbee2MQTT/Matter protocol topology, use the Docker Compose deployment below; the native service remains useful as the lightweight compatibility core when those protocol runtimes are managed separately.

Useful commands:

```bash
sudo systemctl status dinodia-os
sudo journalctl -u dinodia-os -f
curl http://127.0.0.1:8123/api/health
```

Install `cloudflared` before using the native-install dashboard remote-access controls. On Raspberry Pi OS/Debian:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
cloudflared --version
```

Open the installer-only local setup address `http://dinodia-<serial>.local/setup` and complete the paired Company Portal session. Production does not use a pasted dashboard password. Cloudflare setup is available only inside that paired setup session, uses the Platform-reserved Dinodia company hostname, and must complete remote verification before installation can be marked complete. The local Hub Agent port is never the tunnel origin. The public dashboard URL is `https://<hostname>/` without `:8123`.

## Docker Compose deployment

This is the easiest way to run the app and its local MQTT broker:

```bash
cp .env.example .env
docker compose up -d --build
```

The protocol services are opt-in because they require the actual USB radio hardware. Start the Dinodia core first, choose the coordinator in its dashboard, then start the Zigbee profile.

### Zigbee

1. Plug in the Home Assistant Zigbee dongle. It can be used as the coordinator by Zigbee2MQTT, but it must not be opened by ZHA/Home Assistant at the same time.
2. Open the setup dashboard and press **Scan again**. Select the connected coordinator from the dropdown and press **Use this dongle**. The dashboard identifies Home Assistant Connect ZBT-1/SkyConnect as `ember`; Sonoff/CC2652/ZNP devices as `zstack`; and ConBee devices as `deconz`.

For diagnostics, the stable path can also be inspected with:

```bash
ls -l /dev/serial/by-id/
```

3. Start Zigbee2MQTT:

```bash
sudo docker-compose --profile zigbee up -d mosquitto zigbee2mqtt
```

When using the native Dinodia service installed by `scripts/install-pi.sh`, keep the Dinodia core running under systemd and set its MQTT endpoint to `mqtt://127.0.0.1:1883`; do not start the `dinodia` Compose service as well.

The Dinodia app subscribes to `zigbee2mqtt/#` and sends commands to `zigbee2mqtt/<device>/set`. Pairing is available from the dashboard's **Open pairing** button. The selected stable path is persisted in `data/zigbee2mqtt/configuration.yaml`; restart the Zigbee2MQTT profile after changing it so the coordinator process reopens the new device. The Zigbee2MQTT container mounts `/dev` and is privileged solely so a dashboard-selected serial device can be opened without editing Compose files. Zigbee2MQTT bridge metadata and state keys are retained internally; after pairing, one device-level area/label assignment creates only safe household control surfaces.

### Matter and Thread

Matter Server is available as an optional host-networked service:

```bash
docker compose --profile matter up -d
```

Thread requires a separate RCP radio and OTBR. Set `THREAD_RCP_DEVICE` and `OT_INFRA_IF` in `.env`, enable IPv6/IP forwarding on the Pi, then run:

```bash
docker compose --profile thread up -d
```

The official OTBR Docker setup uses the production `openthread/border-router` image, host networking, `/dev/net/tun`, and an RCP device URL. Matter Server is configured on port `5580` with its WebSocket API at `/ws`. When the Thread profile is enabled, the Pi runs OTBR over Ethernet using the selected OpenThread RCP and acts as the Matter-over-Thread Border Router.

### Cloudflare Tunnel (Docker deployment)

The Dinodia container includes the ARM64-compatible `cloudflared` binary. Production tunnel creation is performed by the paired setup workflow using the Platform-reserved company-domain credential. Do not paste arbitrary Cloudflare tokens or expose a reusable dashboard credential in `.env`.

```bash
docker compose up -d --build
```

The dashboard quick-link and named-tunnel controls run inside the Dinodia container, so there is no second Cloudflare service to coordinate. The token is passed to `cloudflared` through `TUNNEL_TOKEN` and is never placed in the command line.

Do not expose MQTT, Matter Server, or OTBR directly to the internet. Cloudflare should be the only remote entry point, and production access remains session-based through Company Portal.

## API

Dashboard endpoints use `/_dinodia/admin/api/...` on the unified `8123` origin and require a short-lived, workflow-bound Company Portal operator session in production. Native app routes use short-lived scoped app tokens or persisted offline-LAN authorizations. The HA-compatible `/api/...` surface and Hub Agent listener are isolated compatibility surfaces; production does not accept dashboard passwords, HA passwords, bootstrap secrets or development tokens.

The initial setup API is:

- `GET/POST /api/areas`, `PUT/DELETE /api/areas/:id`
- `GET/POST /api/labels`, `PUT/DELETE /api/labels/:id`
- `GET/PUT /_dinodia/admin/api/devices/:id/setup` for the single device-level name, area and label setup/preview
- `GET /_dinodia/admin/api/devices/:id/capabilities` for separated household controls and diagnostics
- `DELETE /_dinodia/admin/api/devices/:id` to remove a paired household device
- `POST /api/integrations/zigbee/permit-join` to open Zigbee pairing
- `GET /_dinodia/admin/api/integrations/hive` for sanitized Hive account status
- `GET /_dinodia/admin/api/integrations/google-nest` for sanitized Google Nest Sandbox status. The Google Nest tab opens Google's official browser consent flow and never asks Dinodia OS for a Google password.
- `POST /_dinodia/admin/api/integrations/hive/connect` and `POST /_dinodia/admin/api/integrations/hive/sessions/:id/mfa` for the owner/MFA setup flow
- `POST /_dinodia/admin/api/integrations/hive/refresh`, `POST /_dinodia/admin/api/integrations/hive/reauthenticate`, and `DELETE /_dinodia/admin/api/integrations/hive/account` for lifecycle management
- `GET/POST /api/integrations/cloudflare` for status, a temporary link, a named tunnel, or disconnect
- `GET /api/provisioning` for the serial, compatibility URLs, pairing status, and first-boot copy-ready values
- `POST /api/provisioning/pair` is retired in production; provisioning is completed through the paired Company Portal handoff and outbound hub challenge
- `GET /_dinodia/admin/api/activity` for the authenticated six-column activity ledger; use `deviceId`, `category`, `severity`, and cursor pagination to filter it

The unchanged Home Assistant-compatible surface is available on ports `8123` and `8099`, including `/api/states`, `/api/services/<domain>/<service>`, `/api/template`, `/api/websocket`, registries, ZHA compatibility routes, and config flows.

```bash
curl http://127.0.0.1:8123/api/health
Use the authenticated Company Portal operator session for dashboard requests; production does not accept `DINODIA_ADMIN_TOKEN`.
```

Create a virtual device:

```bash
curl -X POST http://127.0.0.1:8123/_dinodia/admin/api/devices \
  -H "Authorization: Bearer <short-lived-operator-session>" \
  -H 'content-type: application/json' \
  -d '{"id":"hall-switch","name":"Hall switch","protocol":"virtual","state":{"power":"OFF"}}'
```

Send a device command:

```bash
curl -X POST http://127.0.0.1:8123/_dinodia/admin/api/devices/hall-switch/command \
  -H "Authorization: Bearer <short-lived-operator-session>" \
  -H 'content-type: application/json' \
  -d '{"state":{"power":"ON"}}'
```

## Backups and recovery

The data file is written atomically to `DINODIA_DATA_DIR/dinodia.json`. Create a versioned, AES-256-GCM encrypted backup with:

```bash
npm run backup
```

Backups are kept in `DINODIA_DATA_DIR/backups` as `.backup.json` envelopes. The matching `machine.key` is required to restore them; keep that key in a separate protected recovery location. Stop the service, then restore explicitly:

```bash
node scripts/restore.js /var/lib/dinodia-os/backups/dinodia-<timestamp>.backup.json --confirm
sudo systemctl restart dinodia-os
```

## Initial setup model

- **Areas/rooms** are provisioned from Company Portal/Home Support and shown read-only in Dinodia OS.
- **Labels** are fixed to `Light`, `Boiler`, `Radiator`, and `Tenant Device`; one label is assigned to the physical device.
- **Names** are assigned once at the physical-device setup card; generated control-surface names are derived from endpoint/gang identity.
- **Household surfaces** contain only safe controls. Raw converter exposes and Matter attributes remain internal diagnostics and are never shown as ordinary app tiles.
- **Zigbee** is currently Zigbee2MQTT/MQTT-based. The Home Assistant dongle is coordinator hardware; this appliance does not run the Home Assistant ZHA integration.

## Testing

```bash
npm test
npm run check
```

The tests cover persistence, automation matching, authentication, health, virtual device commands, HA REST/WebSocket compatibility, platform HMAC pairing/token publication, registry updates, live activity, bounded incident escalation/recovery, and API route behaviour. Hardware certification still requires the physical Zigbee coordinator, Thread RCP and Matter test devices from the Notion bill of materials, plus real Cloudflare/platform/iOS validation. Only critical incidents and their resolutions leave the hub; routine activity remains local.

## Deliberately deferred

The appliance does not bundle a large UI framework, a database server, or a custom Zigbee radio stack. That keeps Pi 4 deployment and recovery straightforward while the compatibility core supplies the fixed Dinodia client contract. NVMe storage, UPS support, fleet management and additional protocol adapters can be added after the local hub passes physical protocol tests.
