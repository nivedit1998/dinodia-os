# Logical devices: recovery boundary

Ordinary offline reboots retain local controls under their existing authority.
This does not require a new cloud round trip on every boot.

Nivedit's decision on 25 October 2026: “Preserve offline reboot; require guarded restores”.

## Supported restore

Use Dinodia's guarded restore/recovery procedure. Restored household data must remain
quarantined until the current enrolled Hub has received and acknowledged current signed
cloud policy, including logical bindings and anonymous deletion security references.
The existing Store recovery marker and deferred runtime gate must not be removed.
Retain the deletion-ledger sidecar alongside normal Store backups.

A manually copied old complete data directory or old disk image, including its old
sidecars/markers, cannot be reliably detected without external authority while offline.
It is not a supported restore procedure. Do not claim otherwise.

## Interrupted operations

- Confirmed intent is durable before requesting a cloud reservation.
- Reservations do not expire while the Hub may already have fenced authority.
- A current full-Home operator can discover pending deletion/conversion operations
  in the full Home dashboard and retry the same operation.
- A local fence never reopens access merely because the network request failed.
- Shared or unproven sibling hardware stays paired.
- Actual adapter removal or complete current controller absence is required before
  erasure completes. Provider-account detachment is not a factory reset or an
  account-wide provider deletion.
- Private siblings retain cleanup context until every revoked sibling is purged.

## Feature-off and binary recovery

Disabling new logical commissioning/deletion does not discard existing logical mappings,
deletion fences or signed reconciliation capability. Previously reserved operations may
continue their guarded cleanup; new operations stay disabled.

After conversion or deletion, do not reinstall a pre-logical binary. It does not enforce
the new authority/fences. Disable new operations using the feature flag, preserve the
current compatible Platform and Store, and deploy a reviewed compatible forward fix.
Never restore an older Store as a release rollback.
