#!/usr/bin/env bash
set -euo pipefail

APP_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${DINODIA_INSTALL_DIR:-/opt/dinodia-os}"
DATA_DIR="${DINODIA_DATA_DIR:-/var/lib/dinodia-os}"
IDENTITY_DIR="${DINODIA_IDENTITY_DIR:-/etc/dinodia-os/identity}"
IDENTITY_SOCKET="${DINODIA_IDENTITY_SOCKET:-/run/dinodia-identityd.sock}"
SERVICE_FILE="/etc/systemd/system/dinodia-os.service"
IDENTITY_SERVICE_FILE="/etc/systemd/system/dinodia-identityd.service"
INSTALL_USER="${SUDO_USER:-${USER:-dinodia}}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer with sudo, for example: sudo bash scripts/install-pi.sh"
  exit 1
fi

if ! id "$INSTALL_USER" >/dev/null 2>&1; then
  echo "Install user '$INSTALL_USER' does not exist. Set SUDO_USER or create the user, then rerun."
  exit 1
fi

if [[ "$(uname -m)" != "aarch64" && "$(uname -m)" != "armv7l" ]]; then
  echo "Warning: this installer is intended for Raspberry Pi ARM systems; continuing on $(uname -m)."
fi

memory_mb="$(awk '/MemTotal:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)"
if [[ "$memory_mb" -gt 0 && "$memory_mb" -lt 1500 ]]; then
  echo "Warning: detected ${memory_mb} MB RAM. Dinodia OS is supported on the Raspberry Pi 4 2 GB model; optional Matter/Thread containers may need to remain disabled."
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]]; then
  echo "Node.js 18 or newer is required. Install Node.js first, then rerun this script."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required for the isolated Hive adapter. Installing Python and venv support..."
  apt-get update
  apt-get install -y python3 python3-venv
fi
python_version="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "Python $python_version is too old for the pinned Hive adapter; Python 3.10 or newer is required."
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$DATA_DIR"
install_gid="$(id -g "$INSTALL_USER")"
cp -R "$APP_SOURCE/src" "$APP_SOURCE/public" "$APP_SOURCE/scripts" "$APP_SOURCE/docker" "$APP_SOURCE/systemd" "$APP_SOURCE/docs" "$APP_SOURCE/Dockerfile" "$APP_SOURCE/docker-compose.yml" "$APP_SOURCE/package.json" "$APP_SOURCE/package-lock.json" "$APP_SOURCE/.env.example" "$APP_SOURCE/requirements-hive.in" "$APP_SOURCE/requirements-hive.lock" "$APP_SOURCE/THIRD_PARTY_NOTICES.md" "$INSTALL_DIR/"
chown -R "$INSTALL_USER":"$INSTALL_USER" "$INSTALL_DIR" "$DATA_DIR"
cd "$INSTALL_DIR"
runuser -u "$INSTALL_USER" -- npm ci --omit=dev
test -s "$INSTALL_DIR/src/generated/matterCatalog.json"
runuser -u "$INSTALL_USER" -- node -e 'const c=require("./src/generated/matterCatalog.json"); if(c.schemaVersion!==1||!c.clusters||!c.deviceTypes) process.exit(1);'
if [[ ! -x "$INSTALL_DIR/.venv-hive/bin/python" ]]; then
  runuser -u "$INSTALL_USER" -- python3 -m venv "$INSTALL_DIR/.venv-hive"
fi
runuser -u "$INSTALL_USER" -- "$INSTALL_DIR/.venv-hive/bin/python" -m pip install --disable-pip-version-check --require-hashes -r "$INSTALL_DIR/requirements-hive.lock"
runuser -u "$INSTALL_USER" -- "$INSTALL_DIR/.venv-hive/bin/python" -c 'from apyhiveapi import Hive; print("Hive adapter ready")'
chmod 0555 "$INSTALL_DIR/src/integrations/hive/python"/*.py

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  cp "$APP_SOURCE/.env.example" "$INSTALL_DIR/.env"
  sed -i "s#^DINODIA_DATA_DIR=.*#DINODIA_DATA_DIR=$DATA_DIR#" "$INSTALL_DIR/.env"
  # The native service is the compatibility core; leave container-only
  # protocol endpoints disabled until the operator manages them separately.
  sed -i 's#^MQTT_URL=.*#MQTT_URL=#' "$INSTALL_DIR/.env"
  sed -i 's#^MATTER_SERVER_URL=.*#MATTER_SERVER_URL=#' "$INSTALL_DIR/.env"
  sed -i 's#^OTBR_URL=.*#OTBR_URL=#' "$INSTALL_DIR/.env"
  chown "$INSTALL_USER":"$INSTALL_USER" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  echo "Created $INSTALL_DIR/.env. Production access is session-based; no reusable dashboard or HA password is generated."
fi

# systemd EnvironmentFile and Docker Compose both require one assignment per
# physical line. PEM values must therefore use literal \\n separators (the runtime decodes them), never pasted multi-line PEM text.
if ! awk '
  /^[[:space:]]*#/ || /^[[:space:]]*$/ || /^[A-Za-z_][A-Za-z0-9_]*=/ { next }
  { print NR ":" $0; invalid = 1 }
  END { exit invalid ? 1 : 0 }
' "$INSTALL_DIR/.env"; then
  echo "Invalid $INSTALL_DIR/.env: every setting must be one KEY=VALUE line; encode PEM newlines as literal \\n sequences. No service was started."
  exit 78
fi

if ! grep -Eq '^NODE_ENV=production$' "$INSTALL_DIR/.env"; then
  echo "Invalid $INSTALL_DIR/.env: NODE_ENV=production is required for the candidate."
  exit 78
fi
if ! grep -Eq '^DINODIA_PLATFORM_API_URL=https://dinodia-platform-v2\\.vercel\\.app/?$' "$INSTALL_DIR/.env"; then
  echo "Invalid $INSTALL_DIR/.env: DINODIA_PLATFORM_API_URL must be the canonical V2 origin."
  exit 78
fi
for forbidden in DINODIA_ADMIN_TOKEN DINODIA_HA_TOKEN DINODIA_PLATFORM_TOKEN DINODIA_PLATFORM_BOOTSTRAP_SECRET; do
  if grep -Eq "^${forbidden}=" "$INSTALL_DIR/.env"; then
    echo "Invalid $INSTALL_DIR/.env: legacy credential setting ${forbidden} must be removed."
    exit 78
  fi
done
for required_native in DINODIA_APP_PUBLIC_KEYS DINODIA_OPERATOR_PUBLIC_KEY DINODIA_MANUFACTURING_ROOT_PUBLIC_KEYS; do
  if ! grep -Eq "^${required_native}=.+$" "$INSTALL_DIR/.env"; then
    echo "Invalid $INSTALL_DIR/.env: ${required_native} is required before Native V2 startup."
    exit 78
  fi
done

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  mkdir -p "$DATA_DIR/mosquitto" "$DATA_DIR/mosquitto-log" "$DATA_DIR/zigbee2mqtt" "$DATA_DIR/matter" "$DATA_DIR/otbr"
  if grep -q '^MQTT_URL=$' "$INSTALL_DIR/.env"; then
    sed -i 's#^MQTT_URL=.*#MQTT_URL=mqtt://127.0.0.1:1883#' "$INSTALL_DIR/.env"
  fi
  chown -R "$INSTALL_USER":"$INSTALL_USER" "$DATA_DIR"
  echo "Starting only the pinned local MQTT broker. Zigbee2MQTT will start after a coordinator is selected in the dashboard."
  runuser -u "$INSTALL_USER" -- docker compose --project-directory "$INSTALL_DIR" --env-file "$INSTALL_DIR/.env" up -d mosquitto || echo "Warning: MQTT broker could not be started; optional Zigbee setup remains disabled."
else
  echo "Docker Compose is not available; install it before enabling Zigbee2MQTT, Matter Server, or OTBR."
fi

service_tmp="$(mktemp /tmp/dinodia-os.service.XXXXXX)"
sed \
  -e "s#@INSTALL_USER@#$INSTALL_USER#g" \
  -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" \
  -e "s#@DATA_DIR@#$DATA_DIR#g" \
  -e "s#@IDENTITY_DIR@#$IDENTITY_DIR#g" \
  -e "s#@IDENTITY_SOCKET@#$IDENTITY_SOCKET#g" \
  -e "s#@INSTALL_GID@#$install_gid#g" \
  -e "s#@NODE_BIN@#$(command -v node)#g" \
  "$APP_SOURCE/systemd/dinodia-os.service" > "$service_tmp"
install -o root -g root -m 0644 "$service_tmp" "$SERVICE_FILE"
rm -f "$service_tmp"

identity_service_tmp="$(mktemp /tmp/dinodia-identityd.service.XXXXXX)"
sed \
  -e "s#@IDENTITY_DIR@#$IDENTITY_DIR#g" \
  -e "s#@IDENTITY_SOCKET@#$IDENTITY_SOCKET#g" \
  -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" \
  -e "s#@INSTALL_GID@#$install_gid#g" \
  -e "s#@NODE_BIN@#$(command -v node)#g" \
  "$APP_SOURCE/systemd/dinodia-identityd.service" > "$identity_service_tmp"
install -o root -g root -m 0644 "$identity_service_tmp" "$IDENTITY_SERVICE_FILE"
rm -f "$identity_service_tmp"
install -d -o root -g root -m 0700 "$IDENTITY_DIR"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Installing cloudflared for the first-run Cloudflare setup..."
  apt-get update
  apt-get install -y ca-certificates curl
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
  apt-get update
  apt-get install -y cloudflared
fi
echo "cloudflared: $(cloudflared --version | head -1)"
systemctl daemon-reload
if [[ ! -f "$IDENTITY_DIR/identity.json" ]]; then
  echo "No manufacturing identity is installed. Run phase 1: sudo node $INSTALL_DIR/scripts/prepare-identity.js <DINODIA-SERIAL>"
  echo "Have the offline manufacturing authority sign the printed certificatePayload, then run phase 2: sudo node $INSTALL_DIR/scripts/finalize-identity.js <SIGNATURE_FILE> <ROOT_PUBLIC_KEY_FILE>"
  echo "The Dinodia OS runtime is intentionally not started until trusted identity imaging is complete."
  systemctl disable --now dinodia-os >/dev/null 2>&1 || true
  exit 1
fi
systemctl enable --now dinodia-identityd
systemctl enable --now dinodia-os
echo "Dinodia OS dashboard + Home Assistant compatibility: http://$(hostname -I | awk '{print $1}'):8123"
echo "Dinodia local Hub Agent: http://$(hostname -I | awk '{print $1}'):8099"
