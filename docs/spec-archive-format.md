# Spec Archive Format (v1)

Shared markdown schema written by `/spec` and (starting Increment 2) `/build`.
Both skills produce and consume this format so per-feature specs can flow between them.

**Path convention:** `~/.gstack/projects/<slug>/specs/<timestamp>-<pid>-<slug>.md`

## Frontmatter

```yaml
---
spec_id: <feature-or-issue-slug> # required; lowercase a-z0-9-, max 60 chars
spec_archive_format_version: 1 # required; integer schema version
spec_filed_via: /spec | /build | hybrid # required; which skill emitted this
spec_issue_number: <N> | null # required; GitHub issue number or null
spec_filed_at: <ISO 8601 UTC> # required; timestamp at write
spec_quality_score: <0-10> # required for /build-emitted; optional for /spec
spec_quality_gate_rounds: <N> # required for /build-emitted; optional for /spec
feature_number: <N> # /build-emitted only (feature index in source plan)
source_plan: <absolute path> # /build-emitted only
origin_trace: <source plan refs> # /build-emitted only
target_repo: <repo slug> # /build-emitted only
kind: code | writing | experiment | research | manual # required
---
```

## Body sections — required for `kind: code`

| Section                | Heading                     | Required content                                                               |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| Context                | `## Context`                | 2-4 sentences: what exists today, why insufficient, why now                    |
| Verified Current State | `## Verified Current State` | File:line citations table; greenfield features state "No existing code"        |
| Proposed Change        | `## Proposed Change`        | What changes; signatures and shapes as actual code (not pseudocode)            |
| Schemas / Interfaces   | `### Schemas / Interfaces`  | TypeScript / SQL / JSON code blocks; required when feature changes data shapes |
| File Reference Table   | `### File Reference Table`  | Every file to create or modify (File, Action, Lines, Why columns)              |
| Acceptance Criteria    | `## Acceptance Criteria`    | Numbered list; at least one quantified criterion (numeric)                     |
| Test Spec              | `## Test Spec`              | Coverage target + ID/Scenario/Given/When/Then table + edge cases               |
| Verification Spec      | `## Verification Spec`      | Smoke commands + acceptance probes table + verification artifacts              |
| Out of Scope           | `## Out of Scope`           | Explicit non-goals (may be `none` but field must exist)                        |
| Rollback               | `## Rollback`               | How to undo if shipped broken                                                  |

## Body sections — lighter form for non-code `kind`

| Section             | Heading                  | Required content                                            |
| ------------------- | ------------------------ | ----------------------------------------------------------- |
| Context             | `## Context`             | Same as code                                                |
| Proposed Change     | `## Proposed Change`     | Artifact to produce; audience; claims; inputs               |
| Acceptance Criteria | `## Acceptance Criteria` | Observable criteria (artifact exists, word count, etc.)     |
| Verification Spec   | `## Verification Spec`   | Verification artifacts list + single-sentence pass criteria |
| Out of Scope        | `## Out of Scope`        | Same as code                                                |

## Sentinel (end of file)

```html
<!-- gstack-spec-complete
ts: <ISO 8601 UTC>
quality_score: <N>
gate_rounds: <N>
interrogation: yes | no | skipped
filed_via: /spec | /build | hybrid
-->
```

## Versioning

`spec_archive_format_version: 1` is the current schema. Breaking changes bump the integer.
Consumers must reject archives with a higher version than they understand.
