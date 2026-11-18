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

`parseRun(input)` validates untrusted input and returns `{ ok, run }` or
`{ ok: false, issues: [{ path, message }] }` without throwing.

`timingSource` is `fixture` for replayed recordings and `measured` for live
runs, so fixture timings are never shown as real measurements.

## Fixtures

`fixtures/runs/valid-*.json` must parse; each `invalid-*.json` must fail with
the issue listed in `test/run.test.ts`.

```sh
pnpm --filter @agentledger/contracts test
```
