import { describe, expect, it } from "vitest";

import {
  ARCHIVE_TRUNCATION_MARKER,
  MAX_ARCHIVE_ARTIFACT_LABEL_BYTES,
  MAX_ARCHIVE_ARTIFACT_PATH_BYTES,
  MAX_ARCHIVE_CRITERION_EVIDENCE_BYTES,
  MAX_ARCHIVE_CRITERIA_EVIDENCE,
  MAX_ARCHIVE_FOLLOW_UP_BYTES,
  MAX_ARCHIVE_FOLLOW_UPS,
  MAX_ARCHIVE_SUMMARY_BYTES,
  buildCheckpointProjection,
  projectAssignmentArchive,
  projectTaskRun,
  type ArchiveRef,
} from "../src/state/durable-projection.js";
import {
  MAX_ASSIGNMENT_ARCHIVE_BYTES,
  MAX_RECENT_ASSIGNMENT_REFS,
  MAX_RECENT_COMPLETED,
  MAX_RECOVERABLE_TASK_RUNS,
  MAX_TASK_RUN_OBJECT_BYTES,
} from "../src/defaults.js";
import { canonicalJson, utf8Bytes } from "../src/state/canonical-json.js";
import { syntheticState, syntheticTaskRun } from "./persistence-fixtures.js";

function archiveRef(index: number, completedAt = index): ArchiveRef {
  return {
    assignmentId: `assignment-${index}`,
    assignmentIdHash: `hash-${index}`,
    archiveId: `archive-${index}`,
    resultId: `result-${index}`,
    taskRunId: `task-run-${index}`,
    completedAt,
  };
}

describe("durable projection", () => {
  it("strips transient fields without mutating runtime state", () => {
    const run = syntheticTaskRun(1, "running");
    const before = structuredClone(run);
    const result = projectTaskRun(run);

    expect(result).toEqual({ ok: true, value: expect.anything() });
    if (!result.ok) return;
    const assignment = result.value.assignments[0];
    expect(assignment).not.toHaveProperty("currentTool");
    expect(assignment).not.toHaveProperty("lastActionAt");
    expect(assignment).not.toHaveProperty("lastActionSummary");
    expect(assignment).not.toHaveProperty("recentActivity");
    expect(assignment.result).not.toHaveProperty("rawResultPath");
    expect(run).toEqual(before);
  });

  it("rejects a recoverable TaskRun at or above the 2 MiB serialized bound", () => {
    const run = syntheticTaskRun(2, "running");
    run.context = "x".repeat(MAX_TASK_RUN_OBJECT_BYTES);

    const result = projectTaskRun(run);
    expect(result).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });

  it("rejects more than 100 recoverable runs before yielding a projection", () => {
    const state = syntheticState(0);
    state.taskRuns = Array.from({ length: MAX_RECOVERABLE_TASK_RUNS + 1 }, (_, index) => syntheticTaskRun(index + 1, "failed"));
    const before = structuredClone(state);

    expect(buildCheckpointProjection(state, [])).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(state).toEqual(before);
  });

  it("keeps the newest twenty completed summaries and newest thousand exact archive/result references", () => {
    const state = syntheticState(25);
    const archives = Array.from({ length: MAX_RECENT_ASSIGNMENT_REFS + 5 }, (_, index) => archiveRef(index + 1));
    const result = buildCheckpointProjection(state, archives);

    expect(result).toEqual({ ok: true, value: expect.anything() });
    if (!result.ok) return;
    expect(result.value.completedRuns).toHaveLength(MAX_RECENT_COMPLETED);
    expect(result.value.completedRuns.map((summary) => summary.taskRunId)).toEqual(
      Array.from({ length: MAX_RECENT_COMPLETED }, (_, index) => `task-run-${String(25 - index).padStart(3, "0")}`),
    );
    expect(result.value.recentAssignmentRefs).toHaveLength(MAX_RECENT_ASSIGNMENT_REFS);
    expect(result.value.recentAssignmentRefs[0]).toEqual({
      assignmentId: `assignment-${MAX_RECENT_ASSIGNMENT_REFS + 5}`,
      assignmentIdHash: `hash-${MAX_RECENT_ASSIGNMENT_REFS + 5}`,
      archiveId: `archive-${MAX_RECENT_ASSIGNMENT_REFS + 5}`,
      resultId: `result-${MAX_RECENT_ASSIGNMENT_REFS + 5}`,
    });
  });

  it("normalizes archive detail by UTF-8 bytes deterministically", () => {
    const input = {
      assignmentId: "assignment-1",
      taskRunId: "task-run-1",
      groupId: "group-1",
      taskId: "task-1",
      status: "completed" as const,
      summary: "🙂".repeat(MAX_ARCHIVE_SUMMARY_BYTES),
      criteriaEvidence: Array.from({ length: MAX_ARCHIVE_CRITERIA_EVIDENCE + 2 }, (_, criteriaIndex) => ({
        criteriaIndex,
        criterionId: `criterion-${criteriaIndex}`,
        evidence: "界".repeat(100),
      })),
      artifacts: Array.from({ length: 130 }, () => ({
        label: "é".repeat(100),
        path: "界".repeat(100),
        assignmentId: "assignment-1",
        taskRunId: "task-run-1",
        groupId: "group-1",
        taskId: "task-1",
      })),
      followUps: Array.from({ length: MAX_ARCHIVE_FOLLOW_UPS + 2 }, () => "🙂".repeat(100)),
      runId: "run-1",
      resultId: "result-1",
      completedAt: 1,
    };

    const first = projectAssignmentArchive(input);
    const second = projectAssignmentArchive(structuredClone(input));
    expect(first).toEqual(second);
    if (first.detailOmitted) throw new Error("bounded fixture must retain normalized detail");
    expect(first.summary).toContain(ARCHIVE_TRUNCATION_MARKER);
    expect(utf8Bytes(first.summary)).toBeLessThanOrEqual(MAX_ARCHIVE_SUMMARY_BYTES);
    expect(first.criteriaEvidence).toHaveLength(MAX_ARCHIVE_CRITERIA_EVIDENCE);
    expect(first.criteriaEvidence.every((item) => utf8Bytes(item) <= MAX_ARCHIVE_CRITERION_EVIDENCE_BYTES)).toBe(true);
    expect(first.artifacts).toHaveLength(128);
    expect(first.artifacts.every((artifact) => utf8Bytes(artifact.label) <= MAX_ARCHIVE_ARTIFACT_LABEL_BYTES)).toBe(true);
    expect(first.artifacts.every((artifact) => utf8Bytes(artifact.path) <= MAX_ARCHIVE_ARTIFACT_PATH_BYTES)).toBe(true);
    expect(first.followUps).toHaveLength(MAX_ARCHIVE_FOLLOW_UPS);
    expect(first.followUps.every((followUp) => utf8Bytes(followUp) <= MAX_ARCHIVE_FOLLOW_UP_BYTES)).toBe(true);
  });

  it("falls back to metadata only when normalized archive detail remains too large", () => {
    const archive = projectAssignmentArchive({
      assignmentId: "assignment-1",
      taskRunId: "task-run-1",
      taskId: "task-1",
      status: "completed",
      summary: "summary",
      criteriaEvidence: [],
      artifacts: [{
        label: "label",
        path: "path",
        assignmentId: "assignment-1",
        taskRunId: "task-run-1",
        taskId: "x".repeat(MAX_ASSIGNMENT_ARCHIVE_BYTES),
      }],
      followUps: [],
      runId: "run-1",
      resultId: "result-1",
      completedAt: 1,
    });

    expect(archive).toMatchObject({ detailOmitted: true, assignmentId: "assignment-1", resultId: "result-1" });
    expect(archive).not.toHaveProperty("summary");
    expect(canonicalJson(archive).includes("x".repeat(100))).toBe(false);
  });
});
