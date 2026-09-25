#!/usr/bin/env bash
set -Eeuo pipefail

# Native V2 installer. All validation and dependency installation happen in a
# versioned release directory before the active /opt/dinodia-os path changes.
# The active path is a symlink so a failed service start can be rolled back to
# the exact previous release without restarting a partially copied tree.
APP_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${DINODIA_INSTALL_DIR:-/opt/dinodia-os}"
RELEASE_ROOT="${DINODIA_RELEASE_ROOT:-/opt/dinodia-os-releases}"
DATA_DIR="${DINODIA_DATA_DIR:-/var/lib/dinodia-os}"
IDENTITY_DIR="${DINODIA_IDENTITY_DIR:-/etc/dinodia-os/identity}"
IDENTITY_SOCKET="${DINODIA_IDENTITY_SOCKET:-/run/dinodia-identityd.sock}"
SERVICE_FILE="/etc/systemd/system/dinodia-os.service"
IDENTITY_SERVICE_FILE="/etc/systemd/system/dinodia-identityd.service"
INSTALL_USER="${SUDO_USER:-${USER:-dinodia}}"
CURRENT_ENV="${DINODIA_ENV_FILE:-$INSTALL_DIR/.env}"
STAGE_DIR=""
OLD_RELEASE=""
SWITCHED=0
COMPLETED=0
OLD_OS_UNIT_PRESENT=0
OLD_IDENTITY_UNIT_PRESENT=0
BACKUP_DIR=""

die() { echo "Installer stopped: $*" >&2; exit 1; }

if [[ "$(id -u)" -ne 0 ]]; then
  die "run this installer with sudo, for example: sudo bash scripts/install-pi.sh"
fi
if ! id "$INSTALL_USER" >/dev/null 2>&1; then die "install user '$INSTALL_USER' does not exist"; fi
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]]; then die "Node.js 18 or newer is required"; fi
if ! command -v python3 >/dev/null 2>&1; then
  apt-get update
  apt-get install -y python3 python3-venv
fi
if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then die "Python 3.10 or newer is required"; fi

[[ -f "$CURRENT_ENV" ]] || die "the existing production environment file is missing at $CURRENT_ENV; refusing to invent production credentials"
[[ -d "$IDENTITY_DIR" ]] || die "the enrolled identity directory is missing at $IDENTITY_DIR"
[[ -f "$IDENTITY_DIR/identity.json" ]] || die "the enrolled identity file is missing at $IDENTITY_DIR/identity.json"
identity_mode="$(stat -c '%a' "$IDENTITY_DIR")"
identity_owner="$(stat -c '%U:%G' "$IDENTITY_DIR")"
[[ "$identity_mode" == "700" && "$identity_owner" == "root:root" ]] || die "identity directory must be root:root mode 700 (found $identity_owner mode $identity_mode)"

candidate_files=(src public scripts docker systemd docs Dockerfile docker-compose.yml package.json package-lock.json .env.example requirements-hive.in requirements-hive.lock THIRD_PARTY_NOTICES.md)
for relative in "${candidate_files[@]}"; do [[ -e "$APP_SOURCE/$relative" ]] || die "candidate is missing $relative"; done

# This validator parses physical dotenv assignments and compares the URL as a
# value. It rejects Preview/old/fallback origins and malformed multiline PEMs.
BUILD_ID="$(node "$APP_SOURCE/scripts/install_pi_preflight.mjs" --source "$APP_SOURCE" --env "$CURRENT_ENV" --identity "$IDENTITY_DIR" --print-build-id)"
[[ "$BUILD_ID" =~ ^native-v2-[a-f0-9]{24}$ ]] || die "candidate build identity is invalid"

install_gid="$(id -g "$INSTALL_USER")"
mkdir -p "$RELEASE_ROOT" "$DATA_DIR"
STAGE_DIR="$RELEASE_ROOT/.staging-${BUILD_ID}-${BASHPID}"
RELEASE_DIR="$RELEASE_ROOT/$BUILD_ID"
[[ ! -e "$RELEASE_DIR" && ! -e "$STAGE_DIR" ]] || die "release identity already exists; review the existing candidate before retrying"
mkdir "$STAGE_DIR"

cleanup_failed_install() {
  if [[ "$COMPLETED" -eq 1 ]]; then
    rm -rf -- "$STAGE_DIR" 2>/dev/null || true
    return
  fi
  if [[ "$SWITCHED" -eq 1 ]]; then
    systemctl stop dinodia-os dinodia-identityd >/dev/null 2>&1 || true
    rm -f -- "$INSTALL_DIR"
    if [[ -n "$OLD_RELEASE" && -e "$OLD_RELEASE" ]]; then mv -- "$OLD_RELEASE" "$INSTALL_DIR"; fi
    if [[ "$OLD_OS_UNIT_PRESENT" -eq 1 && -f "$BACKUP_DIR/dinodia-os.service" ]]; then install -o root -g root -m 0644 "$BACKUP_DIR/dinodia-os.service" "$SERVICE_FILE"; else rm -f "$SERVICE_FILE"; fi
    if [[ "$OLD_IDENTITY_UNIT_PRESENT" -eq 1 && -f "$BACKUP_DIR/dinodia-identityd.service" ]]; then install -o root -g root -m 0644 "$BACKUP_DIR/dinodia-identityd.service" "$IDENTITY_SERVICE_FILE"; else rm -f "$IDENTITY_SERVICE_FILE"; fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable --now dinodia-identityd >/dev/null 2>&1 || true
    systemctl enable --now dinodia-os >/dev/null 2>&1 || true
    echo "The candidate failed after the release switch; the previous release was restored." >&2
  elif [[ -n "${RELEASE_DIR:-}" && -e "$RELEASE_DIR" ]]; then
    # A copy/install failure before the switch must not strand a partial
    # release identity that blocks a later guarded retry.
    rm -rf -- "$RELEASE_DIR" 2>/dev/null || true
  fi
  rm -rf -- "$STAGE_DIR" 2>/dev/null || true
}
trap cleanup_failed_install EXIT

cp -a "${candidate_files[@]/#/$APP_SOURCE/}" "$STAGE_DIR/"
install -o "$INSTALL_USER" -g "$INSTALL_USER" -m 0600 "$CURRENT_ENV" "$STAGE_DIR/.env"

# Put the immutable build identity into the staged environment without
# printing any existing secret values. A same-directory rename keeps the file
# valid for systemd and Docker Compose throughout the transition.
node - "$STAGE_DIR/.env" "$BUILD_ID" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const buildId = process.argv[3];
const lines = fs.readFileSync(path, "utf8").split(/\r?\n/).filter((line) => !/^DINODIA_BUILD_ID=/.test(line));
lines.push(`DINODIA_BUILD_ID=${buildId}`);
const temporary = `${path}.tmp`;
fs.writeFileSync(temporary, `${lines.filter(Boolean).join("\n")}\n`, { mode: 0o600 });
fs.renameSync(temporary, path);
NODE
chown "$INSTALL_USER":"$INSTALL_USER" "$STAGE_DIR/.env"
chmod 0600 "$STAGE_DIR/.env"
printf '{"buildId":"%s","packageVersion":%s,"mode":"native-v2"}\n' "$BUILD_ID" "$(node -p 'JSON.stringify(require(process.argv[1]).version)' "$STAGE_DIR/package.json")" > "$STAGE_DIR/BUILD.json"
chown "$INSTALL_USER":"$INSTALL_USER" "$STAGE_DIR/BUILD.json"
chmod 0644 "$STAGE_DIR/BUILD.json"

runuser -u "$INSTALL_USER" -- npm --prefix "$STAGE_DIR" ci --omit=dev
test -s "$STAGE_DIR/src/generated/matterCatalog.json"
runuser -u "$INSTALL_USER" -- node -e 'const c=require(process.argv[1]); if(c.schemaVersion!==1||!c.clusters||!c.deviceTypes) process.exit(1)' "$STAGE_DIR/src/generated/matterCatalog.json"
if [[ ! -x "$STAGE_DIR/.venv-hive/bin/python" ]]; then runuser -u "$INSTALL_USER" -- python3 -m venv "$STAGE_DIR/.venv-hive"; fi
runuser -u "$INSTALL_USER" -- "$STAGE_DIR/.venv-hive/bin/python" -m pip install --disable-pip-version-check --require-hashes -r "$STAGE_DIR/requirements-hive.lock"
runuser -u "$INSTALL_USER" -- "$STAGE_DIR/.venv-hive/bin/python" -c 'from apyhiveapi import Hive; print("Hive adapter ready")'
chmod 0555 "$STAGE_DIR/src/integrations/hive/python"/*.py

# Validate the staged candidate again before any active path or service unit
# changes. This catches an accidental copy/formatting defect in the staged env.
STAGED_BUILD_ID="$(node "$STAGE_DIR/scripts/install_pi_preflight.mjs" --source "$STAGE_DIR" --env "$STAGE_DIR/.env" --identity "$IDENTITY_DIR" --print-build-id)"
[[ "$STAGED_BUILD_ID" == "$BUILD_ID" ]] || die "staged candidate fingerprint changed unexpectedly"

if command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared: $(cloudflared --version | head -1)"
else
  echo "Warning: cloudflared is not installed; install it before enabling the Cloudflare tunnel." >&2
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/var/backups/dinodia-os-pre-native-v2-${timestamp}"
mkdir -p "$BACKUP_DIR"
if [[ -e "$SERVICE_FILE" ]]; then cp -p "$SERVICE_FILE" "$BACKUP_DIR/dinodia-os.service"; OLD_OS_UNIT_PRESENT=1; fi
if [[ -e "$IDENTITY_SERVICE_FILE" ]]; then cp -p "$IDENTITY_SERVICE_FILE" "$BACKUP_DIR/dinodia-identityd.service"; OLD_IDENTITY_UNIT_PRESENT=1; fi
if [[ -d "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then
  current_real="$(readlink -f "$INSTALL_DIR")"
  tar --exclude='*/.env*' --exclude='*/node_modules' --exclude='*/.venv-hive' -czf "$BACKUP_DIR/application.tar.gz" -C "$current_real" .
  cp -p "$current_real/package.json" "$BACKUP_DIR/package.json" 2>/dev/null || true
fi

cp -a "$STAGE_DIR" "$RELEASE_DIR"
rm -rf -- "$STAGE_DIR"
STAGE_DIR=""

systemctl stop dinodia-os dinodia-identityd >/dev/null 2>&1 || true
OLD_RELEASE="$RELEASE_ROOT/previous-${timestamp}-${BASHPID}"
if [[ -e "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then mv -- "$INSTALL_DIR" "$OLD_RELEASE"; fi
ln -s "$RELEASE_DIR" "$INSTALL_DIR"
SWITCHED=1

service_tmp="$(mktemp /tmp/dinodia-os.service.XXXXXX)"
sed -e "s#@INSTALL_USER@#$INSTALL_USER#g" -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" -e "s#@DATA_DIR@#$DATA_DIR#g" -e "s#@IDENTITY_DIR@#$IDENTITY_DIR#g" -e "s#@IDENTITY_SOCKET@#$IDENTITY_SOCKET#g" -e "s#@INSTALL_GID@#$install_gid#g" -e "s#@NODE_BIN@#$(command -v node)#g" "$RELEASE_DIR/systemd/dinodia-os.service" > "$service_tmp"
install -o root -g root -m 0644 "$service_tmp" "$SERVICE_FILE"
rm -f "$service_tmp"
identity_service_tmp="$(mktemp /tmp/dinodia-identityd.service.XXXXXX)"
sed -e "s#@IDENTITY_DIR@#$IDENTITY_DIR#g" -e "s#@IDENTITY_SOCKET@#$IDENTITY_SOCKET#g" -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" -e "s#@INSTALL_GID@#$install_gid#g" -e "s#@NODE_BIN@#$(command -v node)#g" "$RELEASE_DIR/systemd/dinodia-identityd.service" > "$identity_service_tmp"
install -o root -g root -m 0644 "$identity_service_tmp" "$IDENTITY_SERVICE_FILE"
rm -f "$identity_service_tmp"
install -d -o root -g root -m 0700 "$IDENTITY_DIR"
systemctl daemon-reload

if ! systemctl enable --now dinodia-identityd || ! systemctl enable --now dinodia-os; then die "candidate service failed to start"; fi

health_ok=0
for attempt in $(seq 1 30); do
  health="$(curl --silent --show-error --fail --max-time 3 http://127.0.0.1:8123/api/health 2>/dev/null || true)"
  if node - "$health" "$BUILD_ID" <<'NODE'
const body = JSON.parse(process.argv[2] || "{}");
if (body.ok !== true || body.mode !== "native-v2" || body.buildId !== process.argv[3]) process.exit(1);
NODE
  then health_ok=1; break; fi
  sleep 1
done
if [[ "$health_ok" -ne 1 ]]; then die "candidate health did not report the expected native-v2 build; rollback will restore the prior release"; fi

COMPLETED=1
echo "Native V2 installed: build=$BUILD_ID release=$RELEASE_DIR backup=$BACKUP_DIR"
echo "Health verified: mode=native-v2 build=$BUILD_ID"
