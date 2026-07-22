import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";

import type { TaskedSubagentsState } from "../src/types.js";
import { buildFooterStatus } from "../src/ui/status.js";
import { buildTaskRunChecklistLines, buildWidgetLines, createWidgetContent } from "../src/ui/widget.js";
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

  test("footer excludes superseded running attempts", () => {
    const retried = cloneState(state);
    retried.taskRuns[0].assignments[0].supersededAt = 2;
    retried.taskRuns[0].assignments[0].supersededByAssignmentId = "a2";
    retried.taskRuns[0].assignments.push({
      ...retried.taskRuns[0].assignments[0],
      id: "a2",
      status: "completed",
      supersededAt: undefined,
      supersededByAssignmentId: undefined,
    });

    expect(buildFooterStatus(retried)).not.toContain("running task");
  });

  test("widget animation ignores superseded running attempts", () => {
    vi.useFakeTimers();
    try {
      const retried = cloneState(state);
      retried.taskRuns[0].assignments[0].supersededAt = 2;
      retried.taskRuns[0].assignments[0].supersededByAssignmentId = "a2";
      retried.taskRuns[0].assignments.push({
        ...retried.taskRuns[0].assignments[0],
        id: "a2",
        status: "completed",
        supersededAt: undefined,
        supersededByAssignmentId: undefined,
      });
      const requestRender = vi.fn();
      const factory = createWidgetContent(retried, 10);
      const component = factory?.({ requestRender }, { fg: (_color, text) => text });

      vi.advanceTimersByTime(500);

      expect(requestRender).not.toHaveBeenCalled();
      component?.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("active assignment rows retain their task identity when displayed in place of task rows", () => {
    const lines = buildWidgetLines(state, 10, undefined, { now: 61_000 });
    const assignmentLine = lines.find((line) => line.includes("delegate"));

    expect(assignmentLine).toContain("task");
  });

  test("widget renders task run, group, and active assignment in place of the task text", () => {
    const lines = buildWidgetLines(state, 10, undefined, { now: 61_000 });
    const rendered = lines.join("\n");
    const assignmentLine = lines.find((line) => line.includes("delegate"));
    expect(rendered).toContain("Task run");
    expect(rendered).toContain("Main group");
    expect(rendered).not.toContain("Do task");
    expect(rendered).not.toContain(" · ");
    expect(assignmentLine).not.toContain("0/1");
    expect(assignmentLine).toContain("a1");
    expect(assignmentLine).toContain("delegate");
    expect(rendered).toContain("tool: bash");
    expect(rendered).toContain("last: reading src/orchestration/controller.ts");
    expect(rendered).toContain("tool start: rg");
    expect(rendered.split("reading src/orchestration/controller.ts")).toHaveLength(2);
  });

  test("widget annotates an idle completed action with its age once no tool is active", () => {
    const idle = cloneState(state);
    const assignment = idle.taskRuns[0].assignments[0];
    delete assignment.currentTool;
    delete assignment.recentActivity;
    assignment.lastActionAt = 1_000;
    assignment.lastActionSummary = "tool end: bash";

    const rendered = buildWidgetLines(idle, 10, undefined, { now: 1_000 + 3 * 60_000 }).join("\n");

    expect(rendered).toContain("last: tool end: bash (3m ago)");
  });

  test("widget keeps the idle-age suffix visible even when the summary is long", () => {
    const idle = cloneState(state);
    const assignment = idle.taskRuns[0].assignments[0];
    delete assignment.currentTool;
    delete assignment.recentActivity;
    assignment.lastActionAt = 1_000;
    assignment.lastActionSummary = "reading a very long file path under src/orchestration that overflows the compact width";

    const rendered = buildWidgetLines(idle, 10, undefined, { now: 1_000 + 3 * 60_000 }).join("\n");

    expect(rendered).toContain("(3m ago)");
    // The summary is elided, but the age annotation must remain fully intact.
    expect(rendered).toMatch(/…\s*\(3m ago\)/);
  });

  test("widget omits the idle age while a tool is still active", () => {
    const active = cloneState(state);
    active.taskRuns[0].assignments[0].lastActionAt = 1_000;

    const rendered = buildWidgetLines(active, 10, undefined, { now: 1_000 + 3 * 60_000 }).join("\n");

    expect(rendered).toContain("tool: bash");
    expect(rendered).not.toContain("ago)");
  });

  test("widget renders one-off ungrouped task runs", () => {
    const oneOff = cloneState(state);
    oneOff.taskRuns[0].groups = [];
    delete oneOff.taskRuns[0].tasks[0].groupId;
    delete oneOff.taskRuns[0].assignments[0].groupId;

    const rendered = buildWidgetLines(oneOff, 10, undefined, { now: 61_000 }).join("\n");

    expect(rendered).toContain("Ungrouped");
    expect(rendered).not.toContain("Do task");
    expect(rendered).toContain("delegate");
    expect(rendered).toContain("tool: bash");
  });

  test("widget hides the task text and renders the active assignment line at task depth", () => {
    const lines = buildWidgetLines(state, 10, undefined, { now: 61_000 });
    const rendered = lines.join("\n");
    const assignmentLine = lines.find((line) => line.includes("delegate"));

    expect(rendered).not.toContain("Do task");
    expect(assignmentLine).toBeDefined();
    expect(assignmentLine).toContain("delegate");
    expect(assignmentLine).toContain("a1");
    expect(assignmentLine?.startsWith("   └ ")).toBe(true);
  });

  test("widget keeps the criteria progress counter on the active assignment line", () => {
    const partial = cloneState(state);
    partial.taskRuns[0].tasks[0].criteria = [
      { id: "C1", text: "First", satisfied: true, evidence: [] },
      { id: "C2", text: "Second", satisfied: false, evidence: [] },
    ];

    const lines = buildWidgetLines(partial, 10, undefined, { now: 61_000 });
    const assignmentLine = lines.find((line) => line.includes("delegate"));

    expect(assignmentLine).toContain("1/2");
    expect(lines.join("\n")).not.toContain("Do task");
  });

  test("widget still renders the task text when there is no active assignment", () => {
    const ready = cloneState(state);
    ready.taskRuns[0].tasks[0].status = "ready";
    ready.taskRuns[0].tasks[0].assignmentIds = [];
    ready.taskRuns[0].assignments = [];

    const rendered = buildWidgetLines(ready, 10, undefined, { now: 61_000 }).join("\n");

    expect(rendered).toContain("Do task");
  });

  test("widget indents activity lines exactly one level under the active assignment line", () => {
    const lines = buildWidgetLines(state, 10, undefined, { now: 61_000 });
    const assignmentLine = lines.find((line) => line.includes("delegate"));
    const activityLine = lines.find((line) => line.includes("tool: bash"));

    expect(assignmentLine?.startsWith("   └ ")).toBe(true);
    expect(activityLine?.startsWith("      ├ ")).toBe(true);
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
    expect(rendered).not.toContain("Still running smoke task");
    expect(rendered).toContain("tool: bash");
    expect(rendered).not.toContain("Completed task 1");
    expect(rendered).not.toContain("Active completed task 1");
  });

  test("full checklist renders completed triage with pending generated review tasks", () => {
    const planned = cloneState(state);
    planned.taskRuns[0].title = "Review workflow";
    planned.taskRuns[0].groups[0].title = "Review plan";
    planned.taskRuns[0].groups[0].status = "running";
    planned.taskRuns[0].groups.push({
      id: "implementation",
      title: "Implementation plan",
      status: "pending",
      dependsOn: ["main"],
      maxConcurrency: 1,
      createdAt: 2,
      updatedAt: 2,
    });
    planned.taskRuns[0].tasks = [
      {
        id: "triage",
        groupId: "main",
        text: "Decide needed reviewers",
        status: "completed",
        criteria: [{ id: "C1", text: "Reviewer plan produced", satisfied: true, evidence: [] }],
        dependsOn: [],
        assignmentIds: ["triage-a1"],
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
      },
      {
        id: "review-security",
        groupId: "main",
        text: "Review security risks",
        status: "pending",
        criteria: [{ id: "C1", text: "Security reviewed", satisfied: false, evidence: [] }],
        dependsOn: ["triage"],
        assignmentIds: [],
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: "review-tests",
        groupId: "main",
        text: "Review test coverage",
        status: "pending",
        criteria: [{ id: "C1", text: "Tests reviewed", satisfied: false, evidence: [] }],
        dependsOn: ["triage"],
        assignmentIds: [],
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: "implement-fixes",
        groupId: "implementation",
        text: "Implement review fixes",
        status: "pending",
        criteria: [{ id: "C1", text: "Fixes implemented", satisfied: false, evidence: [] }],
        dependsOn: ["review-tests"],
        assignmentIds: [],
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    planned.taskRuns[0].assignments = [{
      id: "triage-a1",
      taskRunId: "task-run-1",
      groupId: "main",
      taskId: "triage",
      agent: "delegate",
      prompt: "Plan reviewers",
      status: "completed",
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    }];

    const rendered = buildTaskRunChecklistLines(planned.taskRuns[0], 20).join("\n");

    expect(rendered).toContain("Review workflow");
    expect(rendered).toContain("Review plan");
    expect(rendered).toContain("Implementation plan");
    expect(rendered).toContain("Decide needed reviewers");
    expect(rendered).toContain("Review security risks");
    expect(rendered).toContain("Review test coverage");
    expect(rendered).toContain("Implement review fixes");
    expect(rendered).toContain("triage-a1");
    expect(rendered).toContain("depends on: triage");
  });

  test("full checklist marks current task by precedence", () => {
    const workflow = cloneState(state);
    workflow.taskRuns[0].tasks = [
      { ...workflow.taskRuns[0].tasks[0], id: "pending", text: "Pending task", status: "pending", assignmentIds: [] },
      { ...workflow.taskRuns[0].tasks[0], id: "blocked", text: "Blocked task", status: "blocked", assignmentIds: [] },
      { ...workflow.taskRuns[0].tasks[0], id: "ready", text: "Ready task", status: "ready", assignmentIds: [] },
      { ...workflow.taskRuns[0].tasks[0], id: "queued", text: "Queued task", status: "ready", assignmentIds: ["queued-a1"] },
      { ...workflow.taskRuns[0].tasks[0], id: "running", text: "Running task", status: "running", assignmentIds: [] },
      { ...workflow.taskRuns[0].tasks[0], id: "failed", text: "Failed task", status: "failed", assignmentIds: [] },
    ];
    workflow.taskRuns[0].assignments = [{
      ...workflow.taskRuns[0].assignments[0],
      id: "queued-a1",
      taskId: "queued",
      status: "queued",
    }];

    const lines = buildTaskRunChecklistLines(workflow.taskRuns[0], 20);
    expect(lines.find((line) => line.includes("Failed task"))).toContain("→");
    expect(lines.find((line) => line.includes("Blocked task"))).not.toContain("→");

    workflow.taskRuns[0].tasks.find((task) => task.id === "failed")!.status = "completed";
    const blockedLines = buildTaskRunChecklistLines(workflow.taskRuns[0], 20);
    expect(blockedLines.find((line) => line.includes("Blocked task"))).toContain("→");
    expect(blockedLines.find((line) => line.includes("Queued task"))).not.toContain("→");

    workflow.taskRuns[0].tasks.find((task) => task.id === "blocked")!.status = "completed";
    const runningLines = buildTaskRunChecklistLines(workflow.taskRuns[0], 20);
    expect(runningLines.find((line) => line.includes("Queued task"))).toContain("→");
    expect(runningLines.find((line) => line.includes("Ready task"))).not.toContain("→");

    workflow.taskRuns[0].assignments[0].status = "completed";
    workflow.taskRuns[0].tasks.find((task) => task.id === "running")!.status = "completed";
    const readyLines = buildTaskRunChecklistLines(workflow.taskRuns[0], 20);
    expect(readyLines.find((line) => line.includes("Ready task"))).toContain("→");

    workflow.taskRuns[0].tasks.find((task) => task.id === "ready")!.status = "completed";
    const pendingLines = buildTaskRunChecklistLines(workflow.taskRuns[0], 20);
    expect(pendingLines.find((line) => line.includes("Pending task"))).toContain("→");
  });

  test("full checklist current task ignores stale historical assignment blockers", () => {
    const workflow = cloneState(state);
    workflow.taskRuns[0].tasks = [
      { ...workflow.taskRuns[0].tasks[0], id: "retried", text: "Retried task", status: "ready", assignmentIds: ["old-failed", "latest-completed"] },
      { ...workflow.taskRuns[0].tasks[0], id: "attention", text: "Attention task", status: "attention", assignmentIds: [] },
    ];
    workflow.taskRuns[0].assignments = [
      { ...workflow.taskRuns[0].assignments[0], id: "old-failed", taskId: "retried", status: "failed" },
      { ...workflow.taskRuns[0].assignments[0], id: "latest-completed", taskId: "retried", status: "completed" },
    ];

    const lines = buildTaskRunChecklistLines(workflow.taskRuns[0], 20);

    expect(lines.find((line) => line.includes("Attention task"))).toContain("→");
    expect(lines.find((line) => line.includes("Retried task"))).not.toContain("→");
  });

  test("full checklist task lines include assignment agent id and status", () => {
    const assigned = cloneState(state);

    const line = buildTaskRunChecklistLines(assigned.taskRuns[0], 20).find((candidate) => candidate.includes("Do task"));

    expect(line).toContain("delegate");
    expect(line).toContain("a1");
    expect(line).toContain("running");
  });

  test("full checklist collapses superseded attempts behind a history count", () => {
    const retried = cloneState(state);
    retried.taskRuns[0].tasks[0].assignmentIds = ["task-a1", "task-a2"];
    retried.taskRuns[0].assignments = [
      {
        ...retried.taskRuns[0].assignments[0],
        id: "task-a1",
        taskId: "task",
        status: "attention",
        agent: "reviewer",
        supersededAt: 2,
        supersededByAssignmentId: "task-a2",
      },
      {
        ...retried.taskRuns[0].assignments[0],
        id: "task-a2",
        taskId: "task",
        status: "running",
        agent: "verifier",
      },
    ];

    const rendered = buildTaskRunChecklistLines(retried.taskRuns[0], 20).join("\n");

    expect(rendered).not.toContain("reviewer task-a1");
    expect(rendered).toContain("verifier task-a2");
    expect(rendered).toContain("1 previous attempt");
  });

  test("full checklist preserves declaration order across completed running and pending tasks", () => {
    const mixed = cloneState(state);
    mixed.taskRuns[0].tasks = [
      { ...mixed.taskRuns[0].tasks[0], id: "completed", text: "Completed first", status: "completed", assignmentIds: [], completedAt: 2 },
      { ...mixed.taskRuns[0].tasks[0], id: "running", text: "Running second", status: "running", assignmentIds: ["a1"] },
      { ...mixed.taskRuns[0].tasks[0], id: "pending", text: "Pending third", status: "pending", assignmentIds: [] },
    ];
    mixed.taskRuns[0].assignments[0].taskId = "running";

    const rendered = buildTaskRunChecklistLines(mixed.taskRuns[0], 20).join("\n");

    expect(rendered.indexOf("Completed first")).toBeLessThan(rendered.indexOf("Running second"));
    expect(rendered.indexOf("Running second")).toBeLessThan(rendered.indexOf("Pending third"));
    expect(rendered).toContain("delegate");
  });

  test("full checklist reports hidden line count when height is limited", () => {
    const many = cloneState(state);
    many.taskRuns[0].tasks = Array.from({ length: 8 }, (_, index) => ({
      ...many.taskRuns[0].tasks[0],
      id: `task-${index + 1}`,
      text: `Task ${index + 1}`,
      status: index === 0 ? "completed" as const : "pending" as const,
      assignmentIds: [],
    }));
    many.taskRuns[0].assignments = [];

    const rendered = buildTaskRunChecklistLines(many.taskRuns[0], 5).join("\n");

    expect(rendered).toContain("Task 1");
    expect(rendered).toContain("more checklist lines");
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
