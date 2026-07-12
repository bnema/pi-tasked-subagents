import { describe, expect, test } from "vitest";

import { applySubagentTaskReport, parseTaskReport } from "../src/orchestration/task-result-reducer.js";
import { createReadyAssignments } from "../src/orchestration/task-scheduler.js";
import { normalizeTaskRunInput } from "../src/state/task-run-validation.js";
import type { SubagentTaskReport } from "../src/types.js";

function setup() {
  const normalized = normalizeTaskRunInput({
    title: "Task run",
    request: "Complete the requested work",
    groups: [{ id: "main", title: "Main" }],
    tasks: [{ id: "task", group: "main", text: "Do task", criteria: ["Criterion one", "Criterion two"] }],
  }, { taskRunId: "task-run-1", now: 1 });
  if (!normalized.taskRun) throw new Error(normalized.errors.join("\n"));
  const taskRun = normalized.taskRun;
  const scheduled = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });
  const assignment = scheduled.assignments[0];
  return { taskRun, assignment, task: taskRun.tasks[0] };
}

function completeReport({ taskRun, assignment }: ReturnType<typeof setup>): SubagentTaskReport {
  return {
    taskRunId: taskRun.id,
    groupId: assignment.groupId,
    taskId: assignment.taskId,
    assignmentId: assignment.id,
    status: "completed",
    summary: "Done",
    criteriaEvidence: [{ criteriaIndex: 0, evidence: "Evidence one" }, { criteriaIndex: 1, evidence: "Evidence two" }],
  };
}

describe("task result reducer", () => {
  test("applies evidence and completes task when all criteria are covered", () => {
    const fixture = setup();
    const { taskRun, assignment } = fixture;

    const result = applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      artifacts: [{ label: "notes", path: "notes.md" }],
    }, { now: 3 });

    expect(result.applied).toBe(true);
    expect(taskRun.tasks[0].status).toBe("completed");
    expect(taskRun.groups[0].status).toBe("completed");
    expect(taskRun.status).toBe("completed");
    expect(taskRun.artifacts[0]).toMatchObject({
      label: "notes",
      assignmentId: assignment.id,
      taskRunId: taskRun.id,
      groupId: "main",
      taskId: "task",
    });
  });

  test("reapplying an assignment report replaces prior evidence and artifacts", () => {
    const fixture = setup();
    const { taskRun, assignment, task } = fixture;

    applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "Old one" }, { criteriaIndex: 1, evidence: "Old two" }],
      artifacts: [{ label: "old", path: "old.md" }],
    }, { now: 3 });
    const result = applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "New one" }, { criteriaIndex: 1, evidence: "New two" }],
      artifacts: [{ label: "new", path: "new.md" }],
    }, { now: 4 });

    expect(result.applied).toBe(true);
    expect(task.criteria[0].evidence).toHaveLength(1);
    expect(task.criteria[0].evidence[0]).toMatchObject({
      assignmentId: assignment.id,
      summary: "New one",
      artifactPath: "new.md",
    });
    expect(taskRun.artifacts).toHaveLength(1);
    expect(taskRun.artifacts[0]).toMatchObject({ label: "new", path: "new.md" });
  });

  test("puts assignment and task into attention when completed report lacks criterion evidence", () => {
    const fixture = setup();
    const { taskRun, assignment, task } = fixture;

    const result = applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "Evidence one" }],
    }, { now: 3 });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain("Report does not provide evidence for every criterion");
    expect(assignment.status).toBe("attention");
    expect(task.status).toBe("attention");
    expect(taskRun.status).toBe("attention");
  });

  test("accepts duplicate completed evidence when every criterion is covered", () => {
    const fixture = setup();
    const { taskRun, assignment, task } = fixture;

    const result = applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      criteriaEvidence: [
        { criteriaIndex: 0, evidence: "Evidence one" },
        { criteriaIndex: 1, evidence: "Evidence two" },
        { criteriaIndex: 1, evidence: "Extra evidence two" },
      ],
    }, { now: 3 });

    expect(result.applied).toBe(true);
    expect(result.warnings).toContain("Duplicate criteria index 1; preserving additional evidence");
    expect(assignment.status).toBe("completed");
    expect(task.status).toBe("completed");
    expect(task.criteria[1].evidence.map((evidence) => evidence.summary)).toEqual(["Evidence two", "Extra evidence two"]);
    expect(taskRun.status).toBe("completed");
  });

  test("rejects malformed taskRunPatch arrays before controller patching", () => {
    const fixture = setup();
    const { taskRun, assignment, task } = fixture;
    task.expansionMode = "append_tasks";

    const result = applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      taskRunPatch: { tasks: {} as never },
    }, { now: 3 });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain("Report taskRunPatch.tasks must be an array");
    expect(assignment.status).toBe("attention");
    expect(task.status).toBe("attention");
  });

  test("rejects malformed taskRunPatch entries before controller patching", () => {
    const fixture = setup();
    const { taskRun, assignment, task } = fixture;
    task.expansionMode = "append_tasks";

    const result = applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      taskRunPatch: { groups: [null] as never, tasks: [null] as never },
    }, { now: 3 });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain("Report taskRunPatch.groups entry 0 must be an object");
    expect(result.errors).toContain("Report taskRunPatch.tasks entry 0 must be an object");
    expect(assignment.status).toBe("attention");
    expect(task.status).toBe("attention");
  });

  test("rejects invalid taskRunPatch task expansion modes before controller patching", () => {
    const fixture = setup();
    const { taskRun, assignment, task } = fixture;
    task.expansionMode = "append_tasks";

    const result = applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      taskRunPatch: { tasks: [{ id: "next", text: "Next task", criteria: ["Done"], expansionMode: "unsupported" as never }] },
    }, { now: 3 });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain("Report taskRunPatch.tasks entry 0 expansionMode must be append_tasks");
    expect(assignment.status).toBe("attention");
    expect(task.status).toBe("attention");
  });

  test("keeps failed reports failed even when all criteria include evidence", () => {
    const fixture = setup();
    const { taskRun, assignment, task } = fixture;

    const result = applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      status: "failed",
      summary: "Could not complete safely",
      criteriaEvidence: [
        { criteriaIndex: 0, evidence: "Tried criterion one" },
        { criteriaIndex: 1, evidence: "Tried criterion two" },
      ],
    }, { now: 3 });

    expect(result.applied).toBe(true);
    expect(assignment.status).toBe("failed");
    expect(task.status).toBe("failed");
    expect(task.criteria[0].evidence[0]?.summary).toBe("Tried criterion one");
    expect(task.criteria.every((criterion) => criterion.satisfied)).toBe(false);
    expect(taskRun.status).toBe("failed");
  });

  test("keeps attention reports in attention and records evidence without satisfying criteria", () => {
    const fixture = setup();
    const { taskRun, assignment, task } = fixture;

    const result = applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      status: "attention",
      summary: "Needs follow-up",
      criteriaEvidence: [
        { criteriaIndex: 0, evidence: "Partial criterion one" },
        { criteriaIndex: 1, evidence: "Partial criterion two" },
      ],
    }, { now: 3 });

    expect(result.applied).toBe(true);
    expect(assignment.status).toBe("attention");
    expect(task.status).toBe("attention");
    expect(task.criteria[0].evidence[0]?.summary).toBe("Partial criterion one");
    expect(task.criteria.every((criterion) => criterion.satisfied)).toBe(false);
    expect(taskRun.status).toBe("attention");
  });

  test.each([
    ["mismatched task run id", { taskRunId: "wrong" }, "Report taskRunId wrong does not match task-run-1"],
    ["mismatched group id", { groupId: "wrong" }, "Report groupId wrong does not match main"],
    ["mismatched task id", { taskId: "wrong" }, "Report taskId wrong does not match task"],
  ] as const)("puts assignment and task into attention for %s", (_name, override, expectedError) => {
    const fixture = setup();
    const { taskRun, assignment, task } = fixture;

    const result = applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      ...override,
    }, { now: 3 });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain(expectedError);
    expect(assignment.status).toBe("attention");
    expect(task.status).toBe("attention");
    expect(taskRun.status).toBe("attention");
  });

  test("puts launched assignment and task into attention for mismatched assignment id", () => {
    const fixture = setup();
    const { taskRun, assignment, task } = fixture;

    const result = applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      assignmentId: "wrong",
    }, { now: 3, expectedAssignmentId: assignment.id });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain(`Report assignmentId wrong does not match launched assignment ${assignment.id}`);
    expect(assignment.status).toBe("attention");
    expect(task.status).toBe("attention");
    expect(taskRun.status).toBe("attention");
  });

  test("rejects stale reports for non-latest assignments without completing the task", () => {
    const fixture = setup();
    const { taskRun, assignment, task } = fixture;
    assignment.status = "paused";
    task.status = "ready";
    task.continuation = "Retry";
    const retry = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 4 }).assignments[0];

    const result = applySubagentTaskReport(taskRun, completeReport(fixture), { now: 5, expectedAssignmentId: assignment.id });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain(`Report assignmentId ${assignment.id} is stale; latest assignment is ${retry.id}`);
    expect(assignment.status).toBe("paused");
    expect(assignment.supersededByAssignmentId).toBe(retry.id);
    expect(task.status).toBe("running");
    expect(task.criteria.every((criterion) => criterion.satisfied)).toBe(false);
    expect(retry.status).toBe("queued");
  });

  test("parses a balanced task report JSON object embedded in prose", () => {
    const parsed = parseTaskReport('Final report: {"taskRunId":"task-run-1","groupId":"main","taskId":"task","assignmentId":"a1","status":"completed","summary":"Done","criteriaEvidence":[]}');

    expect(parsed?.taskRunId).toBe("task-run-1");
    expect(parsed?.groupId).toBe("main");
    expect(parsed?.assignmentId).toBe("a1");
  });

  test("parses a later balanced task report JSON object after an earlier non-report object", () => {
    const parsed = parseTaskReport('Ignore {"not":"a report"} then {"taskRunId":"task-run-1","groupId":"main","taskId":"task","assignmentId":"a2","status":"completed","summary":"Done","criteriaEvidence":[]}');

    expect(parsed?.assignmentId).toBe("a2");
  });

  test("parses a later fenced task report after an earlier non-report fence", () => {
    const parsed = parseTaskReport('```json\n{"not":"a report"}\n```\n```json\n{"taskRunId":"task-run-1","groupId":"main","taskId":"task","assignmentId":"a3","status":"completed","summary":"Done","criteriaEvidence":[]}\n```');

    expect(parsed?.assignmentId).toBe("a3");
  });

  test.each([
    ["invalid status", { status: "cancelled" }, "Report status must be completed, attention, or failed"],
    ["empty summary", { summary: " " }, "Report summary is required"],
    ["missing criteria evidence", { criteriaEvidence: undefined }, "Report criteriaEvidence is required"],
    ["empty criteria evidence", { criteriaEvidence: [] }, "Report criteriaEvidence is required"],
    ["non-integer criteria index", { criteriaEvidence: [{ criteriaIndex: 0.5, evidence: "one" }] }, "Criterion index must be an integer"],
    ["out-of-bounds criteria index", { criteriaEvidence: [{ criteriaIndex: 2, evidence: "one" }] }, "Criteria index 2 is out of bounds"],
    ["empty evidence", { criteriaEvidence: [{ criteriaIndex: 0, evidence: " " }] }, "Evidence for criteria index 0 is required"],
    ["malformed criteria evidence entry", { criteriaEvidence: [null] }, "Criteria evidence entry 0 must be an object"],
    ["non-string evidence", { criteriaEvidence: [{ criteriaIndex: 0, evidence: 42 }] }, "Evidence for criteria index 0 is required"],
    ["non-array artifacts", { artifacts: "notes.md" }, "Report artifacts must be an array"],
    ["malformed artifact entry", { artifacts: [null] }, "Artifact entry 0 must be an object"],
    ["non-string artifact label", { artifacts: [{ label: 42, path: "notes.md" }] }, "Artifact label for entry 0 is required"],
    ["non-string artifact path", { artifacts: [{ label: "notes", path: 42 }] }, "Artifact path for entry 0 is required"],
    ["non-array follow-ups", { followUps: "todo" }, "Report followUps must be an array"],
    ["malformed follow-up entry", { followUps: [42] }, "Follow-up entry 0 must be a string"],
  ] as const)("rejects invalid report: %s", (_name, override, expectedError) => {
    const fixture = setup();
    const { taskRun, assignment, task } = fixture;

    const result = applySubagentTaskReport(taskRun, {
      ...completeReport(fixture),
      ...override,
    } as Parameters<typeof applySubagentTaskReport>[1], { now: 3 });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain(expectedError);
    expect(assignment.status).toBe("attention");
    expect(task.status).toBe("attention");
    expect(taskRun.status).toBe("attention");
  });
});
