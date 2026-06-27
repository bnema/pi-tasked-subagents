import { describe, expect, test } from "vitest";

import type { SetTasksInput, TaskAssignmentRecord, TaskRunRecord } from "../src/types.js";
import {
  applyAssignmentProgress,
  createReadyAssignments,
  deriveTaskRunStatus,
  toLaunchTaskEntries,
} from "../src/orchestration/task-scheduler.js";
import { normalizeTaskRunInput } from "../src/state/task-run-validation.js";

function makeTaskRun(input: Partial<SetTasksInput> = {}): TaskRunRecord {
  const result = normalizeTaskRunInput({
    title: "Task run",
    request: "Complete the requested work",
    tasks: [{ id: "one", text: "Do one", criteria: ["One done"] }],
    ...input,
  }, { taskRunId: "task-run-1", now: 1 });
  if (!result.taskRun) throw new Error(result.errors.join("\n"));
  return result.taskRun;
}

function task(taskRun: TaskRunRecord, taskId: string) {
  const found = taskRun.tasks.find((candidate) => candidate.id === taskId);
  if (!found) throw new Error(`Missing task ${taskId}`);
  return found;
}

function completeAssignment(taskRun: TaskRunRecord, assignment: TaskAssignmentRecord, timestamp = 3): void {
  const assignedTask = task(taskRun, assignment.taskId);
  assignment.status = "completed";
  assignment.result = {
    assignmentId: assignment.id,
    status: "completed",
    summary: `${assignment.taskId} done`,
    criteriaEvidence: assignedTask.criteria.map((criterion, criteriaIndex) => ({
      criteriaIndex,
      criterionId: criterion.id,
      evidence: `${criterion.text} evidence`,
    })),
    artifacts: [],
    followUps: [],
    createdAt: timestamp,
  };
  for (const criterion of assignedTask.criteria) criterion.satisfied = true;
  assignedTask.status = "completed";
  assignedTask.completedAt = timestamp;
}

describe("task scheduler", () => {
  test("creates one assignment for a one-task task run", () => {
    const taskRun = makeTaskRun();
    const result = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({
      taskRunId: "task-run-1",
      taskId: "one",
      agent: "delegate",
      status: "queued",
    });
    expect(result.assignments[0].groupId).toBeUndefined();
    expect(task(taskRun, "one").assignmentIds).toEqual([result.assignments[0].id]);
  });

  test("group dependsOn blocks until dependency group completed", () => {
    const taskRun = makeTaskRun({
      groups: [
        { id: "setup", title: "Setup" },
        { id: "deploy", title: "Deploy", dependsOn: ["setup"] },
      ],
      tasks: [
        { id: "build", group: "setup", text: "Build", criteria: ["Built"] },
        { id: "ship", group: "deploy", text: "Ship", criteria: ["Shipped"] },
      ],
    });

    const first = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });

    expect(first.assignments.map((assignment) => assignment.taskId)).toEqual(["build"]);
    expect(task(taskRun, "ship").status).toBe("pending");
    expect(taskRun.groups.find((group) => group.id === "deploy")?.status).toBe("pending");

    completeAssignment(taskRun, first.assignments[0], 3);
    deriveTaskRunStatus(taskRun, 3);
    const second = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 4 });

    expect(taskRun.groups.find((group) => group.id === "setup")?.status).toBe("completed");
    expect(second.assignments.map((assignment) => assignment.taskId)).toEqual(["ship"]);
  });

  test("omitted group maxConcurrency dispatches one ready task at a time", () => {
    const taskRun = makeTaskRun({
      groups: [{ id: "main", title: "Main" }],
      tasks: [
        { id: "one", group: "main", text: "Do one", criteria: ["One done"] },
        { id: "two", group: "main", text: "Do two", criteria: ["Two done"] },
      ],
    });

    const result = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });

    expect(result.assignments.map((assignment) => assignment.taskId)).toEqual(["one"]);
  });

  test("omitted group maxConcurrency keeps declaration order with explicit dependencies", () => {
    const taskRun = makeTaskRun({
      groups: [{ id: "main", title: "Main" }],
      tasks: [
        { id: "one", group: "main", text: "Do one", criteria: ["One done"] },
        { id: "two", group: "main", text: "Do two", criteria: ["Two done"] },
        { id: "three", group: "main", text: "Do three", dependsOn: ["one"], criteria: ["Three done"] },
      ],
    });

    const first = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });
    expect(first.assignments.map((assignment) => assignment.taskId)).toEqual(["one"]);

    completeAssignment(taskRun, first.assignments[0], 3);
    task(taskRun, "two").status = "attention";
    deriveTaskRunStatus(taskRun, 4);

    expect(task(taskRun, "three").status).toBe("blocked");
    const next = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 5 });
    expect(next.assignments).toEqual([]);
  });

  test("group maxConcurrency:2 dispatches two independent tasks", () => {
    const taskRun = makeTaskRun({
      groups: [{ id: "main", title: "Main", maxConcurrency: 2 }],
      tasks: [
        { id: "one", group: "main", text: "Do one", criteria: ["One done"] },
        { id: "two", group: "main", text: "Do two", criteria: ["Two done"] },
      ],
    });

    const result = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });

    expect(result.assignments.map((assignment) => assignment.taskId)).toEqual(["one", "two"]);
  });

  test("ungrouped tasks without task-run maxConcurrency dispatch sequentially by declaration order", () => {
    const taskRun = makeTaskRun({
      tasks: [
        { id: "one", text: "Do one", criteria: ["One done"] },
        { id: "two", text: "Do two", criteria: ["Two done"] },
        { id: "three", text: "Do three", criteria: ["Three done"] },
      ],
    });

    const first = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });

    expect(first.assignments.map((assignment) => assignment.taskId)).toEqual(["one"]);
    expect(task(taskRun, "two").status).toBe("pending");
    expect(task(taskRun, "three").status).toBe("pending");

    completeAssignment(taskRun, first.assignments[0], 3);
    const second = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 4 });

    expect(second.assignments.map((assignment) => assignment.taskId)).toEqual(["two"]);
    expect(task(taskRun, "three").status).toBe("pending");
  });

  test("ungrouped tasks without task-run maxConcurrency keep declaration order with explicit dependencies", () => {
    const taskRun = makeTaskRun({
      tasks: [
        { id: "one", text: "Do one", criteria: ["One done"] },
        { id: "two", text: "Do two", dependsOn: ["one"], criteria: ["Two done"] },
        { id: "three", text: "Do three", dependsOn: ["one"], criteria: ["Three done"] },
      ],
    });

    const first = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });
    expect(first.assignments.map((assignment) => assignment.taskId)).toEqual(["one"]);
    completeAssignment(taskRun, first.assignments[0], 3);
    const second = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 4 });

    expect(second.assignments.map((assignment) => assignment.taskId)).toEqual(["two"]);
    expect(task(taskRun, "three").status).toBe("pending");
  });

  test("ungrouped tasks obey task dependencies and task-run maxConcurrency", () => {
    const taskRun = makeTaskRun({
      maxConcurrency: 2,
      tasks: [
        { id: "one", text: "Do one", criteria: ["One done"] },
        { id: "two", text: "Do two", dependsOn: ["one"], criteria: ["Two done"] },
        { id: "three", text: "Do three", criteria: ["Three done"] },
      ],
    });

    const result = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });

    expect(result.assignments.map((assignment) => assignment.taskId)).toEqual(["one", "three"]);
    expect(task(taskRun, "two").status).toBe("pending");
  });

  test("surfaces skipped assignments as blocked group recovery", () => {
    const taskRun = makeTaskRun({
      groups: [{ id: "main", title: "Main" }],
      tasks: [{ id: "one", group: "main", text: "Do one", criteria: ["One done"] }],
    });
    const result = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });
    result.assignments[0].status = "skipped";

    deriveTaskRunStatus(taskRun, 3);

    expect(task(taskRun, "one").status).toBe("blocked");
    expect(taskRun.groups[0].status).toBe("blocked");
    expect(taskRun.status).toBe("attention");
  });

  test("keeps a mixed completed and blocked group blocked for recovery", () => {
    const taskRun = makeTaskRun({
      groups: [{ id: "main", title: "Main", maxConcurrency: 2 }],
      tasks: [
        { id: "one", group: "main", text: "Do one", criteria: ["One done"] },
        { id: "two", group: "main", text: "Do two", criteria: ["Two done"] },
      ],
    });
    const result = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });
    const [completedAssignment, skippedAssignment] = result.assignments;
    completeAssignment(taskRun, completedAssignment, 2);
    skippedAssignment.status = "skipped";

    deriveTaskRunStatus(taskRun, 3);

    expect(taskRun.tasks.map((candidate) => candidate.status)).toEqual(["completed", "blocked"]);
    expect(taskRun.groups[0].status).toBe("blocked");
    expect(taskRun.status).toBe("attention");
  });

  test("blocks downstream task when dependency needs attention", () => {
    const taskRun = makeTaskRun({
      maxConcurrency: 2,
      tasks: [
        { id: "one", text: "Do one", criteria: ["One done"] },
        { id: "two", text: "Do two", dependsOn: ["one"], criteria: ["Two done"] },
      ],
    });
    task(taskRun, "one").status = "attention";

    deriveTaskRunStatus(taskRun, 3);

    expect(task(taskRun, "two").status).toBe("blocked");
  });

  test("unblocks downstream blocked tasks from the real prior attention group state", () => {
    const taskRun = makeTaskRun({
      groups: [{ id: "main", title: "Main", maxConcurrency: 2 }],
      tasks: [
        { id: "one", group: "main", text: "Do one", criteria: ["One done"] },
        { id: "two", group: "main", text: "Do two", dependsOn: ["one"], criteria: ["Two done"] },
      ],
    });
    const one = task(taskRun, "one");
    const two = task(taskRun, "two");
    one.status = "attention";
    deriveTaskRunStatus(taskRun, 3);
    expect(taskRun.groups[0].status).toBe("attention");
    expect(two.status).toBe("blocked");

    one.status = "completed";
    one.criteria[0].satisfied = true;
    deriveTaskRunStatus(taskRun, 4);

    expect(taskRun.groups[0].status).toBe("ready");
    expect(two.status).toBe("ready");
  });

  test("continues scheduling independent ready tasks in an attention group", () => {
    const taskRun = makeTaskRun({
      groups: [{ id: "main", title: "Main", maxConcurrency: 2 }],
      tasks: [
        { id: "one", group: "main", text: "Do one", criteria: ["One done"] },
        { id: "two", group: "main", text: "Do two", criteria: ["Two done"] },
        { id: "three", group: "main", text: "Do three", criteria: ["Three done"] },
      ],
    });
    task(taskRun, "one").status = "attention";
    const two = task(taskRun, "two");
    two.status = "completed";
    two.criteria[0].satisfied = true;
    task(taskRun, "three").status = "ready";
    deriveTaskRunStatus(taskRun, 3);
    expect(taskRun.groups[0].status).toBe("attention");

    const result = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 4 });

    expect(result.assignments.map((assignment) => assignment.taskId)).toEqual(["three"]);
  });

  test("adds continuation instructions to the next assignment prompt", () => {
    const taskRun = makeTaskRun();
    const assignedTask = task(taskRun, "one");
    assignedTask.status = "ready";
    assignedTask.continuation = "Retry with the missing evidence.";

    const result = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });

    expect(result.assignments[0].prompt).toContain("Retry with the missing evidence.");
    expect(assignedTask.continuation).toBeUndefined();
  });

  test("does not relaunch a task whose assignment completed before evidence was reduced", () => {
    const taskRun = makeTaskRun();
    const first = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });
    first.assignments[0].status = "completed";

    deriveTaskRunStatus(taskRun, 3);
    const second = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 4 });

    expect(task(taskRun, "one").status).toBe("running");
    expect(second.assignments).toEqual([]);
  });

  test("creates launch entries with task-run and group identifiers", () => {
    const taskRun = makeTaskRun({
      groups: [{ id: "main", title: "Main", maxConcurrency: 2 }],
      tasks: [
        { id: "one", group: "main", text: "Do one", criteria: ["One done"] },
        { id: "two", group: "main", text: "Do two", dependsOn: ["one"], criteria: ["Two done"] },
      ],
    });
    const ready = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 });

    const entries = toLaunchTaskEntries(ready.assignments, taskRun, { defaultCwd: "/repo" });

    expect(entries[0]).toMatchObject({
      assignmentId: ready.assignments[0].id,
      taskRunId: "task-run-1",
      groupId: "main",
      taskId: "one",
      outputMode: "json",
      outputSchema: "SubagentTaskReport JSON object",
      cwd: "/repo",
    });
  });

  test.each(["queued", "running", "completed", "failed", "skipped", "cancelled"] as const)("applies %s assignment progress", (status) => {
    const taskRun = makeTaskRun();
    const assignment = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 }).assignments[0];
    assignment.status = "queued";

    const changed = applyAssignmentProgress(taskRun, {
      runId: "run-1",
      status: "running",
      steps: [{ id: assignment.id, status }],
    }, 3);

    expect(changed).toBe(true);
    expect(assignment.status).toBe(status);
    expect(assignment.updatedAt).toBe(3);
  });

  test("applies assignment progress activity fields", () => {
    const taskRun = makeTaskRun();
    const assignment = createReadyAssignments(taskRun, { defaultAgent: "delegate", defaultCwd: "/repo", now: 2 }).assignments[0];

    applyAssignmentProgress(taskRun, {
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
