# Local infrastructure

`compose.yaml` at the repository root starts the two services AgentLedger needs during development:

| Service | Image | Host port | Used for |
|---|---|---|---|
| `postgres` | `postgres:16.6-alpine` | `127.0.0.1:5432` | Workspaces, agent versions, runs, traces, evaluations (via Prisma) |
| `redis` | `redis:7.4.1-alpine` | `127.0.0.1:6379` | Run queue (BullMQ) |

Ports are bound to `127.0.0.1` only, so the services are not reachable from other machines.

## Usage

```bash
cp .env.example .env        # then set POSTGRES_PASSWORD
docker compose up -d
docker compose ps           # both services should report "healthy"
```

Stop with `docker compose down`. Add `-v` to also delete the data volumes.

## Notes

- On first start, `infra/postgres/init/01-test-database.sql` creates an `agentledger_test` database for integration tests. Init scripts only run on an empty volume; run `docker compose down -v` to re-run them.
- Redis runs with append-only persistence and `maxmemory-policy noeviction`, which BullMQ requires so queued runs are never evicted.
- `DATABASE_URL`, `TEST_DATABASE_URL` and `REDIS_URL` in `.env.example` match the defaults above. Change them together if you change ports or credentials.
