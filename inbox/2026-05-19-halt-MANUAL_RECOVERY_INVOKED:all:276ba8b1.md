# Halt investigation: MANUAL_RECOVERY_INVOKED

**Auto-filed by drain-faults** (2026-05-19T22:58:36.123Z)
**Halt severity:** HIGH
**Outcome:** root-cause-identified
**Run:** drain-faults

## Symptom

drain-faults subcommand invoked (queue)

## Root cause (investigator)

Integration-boundary failure: the queue consumer (`gstack-build drain-faults --queue`) records its own invocation as a HIGH-severity `MANUAL_RECOVERY_INVOKED` halt event before draining the same queue. Because the queue event has deterministic identity and empty plan/log pointers, invoking queue recovery creates an investigation for the recovery mechanism itself rather than for an underlying build fault.

## Evidence

- /Users/anbang/.gstack/skill-faults/pending-investigations/drain-faults-MANUAL_RECOVERY_INVOKED:all:276ba8b1.json:2
- /Users/anbang/.gstack/skill-faults/pending-investigations/drain-faults-MANUAL_RECOVERY_INVOKED:all:276ba8b1.json:6
- /Users/anbang/.gstack/skill-faults/pending-investigations/drain-faults-MANUAL_RECOVERY_INVOKED:all:276ba8b1.json:8
- /Users/anbang/Documents/Antigravity/claude-workspace/gstack/build/orchestrator/cli.ts:9333
- /Users/anbang/Documents/Antigravity/claude-workspace/gstack/build/orchestrator/cli.ts:9347
- /Users/anbang/Documents/Antigravity/claude-workspace/gstack/build/orchestrator/cli.ts:9349
- /Users/anbang/Documents/Antigravity/claude-workspace/gstack/build/orchestrator/cli.ts:9356
- /Users/anbang/Documents/Antigravity/claude-workspace/gstack/build/orchestrator/drain-faults.ts:1249

## Proposed fix

### Do not emit for queue drain (blast: narrow)

In the `args.mode === "drain-faults"` branch, skip `emitHaltEvent` when `args.drainFaultsQueueMode` is true, since queue draining is the investigator sink and should not enqueue itself.

### Mark recovery events as audit-only (blast: medium)

Route manual recovery invocations to analytics/audit logs instead of `pending-investigations`, or add an `investigate: false` flag that `loadPendingInvestigations`/queue drain honors.

### Add self-event suppression in queue drain (blast: medium)

Teach `drainFaultsFromHaltEventsQueue` to short-circuit `MANUAL_RECOVERY_INVOKED` events whose runId is `drain-faults` and message is `drain-faults subcommand invoked (queue)`, then move them to processed without dispatching an investigator.
