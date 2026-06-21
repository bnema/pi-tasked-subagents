import { describe, expect, test } from "vitest";

import { buildHelpText, formatAgentsReport, formatInspectReport, formatStatusReport, parseCommand } from "../src/orchestration/commands.js";
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
