#!/usr/bin/env bash
set -Eeuo pipefail

die() { echo "Avahi integration test failed: $*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "run only in an isolated root-owned Linux test container"
[[ -f /.dockerenv || -f /run/.containerenv ]] || die "refusing to start a test D-Bus/Avahi daemon outside an isolated container"
for command in avahi-daemon avahi-publish-address avahi-publish-service avahi-resolve-host-name avahi-browse dbus-daemon ip timeout; do
  command -v "$command" >/dev/null 2>&1 || die "missing Linux test dependency: $command"
done
[[ ! -S /run/dbus/system_bus_socket ]] || die "refusing to use a host system D-Bus socket"
if avahi-daemon --check >/dev/null 2>&1; then die "refusing to interact with an existing Avahi daemon"; fi

interface="$(ip -4 -o addr show scope global | awk 'NR == 1 { sub(/@.*/, "", $2); print $2 }')"
[[ -n "$interface" && "$interface" != "lo" ]] || die "no isolated test interface is available"
address="$(ip -4 -o addr show dev "$interface" scope global | awk 'NR == 1 { split($4, a, "/"); print a[1] }')"
[[ -n "$address" ]] || die "test interface has no IPv4 address"

work_dir="$(mktemp -d /tmp/dinodia-avahi-test.XXXXXX)"
mkdir -p /run/dbus /run/avahi-daemon
dbus_pid=""
daemon_pid=""
address_pid=""
service_pid=""
cleanup() {
  for pid in "$service_pid" "$address_pid" "$daemon_pid" "$dbus_pid"; do
    [[ -n "$pid" ]] || continue
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  done
  rm -rf -- "$work_dir"
  rm -f -- /run/avahi-daemon/pid /run/avahi-daemon/socket /run/dbus/system_bus_socket
}
trap cleanup EXIT

dbus_pid="$(dbus-daemon --system --fork --print-pid=1)"
serial="linux-probe-$$"
host_name="din-home-$serial"
setup_name="dinodia-$serial.local"
service_name="Dinodia OS $serial"
config="$work_dir/avahi-daemon.conf"
printf '[server]\nhost-name=%s\ndomain-name=local\nuse-ipv4=yes\nuse-ipv6=no\nallow-interfaces=%s\nenable-dbus=yes\n[publish]\npublish-addresses=yes\npublish-workstation=no\n' \
  "$host_name" "$interface" > "$config"

start_daemon() {
  avahi-daemon --no-chroot --no-drop-root --no-rlimits --debug --file="$config" >"$work_dir/daemon.log" 2>&1 &
  daemon_pid=$!
  for _ in $(seq 1 40); do
    if grep -q 'Server startup complete' "$work_dir/daemon.log"; then return 0; fi
    if ! kill -0 "$daemon_pid" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  tail -n 30 "$work_dir/daemon.log" >&2 || true
  die "Avahi daemon did not start"
}

start_publishers() {
  avahi-publish-address -R "$setup_name" "$address" >"$work_dir/address.log" 2>&1 &
  address_pid=$!
  avahi-publish-service "$service_name" _http._tcp 8123 "path=/setup" "serial=$serial" >"$work_dir/service.log" 2>&1 &
  service_pid=$!
  for _ in $(seq 1 40); do
    if grep -q 'Established under name' "$work_dir/address.log" && grep -q 'Established under name' "$work_dir/service.log"; then return 0; fi
    if ! kill -0 "$address_pid" >/dev/null 2>&1 || ! kill -0 "$service_pid" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  cat "$work_dir/address.log" "$work_dir/service.log" >&2 || true
  die "Avahi address or locked-setup service publisher did not stay active"
}

assert_discovery() {
  resolved="$(timeout 5 avahi-resolve-host-name -4 "$setup_name" | awk 'NR == 1 { print $NF }')"
  [[ "$resolved" == "$address" ]] || die "setup alias did not resolve to the selected interface address"
  browse="$(timeout 5 avahi-browse -rt _http._tcp 2>&1 || true)"
  service_rows="$(printf '%s\n' "$browse" | grep -F "$service_name" | grep -E '^[+=]' || true)"
  [[ -n "$service_rows" ]] || die "locked-setup DNS-SD service was not visible"
  while IFS= read -r row; do
    [[ -z "$row" ]] && continue
    row_interface="$(awk '{ print $2 }' <<< "$row")"
    [[ "$row_interface" == "$interface" ]] || die "service escaped the selected interface"
  done <<< "$service_rows"
}

start_daemon
host_address="$(timeout 5 avahi-resolve-host-name -4 "$host_name.local" | awk 'NR == 1 { print $NF }')"
[[ "$host_address" == "$address" ]] || die "baseline host address record was not established"

# Reproduce the live failure: a second hostname for the same interface address
# must not try to claim the existing host's reverse PTR record.
set +e
timeout 3 avahi-publish-address "$setup_name" "$address" >"$work_dir/no-reverse-flag.log" 2>&1
set -e
grep -q 'Local name collision' "$work_dir/no-reverse-flag.log" || die "test did not reproduce the duplicate reverse-record collision"

publisher_help="$(avahi-publish-address --help 2>&1 || true)"
[[ "$publisher_help" == *"--no-reverse"* ]] || die "Avahi CLI lacks the required --no-reverse flag"
start_publishers
assert_discovery

# Verify a daemon restart clears registrations cleanly and the app publishers
# can recreate them with the same scoped hostname and service.
kill "$service_pid" "$address_pid" "$daemon_pid"
wait "$service_pid" >/dev/null 2>&1 || true
wait "$address_pid" >/dev/null 2>&1 || true
wait "$daemon_pid" >/dev/null 2>&1 || true
service_pid=""
address_pid=""
daemon_pid=""
rm -f -- /run/avahi-daemon/pid /run/avahi-daemon/socket
start_daemon
start_publishers
assert_discovery

echo "Avahi setup discovery integration passed (reverse collision, $interface scope, daemon restart)"
