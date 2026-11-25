-- CreateEnum
CREATE TYPE "TraceEventType" AS ENUM ('step_started', 'step_finished');

-- CreateTable
CREATE TABLE "trace_events" (
    "run_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "type" "TraceEventType" NOT NULL,
    "attempt" INTEGER NOT NULL,
    "offset_ms" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "redactions" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trace_events_pkey" PRIMARY KEY ("run_id","sequence")
);

-- CreateIndex
CREATE INDEX "trace_events_run_id_step_id_idx" ON "trace_events"("run_id", "step_id");

-- CreateIndex
CREATE INDEX "trace_events_workspace_id_idx" ON "trace_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "trace_events_run_id_id_key" ON "trace_events"("run_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_id_workspace_id_key" ON "agent_runs"("id", "workspace_id");

-- AddForeignKey
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_run_id_workspace_id_fkey" FOREIGN KEY ("run_id", "workspace_id") REFERENCES "agent_runs"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;




-- Trace invariants. Payload rules (redaction, step order) live in the shared
-- contract; the database keeps the structural ones.
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_numbers_check"
  CHECK ("sequence" >= 0 AND "attempt" >= 1 AND "offset_ms" >= 0);
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_ids_check"
  CHECK ("id" ~ '^evt_[a-z0-9]{6,32}$' AND "step_id" ~ '^step_[a-z0-9]{6,32}$');
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_json_check"
  CHECK (jsonb_typeof("data") = 'object' AND jsonb_typeof("redactions") = 'array');

-- Traces are append-only, and only a running or paused run takes new events.
CREATE FUNCTION "trace_events_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_status "RunStatus";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'trace event %/% cannot be changed or deleted', OLD."run_id", OLD."sequence"
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT "status" INTO run_status FROM "agent_runs" WHERE "id" = NEW."run_id";
  IF run_status IS NOT NULL AND run_status NOT IN ('running', 'paused') THEN
    RAISE EXCEPTION 'run % is % and takes no trace events', NEW."run_id", run_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trace_events_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "trace_events"
FOR EACH ROW EXECUTE FUNCTION "trace_events_guard"();
