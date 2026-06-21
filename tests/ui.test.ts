import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";

import type { TaskedSubagentsState } from "../src/types.js";
import { buildFooterStatus } from "../src/ui/status.js";
import { buildWidgetLines, createWidgetContent } from "../src/ui/widget.js";
import { statusLabel } from "../src/ui/messages.js";

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
      id: "phase",
      title: "Phase",
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
      phaseId: "phase",
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

  test("footer shows plan and task assignment counts", () => {
    const footer = buildFooterStatus(state);
    expect(footer).toContain("active plan");
    expect(footer).toContain("running task");
  });

  test("widget renders plan, phase, task, and assignment activity", () => {
    const lines = buildWidgetLines(state, 10, undefined, { now: 61_000 });
    const rendered = lines.join("\n");
    const taskLine = lines.find((line) => line.includes("Do task"));
    expect(rendered).toContain("Plan");
    expect(rendered).toContain(" Phase");
    expect(rendered).toContain("Do task");
    expect(rendered).not.toContain(" Do task");
    expect(rendered).not.toContain(" · ");
    expect(rendered).not.toContain("");
    expect(taskLine).not.toContain("delegate");
    expect(taskLine).not.toContain("0/1");
    expect(rendered).toContain("a1");
    expect(rendered).toContain("delegate");
    expect(rendered).toContain("tool: bash");
    expect(rendered).toContain("last: reading src/orchestration/controller.ts");
    expect(rendered).toContain("tool start: rg");
    expect(rendered.split("reading src/orchestration/controller.ts")).toHaveLength(2);
  });

  test("widget keeps full assignment labels when they fit", () => {
    const labeled = cloneState(state);
    labeled.plans[0].phases[0].tasks[0].assignmentIds = ["manual-review-a1"];
    labeled.plans[0].assignments[0].id = "manual-review-a1";

    expect(buildWidgetLines(labeled, 10, undefined, { now: 61_000 }).join("\n")).toContain("manual-review-a1");
  });

  test("widget keeps long assignment and activity labels compact while preserving tool timeline", () => {
    const compact = cloneState(state);
    compact.plans[0].title = "Project picker text-first filter UX with a very long title that should not stretch the widget";
    compact.plans[0].phases[0].title = "TDD implementation for the project picker filter user experience";
    compact.plans[0].phases[0].tasks[0].text = "In /tmp/example-worktrees/tmux-session-sidebar/project-picker-filter, implement the entire filter UX and verify it thoroughly";
    compact.plans[0].phases[0].tasks[0].assignmentIds = ["plan-1-tdd-implementation-project-picker-filter-ux-a1"];
    compact.plans[0].assignments[0].id = "plan-1-tdd-implementation-project-picker-filter-ux-a1";
    compact.plans[0].assignments[0].agent = "senior-engineer";
    compact.plans[0].assignments[0].currentTool = "bash";
    compact.plans[0].assignments[0].lastActionSummary = "turn end after reading the widget implementation and Pi extension UI docs";
    compact.plans[0].assignments[0].recentActivity = ["tool start: read", "tool end: read"];

    const lines = buildWidgetLines(compact, 12, undefined, { now: 23_000 });
    const rendered = lines.join("\n");

    expect(rendered).toContain("a1");
    expect(rendered).not.toContain("plan-1-tdd-implementation-project-picker-filter-ux-a1");
    expect(rendered).toContain("senior-engineer");
    expect(rendered).toContain("tool: bash");
    expect(rendered).toContain("tool end: read");
    expect(lines.every((line) => visibleWidth(line) <= 88)).toBe(true);
  });

  test("widget parent counters advance when an assignment completes before evidence is reduced", () => {
    const pendingReduction = cloneState(state);
    pendingReduction.plans[0].phases[0].tasks = Array.from({ length: 8 }, (_, index) => ({
      id: `task-${index + 1}`,
      text: `Task ${index + 1}`,
      status: index === 0 ? "running" as const : "pending" as const,
      criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }],
      dependsOn: [],
      assignmentIds: index === 0 ? ["task-1-a1"] : [],
      createdAt: 1,
      updatedAt: 1,
    }));
    pendingReduction.plans[0].assignments = [{
      id: "task-1-a1",
      planId: "plan-1",
      phaseId: "phase",
      taskId: "task-1",
      agent: "delegate",
      prompt: "Do task 1",
      status: "completed",
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    }];

    const lines = buildWidgetLines(pendingReduction, 12, undefined, { now: 61_000 });
    const planLine = lines.find((line) => line.includes("Tasked"));
    const phaseLine = lines.find((line) => line.includes("Phase"));

    expect(planLine).toContain("1/8");
    expect(phaseLine).toContain("1/8");
    expect(lines.join("\n")).toContain("1 completed");
    expect(lines.join("\n")).not.toContain("Task 1");
  });

  test("widget keeps unique recent activity when duplicate tail entries would waste slots", () => {
    const activity = cloneState(state);
    activity.plans[0].assignments[0].lastActionSummary = undefined;
    activity.plans[0].assignments[0].recentActivity = ["older unique activity", "duplicate activity", "duplicate activity"];

    const rendered = buildWidgetLines(activity, 10, undefined, { now: 61_000 }).join("\n");

    expect(rendered).toContain("tool: bash");
    expect(rendered).toContain("older unique activity");
    expect(rendered.split("duplicate activity")).toHaveLength(2);
  });

  test("widget treats the final visible task as last when completed summary does not fit", () => {
    const cramped = cloneState(state);
    cramped.plans[0].phases[0].tasks.push({
      id: "done-task",
      text: "Already done",
      status: "completed",
      criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [] }],
      dependsOn: [],
      assignmentIds: [],
      createdAt: 1,
      updatedAt: 1,
      completedAt: 1,
    });

    const lines = buildWidgetLines(cramped, 3, undefined, { now: 61_000 });
    const taskLine = lines.find((line) => line.includes("Do task"));

    expect(taskLine?.trimStart().startsWith("└")).toBe(true);
    expect(lines.join("\n")).not.toContain("completed");
  });

  test("widget collapses completed siblings so unfinished tasks stay visible", () => {
    const focused = cloneState(state);
    focused.plans[0].title = "Many task smoke test";
    focused.plans[0].status = "attention";
    focused.plans[0].phases = [
      {
        id: "done-phase",
        title: "Completed wave",
        status: "completed",
        dependsOn: [],
        tasks: Array.from({ length: 8 }, (_, index) => ({
          id: `done-${index + 1}`,
          text: `Completed task ${index + 1}`,
          status: "completed" as const,
          criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [] }],
          dependsOn: [],
          assignmentIds: [],
          createdAt: 1,
          updatedAt: 1,
          completedAt: 1,
        })),
        createdAt: 1,
        updatedAt: 1,
        completedAt: 1,
      },
      {
        id: "active-phase",
        title: "Active wave",
        status: "attention",
        dependsOn: ["done-phase"],
        tasks: [
          ...Array.from({ length: 5 }, (_, index) => ({
            id: `active-done-${index + 1}`,
            text: `Active completed task ${index + 1}`,
            status: "completed" as const,
            criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [] }],
            dependsOn: [],
            assignmentIds: [],
            createdAt: 1,
            updatedAt: 1,
            completedAt: 1,
          })),
          {
            id: "needs-attention",
            text: "Needs attention after smoke run",
            status: "attention" as const,
            criteria: [{ id: "C1", text: "Resolved", satisfied: false, evidence: [] }],
            dependsOn: [],
            assignmentIds: [],
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "still-running",
            text: "Still running smoke task",
            status: "running" as const,
            criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }],
            dependsOn: [],
            assignmentIds: ["long-running-assignment-a1"],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    focused.plans[0].assignments = [{
      id: "long-running-assignment-a1",
      planId: "plan-1",
      phaseId: "active-phase",
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

  test("widget prioritizes active phases when many completed phases would fill the limit", () => {
    const focused = cloneState(state);
    focused.plans[0].status = "attention";
    focused.plans[0].title = "Phase prioritization";
    focused.plans[0].phases = [
      ...Array.from({ length: 6 }, (_, phaseIndex) => ({
        id: `completed-phase-${phaseIndex + 1}`,
        title: `Completed phase ${phaseIndex + 1}`,
        status: "completed" as const,
        dependsOn: [],
        tasks: [{
          id: `completed-task-${phaseIndex + 1}`,
          text: `Completed task ${phaseIndex + 1}`,
          status: "completed" as const,
          criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [] }],
          dependsOn: [],
          assignmentIds: [],
          createdAt: 1,
          updatedAt: 1,
          completedAt: 1,
        }],
        createdAt: 1,
        updatedAt: 1,
        completedAt: 1,
      })),
      {
        id: "active-phase",
        title: "Active phase",
        status: "attention" as const,
        dependsOn: [],
        tasks: [
          {
            id: "needs-attention",
            text: "Needs attention now",
            status: "attention" as const,
            criteria: [{ id: "C1", text: "Resolved", satisfied: false, evidence: [] }],
            dependsOn: [],
            assignmentIds: [],
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "still-running",
            text: "Still running now",
            status: "running" as const,
            criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }],
            dependsOn: [],
            assignmentIds: ["active-a1"],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    focused.plans[0].assignments = [{
      id: "active-a1",
      planId: "plan-1",
      phaseId: "active-phase",
      taskId: "still-running",
      agent: "delegate",
      prompt: "run",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    }];

    const rendered = buildWidgetLines(focused, 8, undefined, { now: 61_000 }).join("\n");

    expect(rendered).toContain("Active phase");
    expect(rendered).toContain("Needs attention now");
    expect(rendered).toContain("Still running now");
    expect(rendered).toContain("6 phases completed");
    expect(rendered).not.toContain("Completed phase 1");
  });

  test("widget component caps wide renders and still respects narrow terminal widths", () => {
    const compact = cloneState(state);
    compact.plans[0].title = "Project picker text-first filter UX with a very long title that should not stretch the widget";
    compact.plans[0].phases[0].tasks[0].text = "A long task description that should be abbreviated before it reaches across the whole terminal";
    compact.plans[0].assignments[0].lastActionSummary = "last action summary that is intentionally verbose enough to require truncation in the widget";

    const factory = createWidgetContent(compact, 12, { now: 61_000 });
    expect(factory).toBeDefined();
    const component = factory!({}, { fg: (_color, text) => text });

    expect(component.render(120).every((line) => visibleWidth(line) <= 88)).toBe(true);
    expect(component.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  test("widget content clears when only completed plans remain", () => {
    const completed = cloneState(state);
    completed.plans[0].status = "completed";
    completed.plans[0].phases[0].status = "completed";
    completed.plans[0].phases[0].tasks[0].status = "completed";
    completed.plans[0].phases[0].tasks[0].criteria[0].satisfied = true;
    completed.plans[0].assignments[0].status = "completed";

    expect(createWidgetContent(completed, 10)).toBeUndefined();
  });

  test("widget hides fully completed plans", () => {
    const completed = cloneState(state);
    completed.plans[0].status = "completed";
    completed.plans[0].phases[0].status = "completed";
    completed.plans[0].phases[0].tasks[0].status = "completed";
    completed.plans[0].phases[0].tasks[0].criteria[0].satisfied = true;
    completed.plans[0].assignments[0].status = "completed";

    expect(buildWidgetLines(completed, 10)).toEqual([]);
  });

  test("widget omits redundant complete progress labels", () => {
    const completedTask = cloneState(state);
    completedTask.plans[0].phases[0].tasks[0].status = "completed";
    completedTask.plans[0].phases[0].tasks[0].criteria[0].satisfied = true;
    completedTask.plans[0].assignments[0].status = "completed";

    expect(buildWidgetLines(completedTask, 10).join("\n")).not.toContain("1/1");
  });

  test("footer counts mixed running attention failed and completed plans", () => {
    const mixed = cloneState(state);
    const attention = cloneState(state).plans[0];
    attention.id = "plan-2";
    attention.title = "Attention plan";
    attention.status = "attention";
    const failed = cloneState(state).plans[0];
    failed.id = "plan-3";
    failed.title = "Failed plan";
    failed.status = "failed";
    const completed = cloneState(state).plans[0];
    completed.id = "plan-4";
    completed.title = "Completed plan";
    completed.status = "completed";
    mixed.plans.push(attention, failed, completed);

    const footer = buildFooterStatus(mixed);

    expect(footer).toContain("1 active plan");
    expect(footer).toContain("2 attention");
    expect(footer).toContain("1 done");
  });

  test("widget prioritizes the current visible plan", () => {
    const mixed = cloneState(state);
    const attention = cloneState(state).plans[0];
    attention.id = "plan-2";
    attention.title = "Attention plan";
    attention.status = "attention";
    mixed.plans.push(attention);
    mixed.currentPlanId = "plan-1";

    expect(buildWidgetLines(mixed, 10).join("\n")).toContain("Plan");
    expect(buildWidgetLines(mixed, 10).join("\n")).not.toContain("Attention plan");
  });

  test("widget falls back to attention and failed plans when current plan is completed", () => {
    const mixed = cloneState(state);
    mixed.plans[0].status = "completed";
    const failed = cloneState(state).plans[0];
    failed.id = "plan-2";
    failed.title = "Failed plan";
    failed.status = "failed";
    mixed.plans.push(failed);
    mixed.currentPlanId = "plan-1";

    expect(buildWidgetLines(mixed, 10).join("\n")).toContain("Failed plan");
  });

  test("cancelled plans are hidden from the widget", () => {
    const cancelled = cloneState(state);
    cancelled.plans[0].status = "cancelled";
    cancelled.plans[0].phases[0].status = "cancelled";
    cancelled.plans[0].phases[0].tasks[0].status = "cancelled";
    cancelled.plans[0].assignments[0].status = "cancelled";

    expect(buildWidgetLines(cancelled, 10)).toEqual([]);
  });
});
