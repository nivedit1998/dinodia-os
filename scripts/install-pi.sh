#!/usr/bin/env bash
set -Eeuo pipefail

# Native V2 installer. All validation and dependency installation happen in a
# versioned release directory before the active /opt/dinodia-os path changes.
# A failed switch may reactivate only a predecessor explicitly marked as a
# native-only recovery target. Legacy HA-compatible releases stay preserved
# but inactive; failure remains unavailable for a reviewed forward-fix.
APP_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${DINODIA_INSTALL_DIR:-/opt/dinodia-os}"
RELEASE_ROOT="${DINODIA_RELEASE_ROOT:-/opt/dinodia-os-releases}"
DISCOVERY_RELEASE_ROOT="/usr/local/lib/dinodia-setup-discovery-releases"
DISCOVERY_CURRENT_LINK="/usr/local/lib/dinodia-setup-discovery-current"
DATA_DIR="${DINODIA_DATA_DIR:-/var/lib/dinodia-os}"
IDENTITY_DIR="${DINODIA_IDENTITY_DIR:-/etc/dinodia-os/identity}"
IDENTITY_SOCKET="${DINODIA_IDENTITY_SOCKET:-/run/dinodia-identityd.sock}"
SERVICE_FILE="/etc/systemd/system/dinodia-os.service"
IDENTITY_SERVICE_FILE="/etc/systemd/system/dinodia-identityd.service"
DISCOVERY_SERVICE_FILE="/etc/systemd/system/dinodia-setup-discovery-sync.service"
DISCOVERY_TIMER_FILE="/etc/systemd/system/dinodia-setup-discovery-sync.timer"
AVAHI_CONFIG="/etc/avahi/avahi-daemon.conf"
INSTALL_USER="${SUDO_USER:-${USER:-dinodia}}"
CURRENT_ENV="${DINODIA_ENV_FILE:-$INSTALL_DIR/.env}"
HIVE_WHEELHOUSE_SOURCE="${DINODIA_HIVE_WHEELHOUSE:-}"
STAGE_DIR=""
HIVE_WHEELHOUSE_STAGE=""
OLD_RELEASE=""
OLD_RELEASE_ROLLBACK_SAFE=0
OLD_RELEASE_KNOWN_UNHEALTHY=0
FAIL_CLOSED_CANDIDATE=0
SWITCHED=0
SERVICES_STOPPED=0
COMPLETED=0
OLD_OS_UNIT_PRESENT=0
OLD_IDENTITY_UNIT_PRESENT=0
OLD_DISCOVERY_SERVICE_PRESENT=0
OLD_DISCOVERY_TIMER_PRESENT=0
OLD_DISCOVERY_TIMER_ENABLED=0
OLD_DISCOVERY_TIMER_ACTIVE=0
OLD_DISCOVERY_LINK_PRESENT=0
OLD_DISCOVERY_LINK_TARGET=""
DISCOVERY_LINK_SWITCHED=0
AVAHI_CONFIG_CHANGED=0
OLD_AVAHI_CONFIG_PRESENT=0
AVAHI_SETUP_ADDRESS=""
AVAHI_CONFIG_CANDIDATE=""
AVAHI_CONFIG_ATOMIC_TMP=""
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

# A disconnected/filtered Pi network can make a fresh venv unable to reach
# PyPI even when the currently installed venv has every locked package cached.
# An optional, separately transferred wheelhouse is accepted only as a flat
# directory of exactly one wheel per locked requirement. pip still enforces
# every lock hash, and the offline path never consults an index or builds sdist.
if [[ -n "$HIVE_WHEELHOUSE_SOURCE" ]]; then
  [[ -d "$HIVE_WHEELHOUSE_SOURCE" && ! -L "$HIVE_WHEELHOUSE_SOURCE" ]] || die "the optional Hive wheelhouse must be an existing real directory"
  HIVE_WHEELHOUSE_SOURCE="$(realpath -e -- "$HIVE_WHEELHOUSE_SOURCE")"
  invalid_wheelhouse_entry="$(find "$HIVE_WHEELHOUSE_SOURCE" -mindepth 1 -maxdepth 1 \( ! -type f -o ! -name '*.whl' \) -print -quit)"
  [[ -z "$invalid_wheelhouse_entry" ]] || die "the Hive wheelhouse may contain only top-level wheel files"
  expected_wheel_count="$(grep -Ec '^[A-Za-z0-9][A-Za-z0-9_.-]*==[^[:space:]]+' "$APP_SOURCE/requirements-hive.lock")"
  actual_wheel_count="$(find "$HIVE_WHEELHOUSE_SOURCE" -mindepth 1 -maxdepth 1 -type f -name '*.whl' -printf '.' | wc -c | tr -d '[:space:]')"
  [[ "$actual_wheel_count" == "$expected_wheel_count" ]] || die "the Hive wheelhouse wheel count does not match the locked requirement count"
fi

# This validator parses physical dotenv assignments and compares the URL as a
# value. It rejects Preview/old/fallback origins and malformed multiline PEMs.
BUILD_ID="$(node "$APP_SOURCE/scripts/install_pi_preflight.mjs" --source "$APP_SOURCE" --env "$CURRENT_ENV" --identity "$IDENTITY_DIR" --print-build-id)"
[[ "$BUILD_ID" =~ ^native-v2-[a-f0-9]{24}$ ]] || die "candidate build identity is invalid"
DISCOVERY_RELEASE_DIR="$DISCOVERY_RELEASE_ROOT/$BUILD_ID"
[[ ! -e "$DISCOVERY_RELEASE_DIR" ]] || die "privileged discovery helper build identity already exists; review the existing release before retrying"
if [[ -L "$DISCOVERY_CURRENT_LINK" ]]; then
  OLD_DISCOVERY_LINK_TARGET="$(readlink -f -- "$DISCOVERY_CURRENT_LINK")"
  [[ -n "$OLD_DISCOVERY_LINK_TARGET" && "$OLD_DISCOVERY_LINK_TARGET" == "$DISCOVERY_RELEASE_ROOT/"* && -d "$OLD_DISCOVERY_LINK_TARGET" ]] || die "existing privileged discovery helper pointer is outside the approved release root"
  OLD_DISCOVERY_LINK_PRESENT=1
elif [[ -e "$DISCOVERY_CURRENT_LINK" ]]; then
  die "privileged discovery helper pointer is not an approved symlink"
fi

# Both publishers use supported positional CLI syntax. Avahi's daemon-level
# allow-interfaces setting confines publication to the selected private LAN.
if ! command -v avahi-publish-address >/dev/null 2>&1 || ! command -v avahi-publish-service >/dev/null 2>&1 || ! command -v avahi-resolve-host-name >/dev/null 2>&1 || ! command -v avahi-daemon >/dev/null 2>&1; then
  apt-get update
  apt-get install -y avahi-daemon avahi-utils
fi
command -v avahi-publish-address >/dev/null 2>&1 || die "avahi-publish-address is required for locked-setup discovery"
command -v avahi-publish-service >/dev/null 2>&1 || die "avahi-publish-service is required for locked-setup discovery"
command -v avahi-resolve-host-name >/dev/null 2>&1 || die "avahi-resolve-host-name is required for locked-setup discovery"
command -v avahi-daemon >/dev/null 2>&1 || die "avahi-daemon is required for locked-setup discovery"
address_publisher_help="$(avahi-publish-address --help 2>&1 || true)"
[[ "$address_publisher_help" == *"--no-reverse"* ]] || die "avahi-publish-address must support --no-reverse to avoid colliding with the hub's existing reverse record"

install_gid="$(id -g "$INSTALL_USER")"
mkdir -p "$RELEASE_ROOT" "$DATA_DIR"
STAGE_DIR="$RELEASE_ROOT/.staging-${BUILD_ID}-${BASHPID}"
RELEASE_DIR="$RELEASE_ROOT/$BUILD_ID"
[[ ! -e "$RELEASE_DIR" && ! -e "$STAGE_DIR" ]] || die "release identity already exists; review the existing candidate before retrying"
PREVIOUS_RELEASE_CLASSIFICATION="unsafe"
if [[ -f "$INSTALL_DIR/BUILD.json" ]]; then
  PREVIOUS_RELEASE_CLASSIFICATION="$(node "$APP_SOURCE/scripts/native-rollback-policy.js" --manifest "$INSTALL_DIR/BUILD.json")"
fi
if [[ "$PREVIOUS_RELEASE_CLASSIFICATION" == "native-only" ]]; then
  OLD_RELEASE_ROLLBACK_SAFE=1
elif [[ "$PREVIOUS_RELEASE_CLASSIFICATION" == "known-unhealthy" ]]; then
  OLD_RELEASE_KNOWN_UNHEALTHY=1
fi
if [[ "$OLD_RELEASE_ROLLBACK_SAFE" -eq 1 ]]; then
  echo "Previous release recovery classification: certified healthy native-only"
elif [[ "$OLD_RELEASE_KNOWN_UNHEALTHY" -eq 1 ]]; then
  echo "Previous release recovery classification: known unhealthy; it will remain inactive if this install stops before switching"
else
  echo "Previous release recovery classification: not certified as a healthy native-only recovery target; it will not be reactivated after a failed switch"
fi
mkdir "$STAGE_DIR"

cleanup_failed_install() {
  if [[ "$COMPLETED" -eq 1 ]]; then
    rm -rf -- "$STAGE_DIR" 2>/dev/null || true
    return
  fi
  if [[ "$SWITCHED" -eq 1 ]]; then
    systemctl disable --now dinodia-setup-discovery-sync.timer >/dev/null 2>&1 || true
    systemctl stop dinodia-setup-discovery-sync.service >/dev/null 2>&1 || true
    systemctl stop dinodia-os dinodia-identityd >/dev/null 2>&1 || true
    if [[ "$OLD_RELEASE_ROLLBACK_SAFE" -eq 1 ]]; then
      rm -f -- "$INSTALL_DIR"
      if [[ -n "$OLD_RELEASE" && -e "$OLD_RELEASE" ]]; then mv -- "$OLD_RELEASE" "$INSTALL_DIR"; fi
      if [[ "$OLD_OS_UNIT_PRESENT" -eq 1 && -f "$BACKUP_DIR/dinodia-os.service" ]]; then install -o root -g root -m 0644 "$BACKUP_DIR/dinodia-os.service" "$SERVICE_FILE"; else rm -f "$SERVICE_FILE"; fi
      if [[ "$OLD_IDENTITY_UNIT_PRESENT" -eq 1 && -f "$BACKUP_DIR/dinodia-identityd.service" ]]; then install -o root -g root -m 0644 "$BACKUP_DIR/dinodia-identityd.service" "$IDENTITY_SERVICE_FILE"; else rm -f "$IDENTITY_SERVICE_FILE"; fi
      if [[ "$OLD_DISCOVERY_SERVICE_PRESENT" -eq 1 && -f "$BACKUP_DIR/dinodia-setup-discovery-sync.service" ]]; then install -o root -g root -m 0644 "$BACKUP_DIR/dinodia-setup-discovery-sync.service" "$DISCOVERY_SERVICE_FILE"; else rm -f "$DISCOVERY_SERVICE_FILE"; fi
      if [[ "$OLD_DISCOVERY_TIMER_PRESENT" -eq 1 && -f "$BACKUP_DIR/dinodia-setup-discovery-sync.timer" ]]; then install -o root -g root -m 0644 "$BACKUP_DIR/dinodia-setup-discovery-sync.timer" "$DISCOVERY_TIMER_FILE"; else rm -f "$DISCOVERY_TIMER_FILE"; fi
      if [[ "$DISCOVERY_LINK_SWITCHED" -eq 1 ]]; then
        if [[ "$OLD_DISCOVERY_LINK_PRESENT" -eq 1 && -d "$OLD_DISCOVERY_LINK_TARGET" ]]; then
          discovery_link_tmp="${DISCOVERY_CURRENT_LINK}.rollback-${BASHPID}"
          ln -s -- "$OLD_DISCOVERY_LINK_TARGET" "$discovery_link_tmp"
          mv -Tf -- "$discovery_link_tmp" "$DISCOVERY_CURRENT_LINK"
        else
          rm -f -- "$DISCOVERY_CURRENT_LINK"
        fi
        DISCOVERY_LINK_SWITCHED=0
      fi
      FAIL_CLOSED_CANDIDATE=0
    else
      FAIL_CLOSED_CANDIDATE=1
      systemctl disable --now dinodia-os dinodia-identityd >/dev/null 2>&1 || true
      echo "The candidate failed after the release switch. The previous release is preserved but is not certified as a healthy native-only recovery target, so it remains inactive; native services are stopped for a reviewed forward-fix." >&2
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    if [[ "$FAIL_CLOSED_CANDIDATE" -eq 0 ]]; then
      if [[ "$OLD_DISCOVERY_TIMER_ENABLED" -eq 1 ]]; then systemctl enable dinodia-setup-discovery-sync.timer >/dev/null 2>&1 || true; else systemctl disable dinodia-setup-discovery-sync.timer >/dev/null 2>&1 || true; fi
      if [[ "$OLD_DISCOVERY_TIMER_ACTIVE" -eq 1 ]]; then systemctl start dinodia-setup-discovery-sync.timer >/dev/null 2>&1 || true; else systemctl stop dinodia-setup-discovery-sync.timer >/dev/null 2>&1 || true; fi
    fi
  elif [[ -n "${RELEASE_DIR:-}" && -e "$RELEASE_DIR" ]]; then
    # A copy/install failure before the switch must not strand a partial
    # release identity that blocks a later guarded retry.
    rm -rf -- "$RELEASE_DIR" 2>/dev/null || true
  fi
  if [[ "$AVAHI_CONFIG_CHANGED" -eq 1 && "$FAIL_CLOSED_CANDIDATE" -eq 0 ]]; then
    if [[ "$OLD_AVAHI_CONFIG_PRESENT" -eq 1 && -f "$BACKUP_DIR/avahi-daemon.conf" ]]; then
      install -o root -g root -m 0644 "$BACKUP_DIR/avahi-daemon.conf" "$AVAHI_CONFIG"
    else
      rm -f -- "$AVAHI_CONFIG"
    fi
    systemctl restart avahi-daemon >/dev/null 2>&1 || true
    AVAHI_CONFIG_CHANGED=0
  fi
  if [[ "$SWITCHED" -eq 1 ]]; then
    if [[ "$FAIL_CLOSED_CANDIDATE" -eq 0 ]]; then
      systemctl enable --now dinodia-identityd >/dev/null 2>&1 || true
      systemctl enable --now dinodia-os >/dev/null 2>&1 || true
      echo "The candidate failed after the release switch; the certified healthy native-only previous release was restored." >&2
    else
      echo "The failed candidate remains selected but native services are disabled; forward recovery is required." >&2
    fi
  elif [[ "$SERVICES_STOPPED" -eq 1 ]]; then
    if [[ "$OLD_RELEASE_KNOWN_UNHEALTHY" -eq 1 ]]; then
      systemctl disable --now dinodia-os dinodia-identityd >/dev/null 2>&1 || true
      echo "The previous release is known unhealthy and remains inactive after the pre-switch failure; use a reviewed forward-fix." >&2
    else
      systemctl enable --now dinodia-identityd >/dev/null 2>&1 || true
      systemctl enable --now dinodia-os >/dev/null 2>&1 || true
    fi
  fi
  [[ -z "$AVAHI_CONFIG_CANDIDATE" ]] || rm -f -- "$AVAHI_CONFIG_CANDIDATE"
  [[ -z "$AVAHI_CONFIG_ATOMIC_TMP" ]] || rm -f -- "$AVAHI_CONFIG_ATOMIC_TMP"
  rm -rf -- "$STAGE_DIR" 2>/dev/null || true
}
trap cleanup_failed_install EXIT

cp -a "${candidate_files[@]/#/$APP_SOURCE/}" "$STAGE_DIR/"
install -o "$INSTALL_USER" -g "$INSTALL_USER" -m 0600 "$CURRENT_ENV" "$STAGE_DIR/.env"

# The release dependency install intentionally runs as the service user.  The
# staging directory was created by root, so transfer ownership of only this
# isolated, not-yet-active candidate before npm/venv writes into it.  The
# enrolled identity and active installation remain root-controlled until the
# atomic switch below.
chown -R "$INSTALL_USER":"$INSTALL_USER" "$STAGE_DIR"

if [[ -n "$HIVE_WHEELHOUSE_SOURCE" ]]; then
  HIVE_WHEELHOUSE_STAGE="$STAGE_DIR/.hive-wheelhouse"
  install -d -o root -g root -m 0755 "$HIVE_WHEELHOUSE_STAGE"
  cp -- "$HIVE_WHEELHOUSE_SOURCE"/*.whl "$HIVE_WHEELHOUSE_STAGE/"
  chown root:root "$HIVE_WHEELHOUSE_STAGE" "$HIVE_WHEELHOUSE_STAGE"/*.whl
  chmod 0555 "$HIVE_WHEELHOUSE_STAGE"
  chmod 0444 "$HIVE_WHEELHOUSE_STAGE"/*.whl
fi

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
store_schema_version="$(node -p 'require(process.argv[1]).NATIVE_AUTOMATION_STORE_VERSION' "$STAGE_DIR/src/automations/constants.js")"
[[ "$store_schema_version" =~ ^[1-9][0-9]*$ ]] || die "candidate store schema version is invalid"
printf '{"buildId":"%s","packageVersion":%s,"mode":"native-v2","nativeOnly":true,"storeSchemaVersion":%s}\n' "$BUILD_ID" "$(node -p 'JSON.stringify(require(process.argv[1]).version)' "$STAGE_DIR/package.json")" "$store_schema_version" > "$STAGE_DIR/BUILD.json"
chown "$INSTALL_USER":"$INSTALL_USER" "$STAGE_DIR/BUILD.json"
chmod 0644 "$STAGE_DIR/BUILD.json"

runuser -u "$INSTALL_USER" -- npm --prefix "$STAGE_DIR" ci --omit=dev
test -s "$STAGE_DIR/src/generated/matterCatalog.json"
runuser -u "$INSTALL_USER" -- node -e 'const c=require(process.argv[1]); if(c.schemaVersion!==1||!c.clusters||!c.deviceTypes) process.exit(1)' "$STAGE_DIR/src/generated/matterCatalog.json"
if [[ ! -x "$STAGE_DIR/.venv-hive/bin/python" ]]; then runuser -u "$INSTALL_USER" -- python3 -m venv "$STAGE_DIR/.venv-hive"; fi
if [[ -n "$HIVE_WHEELHOUSE_STAGE" ]]; then
  runuser -u "$INSTALL_USER" -- "$STAGE_DIR/.venv-hive/bin/python" -m pip install --disable-pip-version-check --no-index --find-links "$HIVE_WHEELHOUSE_STAGE" --only-binary=:all: --require-hashes -r "$STAGE_DIR/requirements-hive.lock"
else
  runuser -u "$INSTALL_USER" -- "$STAGE_DIR/.venv-hive/bin/python" -m pip install --disable-pip-version-check --only-binary=:all: --require-hashes -r "$STAGE_DIR/requirements-hive.lock"
fi
runuser -u "$INSTALL_USER" -- "$STAGE_DIR/.venv-hive/bin/python" -c 'from apyhiveapi import Hive; print("Hive adapter ready")'
chmod 0555 "$STAGE_DIR/src/integrations/hive/python"/*.py
if [[ -n "$HIVE_WHEELHOUSE_STAGE" ]]; then
  rm -rf -- "$HIVE_WHEELHOUSE_STAGE"
  HIVE_WHEELHOUSE_STAGE=""
fi

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
if [[ -e "$DISCOVERY_SERVICE_FILE" ]]; then cp -p "$DISCOVERY_SERVICE_FILE" "$BACKUP_DIR/dinodia-setup-discovery-sync.service"; OLD_DISCOVERY_SERVICE_PRESENT=1; fi
if [[ -e "$DISCOVERY_TIMER_FILE" ]]; then cp -p "$DISCOVERY_TIMER_FILE" "$BACKUP_DIR/dinodia-setup-discovery-sync.timer"; OLD_DISCOVERY_TIMER_PRESENT=1; fi
systemctl is-enabled --quiet dinodia-setup-discovery-sync.timer && OLD_DISCOVERY_TIMER_ENABLED=1 || true
systemctl is-active --quiet dinodia-setup-discovery-sync.timer && OLD_DISCOVERY_TIMER_ACTIVE=1 || true
if [[ -f "$AVAHI_CONFIG" ]]; then cp -p "$AVAHI_CONFIG" "$BACKUP_DIR/avahi-daemon.conf"; OLD_AVAHI_CONFIG_PRESENT=1; fi
if [[ "$OLD_DISCOVERY_LINK_PRESENT" -eq 1 ]]; then
  printf '%s\n' "$OLD_DISCOVERY_LINK_TARGET" > "$BACKUP_DIR/dinodia-setup-discovery-current.target"
  chmod 0600 "$BACKUP_DIR/dinodia-setup-discovery-current.target"
  cp -a "$OLD_DISCOVERY_LINK_TARGET" "$BACKUP_DIR/dinodia-setup-discovery-bundle"
fi
if [[ -d "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then
  current_real="$(readlink -f "$INSTALL_DIR")"
  tar --exclude='*/.env*' --exclude='*/node_modules' --exclude='*/.venv-hive' -czf "$BACKUP_DIR/application.tar.gz" -C "$current_real" .
  cp -p "$current_real/package.json" "$BACKUP_DIR/package.json" 2>/dev/null || true
fi

cp -a "$STAGE_DIR" "$RELEASE_DIR"
rm -rf -- "$STAGE_DIR"
STAGE_DIR=""

# Root's periodic interface reconciler must never execute source writable by
# the Dinodia OS service user. Keep only its tiny dependency bundle in a
# root-owned, immutable, versioned directory outside /opt/dinodia-os.
mkdir -p "$DISCOVERY_RELEASE_DIR/scripts" "$DISCOVERY_RELEASE_DIR/src"
install -o root -g root -m 0555 "$RELEASE_DIR/scripts/reconcile_setup_avahi.mjs" "$DISCOVERY_RELEASE_DIR/scripts/reconcile_setup_avahi.mjs"
install -o root -g root -m 0444 "$RELEASE_DIR/src/setupDiscovery.js" "$DISCOVERY_RELEASE_DIR/src/setupDiscovery.js"
install -o root -g root -m 0444 "$RELEASE_DIR/src/avahiSetupConfig.js" "$DISCOVERY_RELEASE_DIR/src/avahiSetupConfig.js"
install -o root -g root -m 0444 "$RELEASE_DIR/src/avahiSetupSupervisor.js" "$DISCOVERY_RELEASE_DIR/src/avahiSetupSupervisor.js"
chown root:root "$DISCOVERY_RELEASE_DIR" "$DISCOVERY_RELEASE_DIR/scripts" "$DISCOVERY_RELEASE_DIR/src"
chmod 0555 "$DISCOVERY_RELEASE_DIR" "$DISCOVERY_RELEASE_DIR/scripts" "$DISCOVERY_RELEASE_DIR/src"

systemctl stop dinodia-os dinodia-identityd >/dev/null 2>&1 || true
SERVICES_STOPPED=1
AVAHI_CONFIG_CANDIDATE="$(mktemp /tmp/dinodia-avahi-candidate.XXXXXX)"
AVAHI_SETUP_ADDRESS="$(node "$RELEASE_DIR/scripts/configure_avahi_setup.mjs" \
  --input "$AVAHI_CONFIG" --output "$AVAHI_CONFIG_CANDIDATE" \
  --identity "$IDENTITY_DIR/identity.json" --interface-name "${DINODIA_SETUP_INTERFACE:-}")"
AVAHI_CONFIG_ATOMIC_TMP="$(mktemp "${AVAHI_CONFIG}.dinodia.XXXXXX")"
install -o root -g root -m 0644 "$AVAHI_CONFIG_CANDIDATE" "$AVAHI_CONFIG_ATOMIC_TMP"
mv -f -- "$AVAHI_CONFIG_ATOMIC_TMP" "$AVAHI_CONFIG"
AVAHI_CONFIG_ATOMIC_TMP=""
AVAHI_CONFIG_CHANGED=1
systemctl enable --now avahi-daemon
systemctl restart avahi-daemon
systemctl is-active --quiet avahi-daemon || die "Avahi did not restart with the setup-interface restriction"
OLD_RELEASE="$RELEASE_ROOT/previous-${timestamp}-${BASHPID}"
if [[ -e "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then mv -- "$INSTALL_DIR" "$OLD_RELEASE"; fi
SWITCHED=1
ln -s "$RELEASE_DIR" "$INSTALL_DIR"
discovery_link_tmp="${DISCOVERY_CURRENT_LINK}.candidate-${BASHPID}"
ln -s -- "$DISCOVERY_RELEASE_DIR" "$discovery_link_tmp"
mv -Tf -- "$discovery_link_tmp" "$DISCOVERY_CURRENT_LINK"
DISCOVERY_LINK_SWITCHED=1

service_tmp="$(mktemp /tmp/dinodia-os.service.XXXXXX)"
sed -e "s#@INSTALL_USER@#$INSTALL_USER#g" -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" -e "s#@DATA_DIR@#$DATA_DIR#g" -e "s#@IDENTITY_DIR@#$IDENTITY_DIR#g" -e "s#@IDENTITY_SOCKET@#$IDENTITY_SOCKET#g" -e "s#@INSTALL_GID@#$install_gid#g" -e "s#@NODE_BIN@#$(command -v node)#g" "$RELEASE_DIR/systemd/dinodia-os.service" > "$service_tmp"
install -o root -g root -m 0644 "$service_tmp" "$SERVICE_FILE"
rm -f "$service_tmp"
identity_service_tmp="$(mktemp /tmp/dinodia-identityd.service.XXXXXX)"
sed -e "s#@IDENTITY_DIR@#$IDENTITY_DIR#g" -e "s#@IDENTITY_SOCKET@#$IDENTITY_SOCKET#g" -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" -e "s#@INSTALL_GID@#$install_gid#g" -e "s#@NODE_BIN@#$(command -v node)#g" "$RELEASE_DIR/systemd/dinodia-identityd.service" > "$identity_service_tmp"
install -o root -g root -m 0644 "$identity_service_tmp" "$IDENTITY_SERVICE_FILE"
rm -f "$identity_service_tmp"
discovery_service_tmp="$(mktemp /tmp/dinodia-setup-discovery-sync.service.XXXXXX)"
sed -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" -e "s#@IDENTITY_DIR@#$IDENTITY_DIR#g" -e "s#@NODE_BIN@#$(command -v node)#g" "$RELEASE_DIR/systemd/dinodia-setup-discovery-sync.service" > "$discovery_service_tmp"
install -o root -g root -m 0644 "$discovery_service_tmp" "$DISCOVERY_SERVICE_FILE"
rm -f "$discovery_service_tmp"
install -o root -g root -m 0644 "$RELEASE_DIR/systemd/dinodia-setup-discovery-sync.timer" "$DISCOVERY_TIMER_FILE"
install -d -o root -g root -m 0700 "$IDENTITY_DIR"
systemctl daemon-reload

if ! systemctl enable --now dinodia-identityd || ! systemctl enable --now dinodia-os; then die "candidate service failed to start"; fi
systemctl enable --now dinodia-setup-discovery-sync.timer || die "locked-setup interface reconciliation timer failed to start"
systemctl start dinodia-setup-discovery-sync.service || die "locked-setup interface reconciliation failed"

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
if [[ "$health_ok" -ne 1 ]]; then die "candidate health did not report the expected native-v2 build; the installer recovery policy will be applied"; fi

setup_hostname="$(node -e 'const x=require(process.argv[1]); process.stdout.write("dinodia-"+String(x.serialNumber||x.serial||"").toLowerCase()+".local")' "$IDENTITY_DIR/identity.json")"
discovery_ok=0
for attempt in $(seq 1 15); do
  resolved_address="$(timeout 3 avahi-resolve-host-name -4 "$setup_hostname" 2>/dev/null | awk 'NR==1 { print $NF }' || true)"
  if [[ "$resolved_address" == "$AVAHI_SETUP_ADDRESS" ]]; then discovery_ok=1; break; fi
  sleep 1
done
if [[ "$discovery_ok" -ne 1 ]]; then die "locked-setup mDNS did not resolve the candidate alias to the selected private interface; the installer recovery policy will be applied"; fi
rm -f -- "$AVAHI_CONFIG_CANDIDATE"
AVAHI_CONFIG_CANDIDATE=""

# Install the narrow root-owned updater executor only after the Native V2
# candidate and existing setup discovery have passed their health checks. Its
# root trust policy is created disabled and is never replaced on later runs.
bash "$RELEASE_DIR/scripts/install-updater-service.sh" "$RELEASE_DIR" "$BUILD_ID"

COMPLETED=1
SERVICES_STOPPED=0
echo "Native V2 installed: build=$BUILD_ID release=$RELEASE_DIR backup=$BACKUP_DIR"
echo "Health verified: mode=native-v2 build=$BUILD_ID"
