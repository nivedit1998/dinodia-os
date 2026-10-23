# Observation policy startup and recovery repair

## Proven failure

On installed R2 build `native-v2-2735e39ea148f681a67dc0dd` (source
`3297e31001b551532184b904fa910fd5e03fb16c`), the retained Zigbee inventory replay
threw `Conflicting native activity observation timestamp` before calling the
observation reconciler. Startup had capped usage coverage at the last running
marker, but replay compared that coverage deadline with the original sample's
deadline. A read-only replay of the actual inputs reproduced zero policy calls;
calling the reconciler directly with the same inventory created its record.

## Repair and invariants

- Keep original observation identity separate from coverage shortened by shutdown
  or availability loss. Replayed metadata never restores the shortened interval.
  Legacy already-capped records are accepted without renewing their coverage.
- Roll back the complete device mutation on failure. An isolated inventory
  projection failure no longer prevents reconciliation of registered devices.
- Availability loss ends coverage at receipt time, rather than fabricating an
  Unknown attribute report at an older timestamp. Reconnection alone is not a
  fresh observation.
- Zigbee snapshot freshness uses the attribute's validated source timestamp, not
  metadata delivery. Save per-observation deadlines; a policy change cannot extend
  an already-observed value. A genuine newer report adopts the new lifetime.
- Serialize policy transitions and persist before exposing or publishing them.
  Recover interrupted reporting requests with a bounded read first. Validate
  responses and keep unsupported/error responses distinct from configuration drift.
- Configuration read-back proves configuration only. Failed cadence requires a
  new sequence of four genuine reports; duplicate/older reports cannot verify it.
  An overdue verified value immediately loses verified cadence, while recovery
  requests remain bounded by the existing silence/backoff budget.
- Use a real stored timestamp, or null, for descriptor migration diagnostics,
  never a manufactured 1970 timestamp. Historical entries are not rewritten.

No schema bump, actuator command, pairing change, freshness extension, new model
approval, automatic value polling, iOS change or Platform change is included.
The approved TRVZB heating profile remains 600 seconds plus 60 seconds delivery
grace, with zero missed reports tolerated. Other profiles remain framework-only.

## Verification

Untouched base: 556 tests, 552 passed, zero failed, four skipped. The first ten
new recovery regressions failed on the old source. Final full suite: 572 tests,
568 passed, zero failed, four skipped; syntax checks passed. Recovery tests cover the real
Store/bridge/reconciler path plus legacy replay, atomicity, source provenance,
deadline changes, availability loss, request recovery and cadence recovery.

Detailed test/install evidence lives in the workspace's
`Code Planning/Real Testing and UAT etc/HUB_OBSERVATION_RECOVERY_20261023/`.
Live configuration read-back and live report cadence must be reported separately;
neither health alone nor cached configured reporting proves the latter.

The packet must record the exact release commit and derived build ID. Rollback
targets R2 code and preserves the current Store, analytics and upload queue.
Physical power-loss, other-device compatibility and long-term battery/cadence
acceptance are not implied by synthetic tests or a short live observation.
