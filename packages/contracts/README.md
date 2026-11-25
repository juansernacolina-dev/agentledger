# @agentledger/contracts

Shared Zod contracts used by the API, worker and web app.

## Run contract (v1)

`AgentRunSchema` describes one agent run: workspace, agent version, status,
budget (steps, duration, retries), timing source and an ordered list of steps.
Beyond field types it enforces:

- step indexes are contiguous from 0 and step ids are unique
- step count, retry attempts and step end times stay within the run budget
- `succeeded`, `failed` and `cancelled` runs have `finishedAt`; other runs don't
- a step waiting for approval means the run is `paused`
- errored steps carry an error message; other steps don't
- unknown fields are rejected, so raw prompts can't slip into a stored run

`RUN_STATUS_TRANSITIONS` / `canTransitionRun(from, to)` define the run
lifecycle: `queued → running | cancelled`, `running → paused | succeeded |
failed | cancelled`, `paused → running | failed | cancelled`. Terminal statuses
never change again.

`parseRun(input)` validates untrusted input and returns `{ ok, run }` or
`{ ok: false, issues: [{ path, message }] }` without throwing.

`timingSource` is `fixture` for replayed recordings and `measured` for live
runs, so fixture timings are never shown as real measurements.

## Trace events (v1)

`TraceEventInputSchema` is what a worker reports: `step_started` (step `index`,
`kind`, `name`, `tool` for tool steps, `input`) and `step_finished` (`status`,
optional `output`, `error` for failed steps), each with an `evt_` id, a
per-run `sequence`, the `stepId`, `attempt` and `offsetMs` since the run
started. Payloads are JSON objects of at most 16 KB and 12 levels.

`redactTraceEvent(event)` returns the stored form, `TraceEventSchema`: input,
output and error redacted, plus `redactions: [{ path, reason }]`.
`checkTrace(events, budget)` checks a run's whole event list: contiguous
sequences, unique IDs, offsets that never go back, step indexes in order, one
start and one finish per attempt, retries only after a failed attempt (same
index, kind, name and tool), and the run's step, retry and duration budget.

## Redaction

`redactJson(value, path?)` and `redactText(text)` replace sensitive data with
`[REDACTED:<reason>]` (`secret`, `email`, `card_number`, `phone`,
`personal_id`):

- whole values under sensitive field names (`password`, `*Token`, `apiKey`,
  `authorization`, `email`, `cardNumber`, `phone`, `ssn`, `iban`, …; compared
  case- and separator-insensitively)
- inside any string: bearer tokens, API-key-like secrets, JWTs, email
  addresses, card numbers that pass the Luhn check, and `+`-prefixed phone
  numbers
- object keys that contain such data (e.g. a map keyed by email)

Redaction is deterministic and idempotent, never changes its input, and
reports the path of every replacement. JSON numbers are not scanned: a card or
phone number sent as a number is only caught by its field name.

## Fixtures

`fixtures/runs/valid-*.json` must parse; each `invalid-*.json` must fail with
the issue listed in `test/run.test.ts`.

```sh
pnpm --filter @agentledger/contracts test
```
