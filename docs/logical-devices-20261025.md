# Logical devices / Area deletion — implementation checkpoint

NOT RELEASE READY. This branch is work in progress, not a completed LD-00–LD-12 release.

Base: d85efb81d7b1b2e04dbdb0e7b6cce2aaeeed23c7. Physical transport inventory remains
single-pairing; managed projections use explicit source-bound logical children. Feature
`DINODIA_LOGICAL_DEVICES_ENABLED` defaults off. No additional observation policy is enabled.

Connected work includes Store/HA/native projections, per-source routing/evidence, optional new
commissioning channel proposals, signed mappings, and staged full-Home Area-deletion coordination.
Deletion reserves an online cloud intent before durable local fencing; shared parents are not
removed. Actual adapter acknowledgement is required before local/cloud completion. The separate
deletion security ledger must accompany recovery; never restore an old Store over current policy
or downgrade after channel/deletion activation without a proven forward-recovery procedure.

Remaining release blockers include existing-device conversion/generations; independent canonical
management; private grant-removal/last-child cleanup; exhaustive historical/nested purge and
restore/replay coverage; real HTTP/database commissioning/deletion tests; installer/iOS/Alexa UX
and permission matrix; final exact-source suites, artifacts and independent READY review.

Only synthetic devices were used. No household device conversion, room deletion, unpair or
actuator test, Production migration/deployment, Hub install or TestFlight upload occurred.

Detailed local evidence and phase status live in the shared workspace:
`Code Planning/Real Testing and UAT etc/LOGICAL_DEVICES_AREA_DELETION_20261025/IMPLEMENTATION_HANDOFF.md`.
