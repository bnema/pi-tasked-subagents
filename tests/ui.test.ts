import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";

import type { TaskedSubagentsState } from "../src/types.js";
import { buildFooterStatus } from "../src/ui/status.js";
import { buildWidgetLines, createWidgetContent } from "../src/ui/widget.js";
import { statusLabel } from "../src/ui/messages.js";

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
      title: "Main group",
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
      currentTool: "bash",
      lastActionSummary: "reading src/orchestration/controller.ts",
      recentActivity: ["tool start: rg", "reading src/orchestration/controller.ts"],
      createdAt: 1,
      updatedAt: 1,
    }],
    artifacts: [],
    createdAt: 1,
    updatedAt: 1,
  }],
};

function cloneState(input: TaskedSubagentsState): TaskedSubagentsState {
  return JSON.parse(JSON.stringify(input)) as TaskedSubagentsState;
}

describe("ui", () => {
  test("labels statuses", () => {
    expect(statusLabel("running")).toBe("RUNNING");
    expect(statusLabel("attention")).toBe("ATTN");
  });

  test("footer shows task-run and task assignment counts", () => {
    const footer = buildFooterStatus(state);
    expect(footer).toContain("active task run");
    expect(footer).toContain("running task");
  });

  test("widget renders task run, group, task, and assignment activity", () => {
    const lines = buildWidgetLines(state, 10, undefined, { now: 61_000 });
    const rendered = lines.join("\n");
    const taskLine = lines.find((line) => line.includes("Do task"));
    expect(rendered).toContain("Task run");
    expect(rendered).toContain("Main group");
    expect(rendered).toContain("Do task");
    expect(rendered).not.toContain(" · ");
    expect(taskLine).not.toContain("delegate");
    expect(taskLine).not.toContain("0/1");
    expect(rendered).toContain("a1");
    expect(rendered).toContain("delegate");
    expect(rendered).toContain("tool: bash");
    expect(rendered).toContain("last: reading src/orchestration/controller.ts");
    expect(rendered).toContain("tool start: rg");
    expect(rendered.split("reading src/orchestration/controller.ts")).toHaveLength(2);
  });

  test("widget renders one-off ungrouped task runs", () => {
    const oneOff = cloneState(state);
    oneOff.taskRuns[0].groups = [];
    delete oneOff.taskRuns[0].tasks[0].groupId;
    delete oneOff.taskRuns[0].assignments[0].groupId;

    const rendered = buildWidgetLines(oneOff, 10, undefined, { now: 61_000 }).join("\n");

    expect(rendered).toContain("Ungrouped");
    expect(rendered).toContain("Do task");
    expect(rendered).toContain("tool: bash");
  });

  test("widget keeps full assignment labels when they fit", () => {
    const labeled = cloneState(state);
    labeled.taskRuns[0].tasks[0].assignmentIds = ["manual-review-a1"];
    labeled.taskRuns[0].assignments[0].id = "manual-review-a1";

    expect(buildWidgetLines(labeled, 10, undefined, { now: 61_000 }).join("\n")).toContain("manual-review-a1");
  });

  test("widget keeps long assignment and activity labels compact while preserving tool timeline", () => {
    const compact = cloneState(state);
    compact.taskRuns[0].title = "Project picker text-first filter UX with a very long title that should not stretch the widget";
    compact.taskRuns[0].groups[0].title = "TDD implementation for the project picker filter user experience";
    compact.taskRuns[0].tasks[0].text = "In /tmp/example-worktrees/tmux-session-sidebar/project-picker-filter, implement the entire filter UX and verify it thoroughly";
    compact.taskRuns[0].tasks[0].assignmentIds = ["task-run-1-tdd-implementation-project-picker-filter-ux-a1"];
    compact.taskRuns[0].assignments[0].id = "task-run-1-tdd-implementation-project-picker-filter-ux-a1";
    compact.taskRuns[0].assignments[0].agent = "senior-engineer";
    compact.taskRuns[0].assignments[0].lastActionSummary = "turn end after reading the widget implementation and Pi extension UI docs";
    compact.taskRuns[0].assignments[0].recentActivity = ["tool start: read", "tool end: read"];

    const lines = buildWidgetLines(compact, 12, undefined, { now: 23_000 });
    const rendered = lines.join("\n");

    expect(rendered).toContain("a1");
    expect(rendered).not.toContain("task-run-1-tdd-implementation-project-picker-filter-ux-a1");
    expect(rendered).toContain("senior-engineer");
    expect(rendered).toContain("tool: bash");
    expect(rendered).toContain("tool end: read");
    expect(lines.every((line) => visibleWidth(line) <= 88)).toBe(true);
  });

  test("widget parent counters advance when an assignment completes before evidence is reduced", () => {
    const pendingReduction = cloneState(state);
    pendingReduction.taskRuns[0].tasks = Array.from({ length: 8 }, (_, index) => ({
      id: `task-${index + 1}`,
      groupId: "main",
      text: `Task ${index + 1}`,
      status: index === 0 ? "running" as const : "pending" as const,
      criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }],
      dependsOn: [],
      assignmentIds: index === 0 ? ["task-1-a1"] : [],
      createdAt: 1,
      updatedAt: 1,
    }));
    pendingReduction.taskRuns[0].assignments = [{
      id: "task-1-a1",
      taskRunId: "task-run-1",
      groupId: "main",
      taskId: "task-1",
      agent: "delegate",
      prompt: "Do task 1",
      status: "completed",
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    }];

    const lines = buildWidgetLines(pendingReduction, 12, undefined, { now: 61_000 });
    const runLine = lines.find((line) => line.includes("Tasked"));
    const groupLine = lines.find((line) => line.includes("Main group"));

    expect(runLine).toContain("1/8");
    expect(groupLine).toContain("1/8");
    expect(lines.join("\n")).toContain("1 completed");
    expect(lines.join("\n")).not.toContain("Task 1");
  });

  test("widget collapses completed sibling groups so unfinished tasks stay visible", () => {
    const focused = cloneState(state);
    focused.taskRuns[0].title = "Many task smoke test";
    focused.taskRuns[0].status = "attention";
    focused.taskRuns[0].groups = [
      { id: "done-group", title: "Completed wave", status: "completed", dependsOn: [], maxConcurrency: 1, createdAt: 1, updatedAt: 1, completedAt: 1 },
      { id: "active-group", title: "Active wave", status: "attention", dependsOn: ["done-group"], maxConcurrency: 1, createdAt: 1, updatedAt: 1 },
    ];
    focused.taskRuns[0].tasks = [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `done-${index + 1}`,
        groupId: "done-group",
        text: `Completed task ${index + 1}`,
        status: "completed" as const,
        criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [] }],
        dependsOn: [],
        assignmentIds: [],
        createdAt: 1,
        updatedAt: 1,
        completedAt: 1,
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `active-done-${index + 1}`,
        groupId: "active-group",
        text: `Active completed task ${index + 1}`,
        status: "completed" as const,
        criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [] }],
        dependsOn: [],
        assignmentIds: [],
        createdAt: 1,
        updatedAt: 1,
        completedAt: 1,
      })),
      { id: "needs-attention", groupId: "active-group", text: "Needs attention after smoke run", status: "attention", criteria: [{ id: "C1", text: "Resolved", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 },
      { id: "still-running", groupId: "active-group", text: "Still running smoke task", status: "running", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: ["long-running-assignment-a1"], createdAt: 1, updatedAt: 1 },
    ];
    focused.taskRuns[0].assignments = [{
      id: "long-running-assignment-a1",
      taskRunId: "task-run-1",
      groupId: "active-group",
      taskId: "still-running",
      agent: "delegate",
      prompt: "run smoke",
      status: "running",
      currentTool: "bash",
      lastActionSummary: "smoke-id=running",
      recentActivity: ["tool start: bash"],
      createdAt: 1,
      updatedAt: 1,
    }];

    const rendered = buildWidgetLines(focused, 12, undefined, { now: 61_000 }).join("\n");

    expect(rendered).toContain("13/15");
    expect(rendered).toContain("5/7");
    expect(rendered).toContain("8 completed");
    expect(rendered).toContain("5 completed");
    expect(rendered).toContain("Needs attention after smoke run");
    expect(rendered).toContain("Still running smoke task");
    expect(rendered).toContain("tool: bash");
    expect(rendered).not.toContain("Completed task 1");
    expect(rendered).not.toContain("Active completed task 1");
  });

  test("widget component caps wide renders and still respects narrow terminal widths", () => {
    const compact = cloneState(state);
    compact.taskRuns[0].title = "Project picker text-first filter UX with a very long title that should not stretch the widget";
    compact.taskRuns[0].tasks[0].text = "A long task description that should be abbreviated before it reaches across the whole terminal";
    compact.taskRuns[0].assignments[0].lastActionSummary = "last action summary that is intentionally verbose enough to require truncation in the widget";

    const factory = createWidgetContent(compact, 12, { now: 61_000 });
    expect(factory).toBeDefined();
    const component = factory!({}, { fg: (_color, text) => text });

    expect(component.render(120).every((line) => visibleWidth(line) <= 88)).toBe(true);
    expect(component.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  test("widget hides completed and cancelled task runs", () => {
    const completed = cloneState(state);
    completed.taskRuns[0].status = "completed";
    completed.taskRuns[0].groups[0].status = "completed";
    completed.taskRuns[0].tasks[0].status = "completed";
    completed.taskRuns[0].tasks[0].criteria[0].satisfied = true;
    completed.taskRuns[0].assignments[0].status = "completed";

    const cancelled = cloneState(state);
    cancelled.taskRuns[0].status = "cancelled";
    cancelled.taskRuns[0].groups[0].status = "cancelled";
    cancelled.taskRuns[0].tasks[0].status = "cancelled";
    cancelled.taskRuns[0].assignments[0].status = "cancelled";

    expect(createWidgetContent(completed, 10)).toBeUndefined();
    expect(buildWidgetLines(completed, 10)).toEqual([]);
    expect(buildWidgetLines(cancelled, 10)).toEqual([]);
  });

  test("footer counts mixed running attention failed and completed task runs", () => {
    const mixed = cloneState(state);
    const attention = cloneState(state).taskRuns[0];
    attention.id = "task-run-2";
    attention.title = "Attention run";
    attention.status = "attention";
    const failed = cloneState(state).taskRuns[0];
    failed.id = "task-run-3";
    failed.title = "Failed run";
    failed.status = "failed";
    const completed = cloneState(state).taskRuns[0];
    completed.id = "task-run-4";
    completed.title = "Completed run";
    completed.status = "completed";
    mixed.taskRuns.push(attention, failed, completed);

    const footer = buildFooterStatus(mixed);

    expect(footer).toContain("1 active task run");
    expect(footer).toContain("2 attention");
    expect(footer).toContain("1 done");
  });

  test("widget prioritizes current visible task run and falls back to attention runs", () => {
    const mixed = cloneState(state);
    const attention = cloneState(state).taskRuns[0];
    attention.id = "task-run-2";
    attention.title = "Attention run";
    attention.status = "attention";
    mixed.taskRuns.push(attention);
    mixed.currentTaskRunId = "task-run-1";

    expect(buildWidgetLines(mixed, 10).join("\n")).toContain("Task run");
    expect(buildWidgetLines(mixed, 10).join("\n")).not.toContain("Attention run");

    mixed.taskRuns[0].status = "completed";
    expect(buildWidgetLines(mixed, 10).join("\n")).toContain("Attention run");
  });
});
