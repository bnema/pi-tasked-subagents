import { describe, expect, test } from "vitest";

import { buildHelpText, formatAgentsReport, formatInspectReport, formatResultReport, formatStatusReport, parseCommand, resolveResultAssignmentId } from "../src/orchestration/commands.js";
import type { TaskedSubagentsState } from "../src/types.js";

const state: TaskedSubagentsState = {
  version: 2,
  currentPlanId: "plan-1",
  updatedAt: 1,
  plans: [{
    id: "plan-1",
    title: "Plan",
    request: "Do it",
    spec: "Spec",
    status: "running",
    phases: [{
      id: "main",
      title: "Main",
      status: "running",
      dependsOn: [],
      tasks: [{
        id: "task",
        text: "Do task",
        status: "running",
        criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }],
        dependsOn: [],
        assignmentIds: ["a1"],
        createdAt: 1,
        updatedAt: 1,
      }],
      createdAt: 1,
      updatedAt: 1,
    }],
    assignments: [{
      id: "a1",
      planId: "plan-1",
      phaseId: "main",
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
  test("parses plan-first commands and rejects run command", () => {
    expect(parseCommand("status plan-1")).toEqual({ action: "status", targetId: "plan-1" });
    expect(parseCommand("continue task fix it")).toEqual({ action: "continue", targetId: "task", prompt: "fix it" });
    expect(parseCommand("resolve task fixed in commit abc123")).toEqual({ action: "resolve", targetId: "task", prompt: "fixed in commit abc123" });
    expect(parseCommand("resolve task")).toEqual({ action: "help" });
    expect(parseCommand("run do arbitrary prompt")).toEqual({ action: "help" });
  });

  test("formats status for plans, tasks, and assignments", () => {
    expect(formatStatusReport(state)).toContain("Plans: 1 total");
    expect(formatStatusReport(state, "task")).toContain("criteria: 0/1 satisfied");
    expect(formatInspectReport(state, "a1")).toContain("Assignment: a1");
  });

  test("plan and phase inspect expose task assignment ids", () => {
    expect(formatInspectReport(state, "plan-1")).toContain("task · RUNNING · a1 · Do task");
    expect(formatInspectReport(state, "main")).toContain("task · RUNNING · a1 · Do task");
  });

  test("help documents unambiguous result targets", () => {
    expect(buildHelpText()).toContain("/tasked-subagents result <planId|phaseId|taskId|assignmentId>");
  });

  test("result target resolution accepts plan, phase, task, and assignment ids", () => {
    expect(resolveResultAssignmentId(state, "plan-1")).toBe("a1");
    expect(resolveResultAssignmentId(state, "main")).toBe("a1");
    expect(resolveResultAssignmentId(state, "task")).toBe("a1");
    expect(resolveResultAssignmentId(state, "a1")).toBe("a1");
    expect(formatResultReport(state, "plan-1")).toContain("Assignment: a1");
  });

  test("result target resolution refuses ambiguous plan targets", () => {
    const multi = structuredClone(state);
    multi.plans[0].phases[0].tasks.push({
      id: "second",
      text: "Do second task",
      status: "completed",
      criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [{ criterionId: "C1", assignmentId: "a2", summary: "second done", createdAt: 1 }] }],
      dependsOn: [],
      assignmentIds: ["a2"],
      createdAt: 1,
      updatedAt: 1,
      completedAt: 1,
    });
    multi.plans[0].assignments.push({
      id: "a2",
      planId: "plan-1",
      phaseId: "main",
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

    expect(resolveResultAssignmentId(multi, "plan-1")).toBeUndefined();
    expect(formatResultReport(multi, "plan-1")).toContain("Ambiguous result target: plan-1");
    expect(formatResultReport(multi, "plan-1")).toContain("a1 · RUNNING · task");
    expect(formatResultReport(multi, "plan-1")).toContain("a2 · DONE · second");
  });

  test("help omits quick actions", () => {
    const help = buildHelpText();
    expect(help).toContain("replace_plan");
    expect(help).toContain("resolve");
    expect(help).not.toContain(["quick", "run"].join("_"));
    expect(help).not.toContain(["/tasked-subagents", "run"].join(" "));
  });

  test("agent report tells users to use agentHint", () => {
    expect(formatAgentsReport([{ name: "delegate", systemPrompt: "hidden", tools: [] }])).toContain("agentHint");
  });
});
