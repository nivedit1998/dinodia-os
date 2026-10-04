#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 || ! -f /.dockerenv || "$(printenv DINODIA_UPDATER_INSTALLER_TEST 2>/dev/null || true)" != "1" ]]; then
  echo "Run only inside an explicitly disposable Linux container with DINODIA_UPDATER_INSTALLER_TEST=1." >&2
  exit 78
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
build=native-v2-aaaaaaaaaaaaaaaaaaaaaaaa
source_dir="/opt/dinodia-os-releases/$build"
installed_dir="/usr/lib/dinodia-os-updater/releases/$build"
old_updater=/usr/lib/dinodia-os-updater/releases/native-v2-old
old_os=/opt/dinodia-os-releases/native-v2-old
state_dir=/run/dinodia-updater-installer-test

command -v node >/dev/null
[[ -x /usr/bin/node ]] || ln -s "$(command -v node)" /usr/bin/node
getent group dinodia >/dev/null || groupadd --system dinodia
id dinodia >/dev/null 2>&1 || useradd --system --no-create-home --gid dinodia --shell /usr/sbin/nologin dinodia

install -d -o root -g root -m 0755 \
  "$source_dir/src/updater" "$source_dir/src/automations" "$source_dir/systemd" "$source_dir/scripts" \
  "$old_updater/src/updater" "$old_updater/src/automations" "$old_os" \
  /usr/lib/dinodia-os-updater /etc/dinodia-os /etc/systemd/system /var/lib/dinodia-os \
  /var/lib/dinodia-os-updater "$state_dir"
cp "$repo_root/src/updater/service.js" "$repo_root/src/updater/executor.js" "$repo_root/src/updater/releaseManifest.js" "$source_dir/src/updater/"
cp "$repo_root/src/automations/constants.js" "$source_dir/src/automations/"
cp "$repo_root/systemd/dinodia-os-updater.service" "$source_dir/systemd/"
cp "$repo_root/systemd/dinodia-updater-policy.disabled.json" "$source_dir/systemd/"
cp "$repo_root/scripts/install-updater-service.sh" "$source_dir/scripts/"
printf '{"buildId":"native-v2-old","packageVersion":"2.0.0","mode":"native-v2","storeSchemaVersion":10}\n' >"$old_os/BUILD.json"
ln -s "$old_os" /opt/dinodia-os
printf 'DINODIA_DATA_DIR=/var/lib/dinodia-os\n' >/opt/dinodia-os/.env
chmod 0600 /opt/dinodia-os/.env

cat >/usr/local/bin/systemctl <<'SYS'
#!/usr/bin/env bash
set -Eeuo pipefail
state=/run/dinodia-updater-installer-test
case "$1" in
  is-enabled) [[ -f "$state/enabled" ]] ;;
  is-active) [[ -f "$state/active" ]] ;;
  daemon-reload|stop) rm -f "$state/active"; exit 0 ;;
  disable) rm -f "$state/enabled"; exit 0 ;;
  enable)
    if [[ "$2" != "--now" ]]; then touch "$state/enabled"; exit 0; fi
    if [[ "$(printenv DINODIA_TEST_FAIL_START 2>/dev/null || echo 0)" == "1" ]]; then exit 1; fi
    install -d -o root -g dinodia -m 0750 /run/dinodia-os-updater
    exec_line="$(sed -n 's/^ExecStart=//p' /etc/systemd/system/dinodia-os-updater.service)"
    # Type=simple systemd can report active before Node has bound its control
    # socket. Preserve that startup ordering in the package test so the
    # installer's bounded readiness wait is exercised deterministically.
    ( sleep 0.5; bash -c "$exec_line" ) >/tmp/dinodia-updater-installer-test.log 2>&1 &
    echo "$!" >"$state/pid"
    touch "$state/enabled" "$state/active"
    ;;
  start) touch "$state/active" ;;
  *) exit 1 ;;
esac
SYS
chmod 0755 /usr/local/bin/systemctl

bash "$source_dir/scripts/install-updater-service.sh" "$source_dir" "$build"
[[ "$(stat -c '%U:%G:%a' /run/dinodia-os-updater/control.sock)" == "root:dinodia:660" ]]
runuser -u dinodia -- node -e '
const net=require("node:net");
const socket=net.createConnection("/run/dinodia-os-updater/control.sock");
let data="";
socket.on("connect",()=>socket.write(JSON.stringify({operation:"status"})+"\n"));
socket.on("data",chunk=>{data+=chunk;if(data.includes("\n")){const result=JSON.parse(data);if(!result.ok||result.status.trustState!=="unprovisioned")process.exitCode=1;else process.stdout.write(JSON.stringify({phase:result.status.phase,trust:result.status.trustState})+"\n");socket.end();}});
socket.on("error",()=>process.exit(2));
'

systemctl stop dinodia-os-updater.service
if [[ -f "$state_dir/pid" ]]; then kill "$(cat "$state_dir/pid")" 2>/dev/null || true; fi
rm -rf /usr/lib/dinodia-os-updater /run/dinodia-os-updater "$state_dir"
install -d -o root -g root -m 0755 "$old_updater" /usr/lib/dinodia-os-updater/releases
printf 'previous-unit\n' >/etc/systemd/system/dinodia-os-updater.service
printf '{"enabled":false,"preserve":true}\n' >/etc/dinodia-os/updater-policy.json
chmod 0600 /etc/dinodia-os/updater-policy.json
ln -s "$old_updater" /usr/lib/dinodia-os-updater/current
install -d -o root -g root -m 0755 "$state_dir"
touch "$state_dir/enabled" "$state_dir/active"
policy_hash="$(sha256sum /etc/dinodia-os/updater-policy.json | awk '{print $1}')"
if DINODIA_TEST_FAIL_START=1 bash "$source_dir/scripts/install-updater-service.sh" "$source_dir" "$build"; then
  echo "The deliberately failing updater installation unexpectedly succeeded." >&2
  exit 1
fi
[[ "$(readlink -f /usr/lib/dinodia-os-updater/current)" == "$old_updater" ]]
[[ "$(cat /etc/systemd/system/dinodia-os-updater.service)" == "previous-unit" ]]
[[ "$(sha256sum /etc/dinodia-os/updater-policy.json | awk '{print $1}')" == "$policy_hash" ]]
[[ -f "$state_dir/enabled" && -f "$state_dir/active" ]]
[[ ! -e "$installed_dir" ]]
printf '{"installer":"pass","unitExecStart":"launched","socket":"root:dinodia:660","runtime":"status-only","failedInstall":"previous-state-restored"}\n'
