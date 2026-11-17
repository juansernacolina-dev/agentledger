# AgentLedger

**Evaluation and governance for AI agents.** AgentLedger runs the same evaluation suite against two versions of an agent and shows the exact trace, assertion and tool decision behind every regression.

> **Status:** early development, following a 6-week roadmap (see below). The core demo runs on synthetic fixtures and needs no paid model API key.

## The problem

A faster agent isn't necessarily a better one. When a team ships a new agent version, they need to know:

- which test cases got worse, and why
- which step or tool call caused the failure
- whether a sensitive action was attempted without review
- whether a run stayed within its budget

AgentLedger answers these with recorded traces, repeatable assertions and side-by-side version comparisons.

## Demo workflow

1. Run two fictional support-agent versions on the same 20 cases
2. See that the faster version fails three policy assertions
3. Drill into the failing tool step in the trace
4. Find a sensitive mock action paused, waiting for human approval

## Planned features

- Versioned agents, runs, steps and evaluation results
- Trace waterfall with redacted inputs and outputs, step durations and failures
- Repeatable fixture-based assertions for schemas, expected values, citations and tool policy
- Version comparison and a regression view
- Honest labeling of fixture-based timing and estimated cost
- Human review inbox for sensitive mock tool requests, with an audit trail
- Run budgets, timeouts and bounded retries

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, TypeScript |
| API | Fastify |
| Database | PostgreSQL, Prisma |
| Queue | Redis, BullMQ |
| Validation | Zod |
| Testing | Vitest, Playwright |
| Observability | OpenTelemetry (optional) |

## Architecture

```mermaid
flowchart LR
  Suite[Agent version + fixture suite] --> Worker[Run worker]
  Worker --> Trace[Redacted trace]
  Trace --> Assert[Deterministic assertions]
  Assert --> Report[Comparison report]
  Worker -. sensitive request .-> Review[Human review inbox]
```

**Core entities:** Workspace, AgentDefinition, AgentVersion, AgentRun, AgentStep, ToolInvocation, EvaluationSuite, EvaluationCase, AssertionResult, ApprovalRequest, AuditEntry.

## Design rules

- Agent versions are immutable, and every run links to exactly one version.
- Sensitive inputs and outputs are redacted before they are stored.
- Trace content is untrusted and can never authorize an action.
- Sensitive actions stay paused until an authorized person decides.
- Over-budget runs stop and report why.
- Workspaces are fully isolated from each other.

## Roadmap

| Week | Focus | Status |
|---|---|---|
| Week 1 | **W01-01 + CI** — Scaffold pnpm workspace with web, api and worker packages, add shared run contract with valid and invalid fixture tests, add Compose stack for PostgreSQL and Redis | Planned |
| Week 2 | **Runs & traces** — Add Fastify API with Prisma schema for workspaces and roles, add immutable agent versions, store runs linked to versions, add trace events with redaction | Planned |
| Week 3 | **Run views** — Add run detail and trace endpoints, add run list, add trace waterfall | Planned |
| Week 4 | **Evaluations** — Add evaluation suites and assertions, add fixture runner, compare agent versions, add regression view | Planned |
| Week 5 | **Safety & limits** — Pause sensitive mock actions for approval, add review inbox and audit trail, enforce budgets and bounded retries | Planned |
| Week 6 | **Release** — Instrument API and worker with OpenTelemetry, add recovery guide and provider settings, add release images, add end-to-end tests and API docs | Planned |

## Getting started

Setup instructions will be added once the first packages are in place.
