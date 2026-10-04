#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then echo "Updater service installation requires the existing Pi sudo checkpoint." >&2; exit 1; fi
source_dir="$(realpath -e "${1:?reviewed release directory required}")"
build_id="${2:?reviewed build identity required}"
[[ "$build_id" =~ ^native-v2-[a-f0-9]{24}$ ]] || { echo "Invalid Native V2 updater release identity." >&2; exit 1; }
[[ "$source_dir" == "/opt/dinodia-os-releases/$build_id" ]] || { echo "Updater source is outside the immutable reviewed release." >&2; exit 1; }
[[ -f "$source_dir/src/updater/service.js" && -f "$source_dir/src/updater/executor.js" && -f "$source_dir/src/updater/releaseManifest.js" && -f "$source_dir/src/automations/constants.js" && -f "$source_dir/systemd/dinodia-os-updater.service" ]] || { echo "The reviewed updater package is incomplete." >&2; exit 1; }
id dinodia >/dev/null 2>&1 || { echo "The existing Dinodia service account is unavailable." >&2; exit 1; }

root=/usr/lib/dinodia-os-updater
release_root="$root/releases"
current="$root/current"
release="$release_root/$build_id"
unit=/etc/systemd/system/dinodia-os-updater.service
policy=/etc/dinodia-os/updater-policy.json
install -d -o root -g root -m 0700 /var/lib/dinodia-os-updater
install -d -o root -g root -m 0755 "$root" "$release_root"
[[ ! -e "$release" ]] || { echo "The immutable updater release identity already exists; inspect it before retrying." >&2; exit 1; }
stage="$(mktemp -d "$release_root/.stage-$build_id.XXXXXX")"
backup="$(mktemp -d /var/lib/dinodia-os-updater-install.XXXXXX)"
old_link=""
had_link=0
had_unit=0
policy_created=0
link_switched=0
unit_switched=0
release_installed=0
complete=0
old_unit_enabled=0
old_unit_active=0
if systemctl is-enabled --quiet dinodia-os-updater.service >/dev/null 2>&1; then old_unit_enabled=1; fi
if systemctl is-active --quiet dinodia-os-updater.service >/dev/null 2>&1; then old_unit_active=1; fi

restore() {
  local result=$?
  if [[ "$complete" -eq 1 ]]; then
    [[ -z "$stage" ]] || rm -rf -- "$stage"
    [[ -z "$backup" ]] || rm -rf -- "$backup"
    return "$result"
  fi
  systemctl stop dinodia-os-updater.service >/dev/null 2>&1 || true
  if [[ "$unit_switched" -eq 1 ]]; then
    if [[ "$had_unit" -eq 1 ]]; then install -o root -g root -m 0644 "$backup/old-unit" "$unit"; else rm -f -- "$unit"; fi
  fi
  if [[ "$link_switched" -eq 1 ]]; then
    if [[ "$had_link" -eq 1 ]]; then
      local link_tmp="$root/current.rollback.$BASHPID"
      ln -s -- "$old_link" "$link_tmp"
      mv -Tf -- "$link_tmp" "$current"
    else rm -f -- "$current"; fi
  fi
  if [[ "$policy_created" -eq 1 ]]; then rm -f -- "$policy"; fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [[ "$old_unit_enabled" -eq 1 ]]; then systemctl enable dinodia-os-updater.service >/dev/null 2>&1 || true; else systemctl disable dinodia-os-updater.service >/dev/null 2>&1 || true; fi
  if [[ "$old_unit_active" -eq 1 ]]; then systemctl start dinodia-os-updater.service >/dev/null 2>&1 || true; else systemctl stop dinodia-os-updater.service >/dev/null 2>&1 || true; fi
  if [[ "$release_installed" -eq 1 ]]; then
    current_real="$(realpath -e "$current" 2>/dev/null || true)"
    if [[ "$current_real" != "$release" ]]; then rm -rf -- "$release"; fi
  fi
  [[ -z "$stage" ]] || rm -rf -- "$stage"
  [[ -z "$backup" ]] || rm -rf -- "$backup"
  return "$result"
}
trap restore EXIT

install -d -o root -g root -m 0755 "$stage/src/updater" "$stage/src/automations"
for name in service.js executor.js releaseManifest.js; do install -o root -g root -m 0444 "$source_dir/src/updater/$name" "$stage/src/updater/$name"; done
install -o root -g root -m 0444 "$source_dir/src/automations/constants.js" "$stage/src/automations/constants.js"
install -o root -g root -m 0444 "$source_dir/systemd/dinodia-os-updater.service" "$stage/dinodia-os-updater.service"
chown -R root:root "$stage"
chmod 0555 "$stage" "$stage/src" "$stage/src/updater" "$stage/src/automations"
mv -- "$stage" "$release"
stage=""
release_installed=1

if [[ -L "$current" ]]; then
  old_link="$(readlink -- "$current")"
  resolved_old="$(realpath -e "$current")"
  [[ "$resolved_old" == "$release_root/"* && -d "$resolved_old" ]] || { echo "Existing updater pointer is outside the root-owned release directory." >&2; exit 1; }
  had_link=1
elif [[ -e "$current" ]]; then
  echo "Refusing to replace a non-symlink updater pointer." >&2; exit 1
fi
if [[ -f "$unit" ]]; then cp -p -- "$unit" "$backup/old-unit"; had_unit=1; fi
if [[ ! -e "$policy" ]]; then
  install -o root -g root -m 0600 "$source_dir/systemd/dinodia-updater-policy.disabled.json" "$policy"
  policy_created=1
fi
[[ -f "$policy" && ! -L "$policy" && "$(stat -c '%U:%a' "$policy")" == "root:600" ]] || { echo "Updater trust policy is not a root-owned protected file." >&2; exit 1; }
link_tmp="$root/current.candidate.$BASHPID"
ln -s -- "$release" "$link_tmp"
mv -Tf -- "$link_tmp" "$current"
link_switched=1
unit_tmp="$(mktemp /etc/systemd/system/dinodia-os-updater.service.XXXXXX)"
cp -- "$release/dinodia-os-updater.service" "$unit_tmp"
install -o root -g root -m 0644 "$unit_tmp" "$unit"
rm -f -- "$unit_tmp"
unit_switched=1
systemctl daemon-reload
systemctl enable --now dinodia-os-updater.service
systemctl is-active --quiet dinodia-os-updater.service || { echo "The isolated updater service did not become active." >&2; exit 1; }
socket_ready=0
for ((attempt = 0; attempt < 80; attempt += 1)); do
  if ! systemctl is-active --quiet dinodia-os-updater.service; then break; fi
  if [[ -S /run/dinodia-os-updater/control.sock ]] \
    && [[ "$(stat -c '%U:%G:%a' /run/dinodia-os-updater/control.sock 2>/dev/null || true)" == "root:dinodia:660" ]]; then
    socket_ready=1
    break
  fi
  sleep 0.25
done
[[ "$socket_ready" -eq 1 ]] || { echo "The isolated updater service did not create its correctly protected control socket." >&2; exit 1; }
[[ "$(stat -c '%U' /usr/lib/dinodia-os-updater/current/src/updater/service.js)" == root ]] || { echo "Updater executable is not root-owned." >&2; exit 1; }
complete=1
echo "Isolated updater installed for reviewed build $build_id; trust remains disabled until approved public-key provisioning."
