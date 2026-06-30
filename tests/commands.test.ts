import { describe, expect, test } from "vitest";

import { buildHelpText, formatAgentsReport, formatAttachReport, formatInspectReport, formatResultReport, formatStatusReport, parseCommand, parseDispatchArgs, resolveResultAssignmentId } from "../src/orchestration/commands.js";
import type { TaskedSubagentsState } from "../src/types.js";

const state: TaskedSubagentsState = {
  version: 4,
  currentTaskRunId: "task-run-1",
  updatedAt: 1,
  taskRuns: [{
    id: "task-run-1",
    title: "Task run",
    request: "Do it",
    context: "Spec",
    status: "running",
    groups: [{
      id: "main",
      title: "Main",
      status: "running",
      dependsOn: [],
      maxConcurrency: 1,
      createdAt: 1,
      updatedAt: 1,
    }],
    tasks: [{
      id: "task",
      groupId: "main",
      text: "Do task",
      status: "running",
      criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }],
      dependsOn: [],
      assignmentIds: ["a1"],
      createdAt: 1,
      updatedAt: 1,
    }],
    assignments: [{
      id: "a1",
      taskRunId: "task-run-1",
      groupId: "main",
      taskId: "task",
      agent: "delegate",
      prompt: "Do task",
      status: "running",
      runId: "run-1",
      createdAt: 1,
      updatedAt: 1,
    }],
    artifacts: [],
    createdAt: 1,
    updatedAt: 1,
  }],
};

describe("commands", () => {
  test("parses TaskRun-first commands and rejects run command", () => {
    expect(parseCommand("status task-run-1")).toEqual({ action: "status", targetId: "task-run-1" });
    expect(parseCommand("continue task fix it")).toEqual({ action: "continue", targetId: "task", prompt: "fix it" });
    expect(parseCommand("resolve a1 fixed in commit abc123")).toEqual({ action: "resolve", targetId: "a1", prompt: "fixed in commit abc123" });
    expect(parseCommand("attach task-run-1")).toEqual({ action: "attach", targetId: "task-run-1" });
    expect(parseCommand("wait task-run-1")).toEqual({ action: "help" });
    expect(parseCommand("resolve task")).toEqual({ action: "help" });
    expect(parseCommand("run do arbitrary prompt")).toEqual({ action: "help" });
  });

  test("parses dispatch arguments and rejects unsupported values", () => {
    expect(parseCommand("dispatch taskRunId=task-run-1 maxConcurrency=2 wait=true")).toEqual({
      action: "dispatch",
      args: { taskRunId: "task-run-1", maxConcurrency: "2", wait: "true" },
    });
    expect(parseDispatchArgs({ taskRunId: " task-run-1 ", maxConcurrency: "2", wait: "true" })).toEqual({
      taskRunId: "task-run-1",
      maxConcurrency: 2,
      wait: true,
      errors: [],
    });
    expect(parseDispatchArgs(parseCommand("dispatch foo").args)).toEqual({
      errors: ["Unsupported dispatch argument: foo"],
    });
    expect(parseDispatchArgs({ maxConcurrency: "0" })).toEqual({
      errors: ["dispatch maxConcurrency must be a positive integer"],
    });
    expect(parseDispatchArgs({ maxConcurrency: "9007199254740993" })).toEqual({
      errors: ["dispatch maxConcurrency must be a positive integer"],
    });
  });

  test("formats status for task runs, groups, tasks, and assignments", () => {
    expect(formatStatusReport(state)).toContain("Task runs: 1 total");
    expect(formatStatusReport(state, "main")).toContain("Group: main");
    expect(formatStatusReport(state, "task")).toContain("criteria: 0/1 satisfied");
    expect(formatInspectReport(state, "a1")).toContain("Assignment: a1");
  });

  test("taskRun and group inspect expose full checklist and task assignment ids", () => {
    const taskRunInspect = formatInspectReport(state, "task-run-1");
    expect(taskRunInspect).toContain("Checklist:");
    expect(taskRunInspect).toContain("TaskRun task-run-1");
    expect(taskRunInspect).toContain("Do task");
    expect(taskRunInspect).toContain("a1");
    expect(taskRunInspect).toContain("task · RUNNING · a1 · Do task");
    expect(formatInspectReport(state, "main")).toContain("task · RUNNING · a1 · Do task");
  });

  test("help documents TaskRun result, attach targets, and wait mode", () => {
    const help = buildHelpText();
    expect(help).toContain("/tasked-subagents result <taskRunId|groupId|taskId|assignmentId>");
    expect(help).toContain("/tasked-subagents attach [taskRunId|groupId|taskId|assignmentId]");
    expect(help).toContain("wait=true");
    expect(help).not.toContain("alias: wait");
  });

  test("attach report does not claim success for unknown targets", () => {
    expect(formatAttachReport(state, "missing-target")).toBe("Attach target not found: missing-target.");
  });

  test("result target resolution accepts taskRun, group, task, and assignment ids when unambiguous", () => {
    expect(resolveResultAssignmentId(state, "task-run-1")).toBe("a1");
    expect(resolveResultAssignmentId(state, "main")).toBe("a1");
    expect(resolveResultAssignmentId(state, "task")).toBe("a1");
    expect(resolveResultAssignmentId(state, "a1")).toBe("a1");
    expect(formatResultReport(state, "task-run-1")).toContain("Assignment: a1");
  });

  test("result report exposes assignment follow-ups", () => {
    const withFollowUps = structuredClone(state);
    withFollowUps.taskRuns[0].assignments[0].status = "attention";
    withFollowUps.taskRuns[0].assignments[0].result = {
      assignmentId: "a1",
      status: "attention",
      summary: "Patch rejected",
      criteriaEvidence: [],
      artifacts: [],
      followUps: ["Patch task 1 id is required", "Retry with a valid task id"],
      createdAt: 1,
    };

    const report = formatResultReport(withFollowUps, "a1");

    expect(report).toContain("Follow-ups:");
    expect(report).toContain("- Patch task 1 id is required");
    expect(report).toContain("- Retry with a valid task id");
  });

  test("result target resolution refuses ambiguous taskRun and group targets", () => {
    const multi = structuredClone(state);
    multi.taskRuns[0].tasks.push({
      id: "second",
      groupId: "main",
      text: "Do second task",
      status: "completed",
      criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [{ criterionId: "C1", assignmentId: "a2", summary: "second done", createdAt: 1 }] }],
      dependsOn: [],
      assignmentIds: ["a2"],
      createdAt: 1,
      updatedAt: 1,
      completedAt: 1,
    });
    multi.taskRuns[0].assignments.push({
      id: "a2",
      taskRunId: "task-run-1",
      groupId: "main",
      taskId: "second",
      agent: "delegate",
      prompt: "Do second task",
      status: "completed",
      runId: "run-2",
      result: { assignmentId: "a2", status: "completed", summary: "second done", criteriaEvidence: [{ criteriaIndex: 0, criterionId: "C1", evidence: "second evidence" }], artifacts: [], followUps: [], createdAt: 1 },
      createdAt: 1,
      updatedAt: 1,
      completedAt: 1,
    });

    expect(resolveResultAssignmentId(multi, "task-run-1")).toBeUndefined();
    expect(resolveResultAssignmentId(multi, "main")).toBeUndefined();
    expect(formatResultReport(multi, "task-run-1")).toContain("Ambiguous result target: task-run-1");
    expect(formatResultReport(multi, "main")).toContain("Ambiguous result target: main");
    expect(formatResultReport(multi, "main")).toContain("a1 · RUNNING · task");
    expect(formatResultReport(multi, "main")).toContain("a2 · DONE · second");
  });

  test("help exposes TaskRun actions and omits plan and phase schema", () => {
    const help = buildHelpText();
    expect(help).toContain("set_tasks");
    expect(help).toContain("edit_task");
    expect(help).toContain("edit_group");
    expect(help).toContain("patch_task_run");
    expect(help).toContain("resolve");
    expect(help).not.toContain("replace_plan");
    expect(help).not.toContain("edit_plan");
    expect(help).not.toContain("planId");
    expect(help).not.toContain("phaseId");
    expect(help).not.toContain("phases");
    expect(help).not.toContain(["quick", "run"].join("_"));
    expect(help).not.toContain(["/tasked-subagents", "run"].join(" "));
  });

  test("agent report tells users to use agentHint with set_tasks/edit_task", () => {
    const report = formatAgentsReport([{ name: "delegate", systemPrompt: "hidden", tools: [] }]);
    expect(report).toContain("agentHint");
    expect(report).toContain("set_tasks");
  });
});
