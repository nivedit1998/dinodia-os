# Native command receipts and queued Store mutations

The Store serializes mutations. A `getSecurity()` snapshot obtained outside that queue is not a safe replacement for all security fields after the mutation starts. Previously event/cursor writes could restore accepted receipts over applied outcomes, after their confirmation timer had been cleared.

Event and catalogue writers must patch only their owned fields. Command transitions must examine and change the current entry inside `mutateAtomically`; claims merge their single entry/index into the current pruned maps. An adapter error must never restore its pre-dispatch snapshot over a matching device observation. Applied is terminal; a genuine later matching observation may resolve timed_out. Startup recovery only marks currently dispatching entries uncertain.

This does not infer application from adapter acceptance, cached state, check-ins, periodic freshness guarantees or a requested value. The existing exact-control, newer observation timestamp/revision and value match remain required. Final dispatch authority revalidation and serialized latest-wins/idempotency behavior remain unchanged for both Local and Cloud callers.

Tests use a synthetic Hub with real Store serialization and authenticated HTTP receipt routes, not radio commands. Hold the Store queue, enqueue report reconciliation and competing state-event/catalogue persistence, release it, and assert applied in memory and on disk. This fails deterministically on the preceding source. Existing boundary tests separately retain authority changes while dispatch claims persist, timeout, late-report and failed-adapter coverage.
