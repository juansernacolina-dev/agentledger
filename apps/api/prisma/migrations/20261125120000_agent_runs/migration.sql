-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "TimingSource" AS ENUM ('fixture', 'measured');

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "agent_version_id" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "timing_source" "TimingSource" NOT NULL,
    "budget" JSONB NOT NULL,
    "input" JSONB NOT NULL,
    "failure_reason" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_created_at_id_idx" ON "agent_runs"("workspace_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_agent_id_created_at_idx" ON "agent_runs"("workspace_id", "agent_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agent_runs_agent_version_id_idx" ON "agent_runs"("agent_version_id");

-- CreateIndex
CREATE INDEX "agent_runs_created_by_id_idx" ON "agent_runs"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_id_agent_id_workspace_id_key" ON "agent_versions"("id", "agent_id", "workspace_id");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_version_id_agent_id_workspace_id_fkey" FOREIGN KEY ("agent_version_id", "agent_id", "workspace_id") REFERENCES "agent_versions"("id", "agent_id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Run invariants that match the run contract.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_finished_at_check"
  CHECK (("status" IN ('succeeded', 'failed', 'cancelled')) = ("finished_at" IS NOT NULL));
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_finished_after_created_check"
  CHECK ("finished_at" IS NULL OR "finished_at" >= "created_at");
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_started_at_check"
  CHECK (
    ("status" <> 'queued' OR "started_at" IS NULL)
    AND ("status" NOT IN ('running', 'paused', 'succeeded', 'failed') OR "started_at" IS NOT NULL)
    AND ("started_at" IS NULL OR "started_at" >= "created_at")
  );
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_failure_reason_check"
  CHECK (("status" = 'failed') = ("failure_reason" IS NOT NULL));
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_json_object_check"
  CHECK (jsonb_typeof("budget") = 'object' AND jsonb_typeof("input") = 'object');

-- A run keeps pointing at the version it was created for. Only its status and
-- timestamps change, following RUN_STATUS_TRANSITIONS, and runs are never deleted.
CREATE FUNCTION "agent_runs_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent run % cannot be deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."id" <> OLD."id"
    OR NEW."workspace_id" <> OLD."workspace_id"
    OR NEW."agent_id" <> OLD."agent_id"
    OR NEW."agent_version_id" <> OLD."agent_version_id"
    OR NEW."timing_source" <> OLD."timing_source"
    OR NEW."budget" <> OLD."budget"
    OR NEW."input" <> OLD."input"
    OR NEW."created_by_id" <> OLD."created_by_id"
    OR NEW."created_at" <> OLD."created_at"
    OR (OLD."started_at" IS NOT NULL AND NEW."started_at" IS DISTINCT FROM OLD."started_at")
  THEN
    RAISE EXCEPTION 'agent run % may only change its status', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'queued' AND NEW."status" IN ('running', 'cancelled'))
    OR (OLD."status" = 'running' AND NEW."status" IN ('paused', 'succeeded', 'failed', 'cancelled'))
    OR (OLD."status" = 'paused' AND NEW."status" IN ('running', 'failed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'agent run % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "agent_runs_guard"
BEFORE UPDATE OR DELETE ON "agent_runs"
FOR EACH ROW EXECUTE FUNCTION "agent_runs_guard"();
