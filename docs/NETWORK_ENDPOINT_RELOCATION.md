# Native V2 network endpoint relocation

The Pi's private installer endpoint is a signed, generation-bound observation,
not a permanent address copied from its original provisioning attempt.

- `DINODIA_SETUP_INTERFACE` is an optional stable physical interface name
  (`eth0`, `wlan0`, or an OS-assigned `en…` name). It is never an IPv4 address.
- Native OS polls physical interfaces every 10 seconds. A DHCP address, subnet,
  or selected-interface change advances a persisted monotonic endpoint revision
  and queues an immediate machine-authenticated Platform heartbeat.
- Platform accepts only the authenticated installation's exact private IPv4
  URL on port 8123 and active manufacturing identity generation. A stale,
  replayed, public, virtual, malformed, or conflicting revision cannot replace
  the recorded endpoint. The endpoint is marked unavailable when no eligible
  physical interface exists; an old address is not offered as current.
- `dinodia-setup-discovery-sync.timer` reconciles Avahi every 10 seconds and
  withdraws discovery if no eligible interface is present. It publishes only
  on the selected physical private interface. Its helper and dependencies are
  installed in a versioned, root-owned, non-writable bundle under
  `/usr/local/lib/dinodia-setup-discovery-releases`; systemd never executes the
  Dinodia OS service user's writable application source as root.
- `Open secure Dinodia OS` continues to use the already verified CloudURL and
  existing tunnel. A separate local launch is offered only while a signed LAN
  endpoint is fresh. A private-IP change does not update Cloudflare DNS, tunnel
  credentials, identity, pairing state, or an existing browser session.
- The guarded installer backs up the Avahi config, service units and previous
  root-helper target. A failed candidate restores the old OS release, helper
  pointer, Avahi config, units, and timer enablement.
