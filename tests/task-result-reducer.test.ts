import { describe, expect, test } from "vitest";

import { applySubagentTaskReport, parseTaskReport } from "../src/orchestration/task-result-reducer.js";
import { createReadyAssignments } from "../src/orchestration/task-scheduler.js";
import { normalizePlanInput } from "../src/state/plan-validation.js";

function setup() {
  const normalized = normalizePlanInput({
    title: "Plan",
    spec: "Spec",
    phases: [{ id: "main", title: "Main", tasks: [{ id: "task", text: "Do task", criteria: ["Criterion one", "Criterion two"] }] }],
  }, { planId: "plan-1", now: 1 });
  if (!normalized.plan) throw new Error(normalized.errors.join("\n"));
  const plan = normalized.plan;
  const scheduled = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });
  const assignment = scheduled.assignments[0];
  return { plan, assignment };
}

describe("task result reducer", () => {
  test("applies evidence and completes task when all criteria are covered", () => {
    const { plan, assignment } = setup();

    const result = applySubagentTaskReport(plan, {
      planId: plan.id,
      phaseId: assignment.phaseId,
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      status: "completed",
      summary: "Done",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "Evidence one" }, { criteriaIndex: 1, evidence: "Evidence two" }],
      artifacts: [{ label: "notes", path: "notes.md" }],
    }, { now: 3 });

    expect(result.applied).toBe(true);
    expect(plan.phases[0].tasks[0].status).toBe("completed");
    expect(plan.phases[0].status).toBe("completed");
    expect(plan.status).toBe("completed");
    expect(plan.artifacts[0]).toMatchObject({ label: "notes", assignmentId: assignment.id });
  });

  test("puts task into attention when completed report lacks criterion evidence", () => {
    const { plan, assignment } = setup();

    const result = applySubagentTaskReport(plan, {
      planId: plan.id,
      phaseId: assignment.phaseId,
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      status: "completed",
      summary: "Done-ish",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "Evidence one" }],
    }, { now: 3 });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain("Report does not provide evidence for every criterion");
    expect(plan.phases[0].tasks[0].status).toBe("attention");
    expect(plan.status).toBe("attention");
  });

  test("keeps failed reports failed even when all criteria include evidence", () => {
    const { plan, assignment } = setup();

    const result = applySubagentTaskReport(plan, {
      planId: plan.id,
      phaseId: assignment.phaseId,
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      status: "failed",
      summary: "Could not complete safely",
      criteriaEvidence: [
        { criteriaIndex: 0, evidence: "Tried criterion one" },
        { criteriaIndex: 1, evidence: "Tried criterion two" },
      ],
    }, { now: 3 });

    expect(result.applied).toBe(true);
    expect(plan.phases[0].tasks[0].status).toBe("failed");
    expect(plan.status).toBe("failed");
  });

  test("rejects reports for the wrong assignment", () => {
    const { plan, assignment } = setup();

    const result = applySubagentTaskReport(plan, {
      planId: plan.id,
      phaseId: assignment.phaseId,
      taskId: assignment.taskId,
      assignmentId: "wrong",
      status: "completed",
      summary: "Done",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "Evidence" }],
    }, { now: 3 });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain("Assignment wrong not found");
  });

  test("rejects stale reports for non-latest assignments without completing the task", () => {
    const { plan, assignment } = setup();
    assignment.status = "paused";
    const task = plan.phases[0].tasks[0];
    task.status = "ready";
    task.continuation = "Retry";
    const retry = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 4 }).assignments[0];

    const result = applySubagentTaskReport(plan, {
      planId: plan.id,
      phaseId: assignment.phaseId,
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      status: "completed",
      summary: "Old assignment finally finished",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "Old one" }, { criteriaIndex: 1, evidence: "Old two" }],
    }, { now: 5, expectedAssignmentId: assignment.id });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain(`Report assignmentId ${assignment.id} is stale; latest assignment is ${retry.id}`);
    expect(task.status).toBe("running");
    expect(task.criteria.every((criterion) => criterion.satisfied)).toBe(false);
    expect(retry.status).toBe("queued");
  });

  test("parses a balanced task report JSON object embedded in prose", () => {
    const parsed = parseTaskReport('Final report: {"planId":"plan-1","phaseId":"main","taskId":"task","assignmentId":"a1","status":"completed","summary":"Done","criteriaEvidence":[]}');

    expect(parsed?.assignmentId).toBe("a1");
  });

  test.each([
    ["mismatched plan id", { planId: "wrong" }, "Report planId wrong does not match plan-1"],
    ["mismatched phase id", { phaseId: "wrong" }, "Report phaseId wrong does not match main"],
    ["mismatched task id", { taskId: "wrong" }, "Report taskId wrong does not match task"],
    ["invalid status", { status: "cancelled" }, "Report status must be completed, attention, or failed"],
    ["empty summary", { summary: " " }, "Report summary is required"],
    ["missing criteria evidence", { criteriaEvidence: undefined }, "Report criteriaEvidence is required"],
    ["empty criteria evidence", { criteriaEvidence: [] }, "Report criteriaEvidence is required"],
    ["duplicate criteria index", { criteriaEvidence: [{ criteriaIndex: 0, evidence: "one" }, { criteriaIndex: 0, evidence: "two" }] }, "Duplicate criteria index 0"],
    ["non-integer criteria index", { criteriaEvidence: [{ criteriaIndex: 0.5, evidence: "one" }] }, "Criterion index must be an integer"],
    ["out-of-bounds criteria index", { criteriaEvidence: [{ criteriaIndex: 2, evidence: "one" }] }, "Criteria index 2 is out of bounds"],
    ["empty evidence", { criteriaEvidence: [{ criteriaIndex: 0, evidence: " " }] }, "Evidence for criteria index 0 is required"],
  ] as const)("rejects invalid report: %s", (_name, override, expectedError) => {
    const { plan, assignment } = setup();
    const report = {
      planId: plan.id,
      phaseId: assignment.phaseId,
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      status: "completed",
      summary: "Done",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "Evidence one" }, { criteriaIndex: 1, evidence: "Evidence two" }],
      ...override,
    };

    const result = applySubagentTaskReport(plan, report as Parameters<typeof applySubagentTaskReport>[1], { now: 3 });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain(expectedError);
    expect(plan.phases[0].tasks[0].status).toBe("attention");
    expect(plan.status).toBe("attention");
  });
});
