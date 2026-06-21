import { describe, expect, test } from "vitest";

import type { PlanPhaseInput } from "../src/types.js";
import { applyAssignmentProgress, createReadyAssignments, derivePlanStatus } from "../src/orchestration/task-scheduler.js";
import { normalizePlanInput } from "../src/state/plan-validation.js";

function makePlan(phases: PlanPhaseInput[] = [
  { id: "main", title: "Main", tasks: [{ id: "one", text: "Do one", criteria: ["One done"] }] },
]) {
  const result = normalizePlanInput({ title: "Plan", spec: "Spec", phases }, { planId: "plan-1", now: 1 });
  if (!result.plan) throw new Error(result.errors.join("\n"));
  return result.plan;
}

describe("task scheduler", () => {
  test("creates one assignment for a one-task plan", () => {
    const plan = makePlan();
    const result = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({ planId: "plan-1", phaseId: "main", taskId: "one", agent: "delegate", status: "queued" });
    expect(plan.phases[0].tasks[0].assignmentIds).toEqual([result.assignments[0].id]);
  });

  test("runs tasks sequentially by default inside a phase", () => {
    const plan = makePlan([{ id: "main", title: "Main", tasks: [
      { id: "one", text: "Do one", criteria: ["One done"] },
      { id: "two", text: "Do two", criteria: ["Two done"] },
    ] }]);

    const result = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });

    expect(result.assignments.map((assignment) => assignment.taskId)).toEqual(["one"]);
  });

  test("surfaces skipped assignments as blocked phase recovery", () => {
    const plan = makePlan();
    const result = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });
    result.assignments[0].status = "skipped";

    derivePlanStatus(plan, 3);

    expect(plan.phases[0].tasks[0].status).toBe("blocked");
    expect(plan.phases[0].status).toBe("blocked");
    expect(plan.status).toBe("attention");
  });

  test("keeps a mixed completed and blocked phase blocked for recovery", () => {
    const plan = makePlan([{ id: "main", title: "Main", maxConcurrency: 2, tasks: [
      { id: "one", text: "Do one", criteria: ["One done"] },
      { id: "two", text: "Do two", criteria: ["Two done"] },
    ] }]);
    const result = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });
    const [completedAssignment, skippedAssignment] = result.assignments;
    completedAssignment.status = "completed";
    completedAssignment.result = {
      assignmentId: completedAssignment.id,
      status: "completed",
      summary: "one done",
      criteriaEvidence: [{ criteriaIndex: 0, criterionId: plan.phases[0].tasks[0].criteria[0].id, evidence: "one evidence" }],
      artifacts: [],
      followUps: [],
      createdAt: 2,
    };
    plan.phases[0].tasks[0].criteria[0].satisfied = true;
    skippedAssignment.status = "skipped";

    derivePlanStatus(plan, 3);

    expect(plan.phases[0].tasks.map((task) => task.status)).toEqual(["completed", "blocked"]);
    expect(plan.phases[0].status).toBe("blocked");
    expect(plan.status).toBe("attention");
  });

  test("respects phase maxConcurrency for parallel tasks", () => {
    const plan = makePlan([{ id: "main", title: "Main", maxConcurrency: 2, tasks: [
      { id: "one", text: "Do one", criteria: ["One done"] },
      { id: "two", text: "Do two", criteria: ["Two done"] },
    ] }]);

    const result = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });

    expect(result.assignments.map((assignment) => assignment.taskId)).toEqual(["one", "two"]);
  });

  test("blocks downstream task when dependency needs attention", () => {
    const plan = makePlan([{ id: "main", title: "Main", maxConcurrency: 2, tasks: [
      { id: "one", text: "Do one", criteria: ["One done"] },
      { id: "two", text: "Do two", dependsOn: ["one"], criteria: ["Two done"] },
    ] }]);
    plan.phases[0].tasks[0].status = "attention";

    derivePlanStatus(plan, 3);

    expect(plan.phases[0].tasks[1].status).toBe("blocked");
  });

  test("unblocks downstream blocked tasks from the real prior attention phase state", () => {
    const plan = makePlan([{ id: "main", title: "Main", maxConcurrency: 2, tasks: [
      { id: "one", text: "Do one", criteria: ["One done"] },
      { id: "two", text: "Do two", dependsOn: ["one"], criteria: ["Two done"] },
    ] }]);
    const [one, two] = plan.phases[0].tasks;
    one.status = "attention";
    derivePlanStatus(plan, 3);
    expect(plan.phases[0].status).toBe("attention");
    expect(two.status).toBe("blocked");

    one.status = "completed";
    one.criteria[0].satisfied = true;
    derivePlanStatus(plan, 4);

    expect(plan.phases[0].status).toBe("ready");
    expect(two.status).toBe("ready");
  });

  test("continues scheduling independent ready tasks in an attention phase", () => {
    const plan = makePlan([{ id: "main", title: "Main", maxConcurrency: 2, tasks: [
      { id: "one", text: "Do one", criteria: ["One done"] },
      { id: "two", text: "Do two", criteria: ["Two done"] },
      { id: "three", text: "Do three", criteria: ["Three done"] },
    ] }]);
    const [one, two, three] = plan.phases[0].tasks;
    one.status = "attention";
    two.status = "completed";
    two.criteria[0].satisfied = true;
    three.status = "ready";
    derivePlanStatus(plan, 3);
    expect(plan.phases[0].status).toBe("attention");

    const result = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 4 });

    expect(result.assignments.map((assignment) => assignment.taskId)).toEqual(["three"]);
  });

  test("adds continuation instructions to the next assignment prompt", () => {
    const plan = makePlan();
    const task = plan.phases[0].tasks[0];
    task.status = "ready";
    task.continuation = "Retry with the missing evidence.";

    const result = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });

    expect(result.assignments[0].prompt).toContain("Retry with the missing evidence.");
    expect(task.continuation).toBeUndefined();
  });

  test("does not relaunch a task whose assignment completed before evidence was reduced", () => {
    const plan = makePlan();
    const first = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });
    first.assignments[0].status = "completed";

    derivePlanStatus(plan, 3);
    const second = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 4 });

    expect(plan.phases[0].tasks[0].status).toBe("running");
    expect(second.assignments).toEqual([]);
  });

  test.each(["queued", "running", "completed", "failed", "skipped", "cancelled"] as const)("applies %s assignment progress", (status) => {
    const plan = makePlan();
    const assignment = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 }).assignments[0];
    assignment.status = "queued";

    const changed = applyAssignmentProgress(plan, {
      runId: "run-1",
      status: "running",
      steps: [{ id: assignment.id, status }],
    }, 3);

    expect(changed).toBe(true);
    expect(assignment.status).toBe(status);
    expect(assignment.updatedAt).toBe(3);
  });

  test("applies assignment progress activity fields", () => {
    const plan = makePlan();
    const assignment = createReadyAssignments(plan, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 }).assignments[0];

    applyAssignmentProgress(plan, {
      runId: "run-1",
      status: "running",
      steps: [{
        id: assignment.id,
        status: "running",
        currentTool: "bash",
        lastActionAt: 10,
        lastActionSummary: "reading controller",
        recentActivity: ["one", "two", "three", "four"],
      }],
    }, 3);

    expect(assignment.currentTool).toBe("bash");
    expect(assignment.lastActionAt).toBe(10);
    expect(assignment.lastActionSummary).toBe("reading controller");
    expect(assignment.recentActivity).toEqual(["two", "three", "four"]);
  });
});
