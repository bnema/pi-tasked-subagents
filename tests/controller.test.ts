import { describe, expect, test, vi } from "vitest";

import { TaskedSubagentsController } from "../src/orchestration/controller.js";
import type { Launcher, LaunchTaskGraphRequest, RunProgressSnapshot, RunStatus, TaskGraphLaunchRef } from "../src/types.js";

function fakePi() {
  return {
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  } as never;
}

class CompletingLauncher implements Launcher {
  requests: LaunchTaskGraphRequest[] = [];

  async launchTaskGraph(request: LaunchTaskGraphRequest): Promise<TaskGraphLaunchRef> {
    this.requests.push(request);
    return {
      runId: request.runId,
      asyncId: request.runId,
      resultPath: `/tmp/${request.runId}.json`,
      assignments: request.tasks.map((task) => ({ assignmentId: task.assignmentId, runId: request.runId, resultPath: `/tmp/${request.runId}.json` })),
    };
  }

  async stopRun(_runId: string, _ctx?: unknown): Promise<boolean> { return true; }
  async cancelRun(_runId: string, _ctx?: unknown): Promise<boolean> { return true; }

  async waitForRunSignal(_runId: string | undefined, options?: { onUpdate?: (snapshot: RunProgressSnapshot) => void | Promise<void> }): Promise<RunStatus> {
    const request = this.requests[this.requests.length - 1]!;
    await options?.onUpdate?.({
      runId: request.runId,
      status: "running",
      steps: request.tasks.map((task) => ({ id: task.assignmentId, status: "running", agent: task.agent })),
    });
    return "completed";
  }

  async getRunResult(): Promise<string | undefined> {
    const request = this.requests[this.requests.length - 1]!;
    const reports = request.tasks.map((task) => JSON.stringify({
      planId: "plan-1",
      phaseId: task.phaseId,
      taskId: task.taskId,
      assignmentId: task.assignmentId,
      status: "completed",
      summary: `${task.taskId} done`,
      criteriaEvidence: [{ criteriaIndex: 0, evidence: `${task.taskId} evidence` }],
      artifacts: [],
    }));
    if (reports.length === 1) return reports[0];
    return JSON.stringify({ results: reports.map((output, index) => ({ stepId: request.tasks[index].assignmentId, output })) });
  }

  getSnapshot() {
    return { assignments: [], counts: { queued: 0, running: 0, blocked: 0, attention: 0, completed: 0, failed: 0, cancelled: 0, paused: 0, skipped: 0 } };
  }
}

class FailedReportLauncher extends CompletingLauncher {
  async getRunResult(): Promise<string | undefined> {
    const request = this.requests[this.requests.length - 1]!;
    const task = request.tasks[0];
    return JSON.stringify({
      planId: "plan-1",
      phaseId: task.phaseId,
      taskId: task.taskId,
      assignmentId: task.assignmentId,
      status: "failed",
      summary: "task failed",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "failure evidence" }],
    });
  }
}

class AttentionThenCompletingLauncher extends CompletingLauncher {
  async getRunResult(): Promise<string | undefined> {
    if (this.requests.length > 1) return super.getRunResult();
    const request = this.requests[this.requests.length - 1]!;
    const task = request.tasks[0];
    return JSON.stringify({
      planId: "plan-1",
      phaseId: task.phaseId,
      taskId: task.taskId,
      assignmentId: task.assignmentId,
      status: "attention",
      summary: "review found issues",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "review finding evidence" }],
      followUps: ["fix issue before resolving"],
    });
  }
}

class AlwaysAttentionLauncher extends AttentionThenCompletingLauncher {
  async getRunResult(): Promise<string | undefined> {
    const request = this.requests[this.requests.length - 1]!;
    const task = request.tasks[0];
    return JSON.stringify({
      planId: "plan-1",
      phaseId: task.phaseId,
      taskId: task.taskId,
      assignmentId: task.assignmentId,
      status: "attention",
      summary: this.requests.length > 1 ? "still unresolved" : "review found issues",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: this.requests.length > 1 ? "remaining issue evidence" : "review finding evidence" }],
      followUps: [this.requests.length > 1 ? "remaining issue" : "fix issue before resolving"],
    });
  }
}

class MixedFailureLauncher extends CompletingLauncher {
  async waitForRunSignal(): Promise<RunStatus> { return "failed"; }

  async getRunResult(): Promise<string | undefined> {
    const request = this.requests[this.requests.length - 1]!;
    const first = request.tasks[0];
    return JSON.stringify({
      results: [
        {
          stepId: first.assignmentId,
          output: JSON.stringify({
            planId: "plan-1",
            phaseId: first.phaseId,
            taskId: first.taskId,
            assignmentId: first.assignmentId,
            status: "completed",
            summary: "first done",
            criteriaEvidence: [{ criteriaIndex: 0, evidence: "first evidence" }],
          }),
        },
        { stepId: request.tasks[1].assignmentId, error: "second failed", success: false },
      ],
    });
  }
}

class SkippedUnhandledLauncher extends CompletingLauncher {
  async waitForRunSignal(_runId: string | undefined, options?: { onUpdate?: (snapshot: RunProgressSnapshot) => void | Promise<void> }): Promise<RunStatus> {
    const request = this.requests[this.requests.length - 1]!;
    await options?.onUpdate?.({
      runId: request.runId,
      status: "running",
      steps: [
        { id: request.tasks[0].assignmentId, status: "completed", agent: request.tasks[0].agent },
        { id: request.tasks[1].assignmentId, status: "skipped", agent: request.tasks[1].agent },
      ],
    });
    return "completed";
  }

  async getRunResult(): Promise<string | undefined> {
    const request = this.requests[this.requests.length - 1]!;
    const first = request.tasks[0];
    return JSON.stringify({
      results: [{
        stepId: first.assignmentId,
        output: JSON.stringify({
          planId: "plan-1",
          phaseId: first.phaseId,
          taskId: first.taskId,
          assignmentId: first.assignmentId,
          status: "completed",
          summary: "first done",
          criteriaEvidence: [{ criteriaIndex: 0, evidence: "first evidence" }],
        }),
      }],
    });
  }
}

class MismatchedReportLauncher extends CompletingLauncher {
  async getRunResult(): Promise<string | undefined> {
    const request = this.requests[this.requests.length - 1]!;
    const first = request.tasks[0];
    const second = request.tasks[1];
    return JSON.stringify({
      results: [
        {
          stepId: first.assignmentId,
          output: JSON.stringify({
            planId: "plan-1",
            phaseId: second.phaseId,
            taskId: second.taskId,
            assignmentId: second.assignmentId,
            status: "completed",
            summary: "wrong assignment report",
            criteriaEvidence: [{ criteriaIndex: 0, evidence: "wrong evidence" }],
          }),
        },
      ],
    });
  }
}

class FailingThenCompletingLauncher extends CompletingLauncher {
  async waitForRunSignal(): Promise<RunStatus> {
    return this.requests.length === 1 ? "failed" : "completed";
  }

  async getRunResult(): Promise<string | undefined> {
    if (this.requests.length === 1) return undefined;
    return super.getRunResult();
  }
}

class CancelSpyLauncher extends CompletingLauncher {
  cancelled: string[] = [];

  async cancelRun(runId: string, _ctx?: unknown): Promise<boolean> {
    this.cancelled.push(runId);
    return true;
  }
}

class RefusingControlLauncher extends CompletingLauncher {
  async stopRun(_runId: string, _ctx?: unknown): Promise<boolean> { return false; }
  async cancelRun(_runId: string, _ctx?: unknown): Promise<boolean> { return false; }
}

class StaleRunningLauncher extends CompletingLauncher {
  async waitForRunSignal(_runId: string | undefined, options?: { onUpdate?: (snapshot: RunProgressSnapshot) => void | Promise<void> }): Promise<RunStatus> {
    const request = this.requests[this.requests.length - 1]!;
    await options?.onUpdate?.({
      runId: request.runId,
      status: "running",
      steps: request.tasks.map((task) => ({ id: task.assignmentId, status: "running", agent: task.agent })),
    });
    return "running";
  }

  async getRunResult(): Promise<string | undefined> {
    return undefined;
  }
}

function restoreMixedRun(controller: TaskedSubagentsController, activeStatus: "running" | "attention" | "failed" | "blocked" | "cancelled" = "running") {
  controller.restoreState({
    version: 2,
    currentPlanId: "plan-1",
    updatedAt: 1,
    plans: [{
      id: "plan-1",
      title: "Plan",
      request: "Do it",
      spec: "Spec",
      status: activeStatus === "running" ? "running" : "attention",
      phases: [{
        id: "main",
        title: "Main",
        status: activeStatus === "running" ? "running" : "attention",
        dependsOn: [],
        maxConcurrency: 2,
        tasks: [
          {
            id: "done",
            text: "Done task",
            status: "completed",
            criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [{ criterionId: "C1", assignmentId: "a1", summary: "done", createdAt: 1 }] }],
            dependsOn: [],
            assignmentIds: ["a1"],
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "active",
            text: "Active task",
            status: activeStatus,
            criteria: [{ id: "C1", text: "Active", satisfied: false, evidence: [] }],
            dependsOn: [],
            assignmentIds: ["a2"],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      }],
      assignments: [
        {
          id: "a1",
          planId: "plan-1",
          phaseId: "main",
          taskId: "done",
          agent: "delegate",
          prompt: "done",
          status: "completed",
          runId: "run-1",
          result: { assignmentId: "a1", status: "completed", summary: "done", criteriaEvidence: [{ criteriaIndex: 0, criterionId: "C1", evidence: "done" }], artifacts: [], followUps: [], createdAt: 1 },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "a2",
          planId: "plan-1",
          phaseId: "main",
          taskId: "active",
          agent: "delegate",
          prompt: "active",
          status: activeStatus === "running" ? "running" : "paused",
          runId: "run-1",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      artifacts: [],
      createdAt: 1,
      updatedAt: 1,
    }],
  });
}

class StopSpyLauncher extends CompletingLauncher {
  stopped: string[] = [];

  async stopRun(runId: string, _ctx?: unknown): Promise<boolean> {
    this.stopped.push(runId);
    return true;
  }
}

class AssignmentScopedResultLauncher extends CompletingLauncher {
  async getRunResult(): Promise<string | undefined> {
    const request = this.requests[this.requests.length - 1]!;
    return JSON.stringify({
      runId: request.runId,
      results: [
        { stepId: request.tasks[0].assignmentId, output: "first output", summary: "first" },
        { stepId: request.tasks[1].assignmentId, output: "second output", summary: "second" },
      ],
    });
  }
}

class MissingAssignmentResultLauncher extends CompletingLauncher {
  async getRunResult(): Promise<string | undefined> {
    const request = this.requests[this.requests.length - 1]!;
    return JSON.stringify({
      runId: request.runId,
      results: [{ stepId: request.tasks[0].assignmentId, output: "first output", summary: "first" }],
    });
  }
}

class SingleRawResultLauncher extends CompletingLauncher {
  async getRunResult(): Promise<string | undefined> {
    return "single raw output";
  }
}

describe("TaskedSubagentsController", () => {
  test("accepts a plan and dispatches concrete task assignments", async () => {
    const launcher = new CompletingLauncher();
    const pi = fakePi();
    const controller = new TaskedSubagentsController(pi, { launcher });

    const accepted = await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", tasks: [{ id: "task", text: "Do task", criteria: ["Done"] }] }],
    });
    await controller.awaitLastWork();

    expect(accepted).toMatchObject({ accepted: true, planId: "plan-1" });
    expect(launcher.requests).toHaveLength(1);
    expect(launcher.requests[0].tasks[0]).toMatchObject({ phaseId: "main", taskId: "task", agent: "delegate" });
    const state = controller.getState();
    expect(state.plans[0].phases[0].tasks[0].status).toBe("completed");
    expect(state.plans[0].status).toBe("completed");
  });

  test("emits compact follow-up messages without raw task report JSON", async () => {
    const launcher = new CompletingLauncher();
    const pi = fakePi() as { sendMessage: ReturnType<typeof vi.fn> };
    const controller = new TaskedSubagentsController(pi as never, { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", tasks: [{ id: "task", text: "Do task", criteria: ["Done"] }] }],
    });
    await controller.awaitLastWork();

    const message = pi.sendMessage.mock.calls.at(-1)?.[0] as { content?: string; display?: boolean };
    expect(message.display).toBe(false);
    expect(message.content).toContain("[tasked-subagents] completed: plan-1 · Plan");
    expect(message.content).toContain("plan-1-main-task-a1");
    expect(message.content).toContain("task done");
    expect(message.content).toContain("Use tasked_subagents result plan-1-main-task-a1 for details.");
    expect(message.content).not.toContain("criteriaEvidence");
    expect(message.content).not.toContain('"planId"');
    expect(message.content).not.toContain("{");
  });

  test("one-off freeform ask becomes a one-phase one-task plan", async () => {
    const launcher = new CompletingLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });

    await controller.handleUserAsk("Inspect the controller");
    await controller.awaitLastWork();

    const plan = controller.getState().plans[0];
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].tasks).toHaveLength(1);
    expect(launcher.requests[0].tasks[0].taskId).toBe("task");
  });

  test("clear removes completed plans", async () => {
    const controller = new TaskedSubagentsController(fakePi(), { launcher: new CompletingLauncher() });
    await controller.acceptValidatedPlan({ title: "Plan", spec: "Spec", phases: [{ title: "Main", tasks: [{ text: "Do", criteria: ["Done"] }] }] });
    await controller.awaitLastWork();

    await expect(controller.clear()).resolves.toBe(1);
    expect(controller.getState().plans).toEqual([]);
  });

  test("treats stale running wait outcome as attention and emits follow-up", async () => {
    const launcher = new StaleRunningLauncher();
    const pi = {
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const controller = new TaskedSubagentsController(pi as never, { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", tasks: [{ id: "task", text: "Do task", criteria: ["Done"] }] }],
    });
    await controller.awaitLastWork();

    const plan = controller.getState().plans[0];
    expect(plan.assignments[0].status).toBe("attention");
    expect(plan.phases[0].tasks[0].status).toBe("attention");
    expect(plan.status).toBe("attention");
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "pi-tasked-subagents:attention",
      content: expect.stringContaining("attention"),
    }), expect.anything());
  });

  test("emits a failure follow-up when a completed run contains a failed task report", async () => {
    const launcher = new FailedReportLauncher();
    const pi = {
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const controller = new TaskedSubagentsController(pi as never, { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", tasks: [{ id: "task", text: "Do task", criteria: ["Done"] }] }],
    });
    await controller.awaitLastWork();

    expect(controller.getState().plans[0].status).toBe("failed");
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "pi-tasked-subagents:failure",
      content: expect.stringContaining("failed"),
    }), expect.anything());
  });

  test("applies successful child reports from a mixed failed task graph", async () => {
    const launcher = new MixedFailureLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", maxConcurrency: 2, tasks: [
        { id: "first", text: "Do first", criteria: ["First done"] },
        { id: "second", text: "Do second", criteria: ["Second done"] },
      ] }],
    });
    await controller.awaitLastWork();

    const [first, second] = controller.getState().plans[0].phases[0].tasks;
    expect(first.status).toBe("completed");
    expect(second.status).toBe("failed");
    expect(controller.getState().plans[0].status).toBe("failed");
  });

  test("preserves skipped child status when a terminal graph has no report for that child", async () => {
    const launcher = new SkippedUnhandledLauncher();
    const pi = {
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const controller = new TaskedSubagentsController(pi as never, { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", maxConcurrency: 2, tasks: [
        { id: "first", text: "Do first", criteria: ["First done"] },
        { id: "second", text: "Do second", criteria: ["Second done"] },
      ] }],
    });
    await controller.awaitLastWork();

    const plan = controller.getState().plans[0];
    expect(plan.assignments[0].status).toBe("completed");
    expect(plan.assignments[1].status).toBe("skipped");
    expect(plan.phases[0].tasks[1].status).toBe("blocked");
    expect(plan.phases[0].status).toBe("blocked");
    expect(plan.status).toBe("attention");
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "pi-tasked-subagents:attention",
      content: expect.stringContaining("plan: attention"),
    }), expect.objectContaining({ deliverAs: "followUp" }));
  });

  test("rejects a child report whose JSON assignment id does not match the launched step", async () => {
    const launcher = new MismatchedReportLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", maxConcurrency: 2, tasks: [
        { id: "first", text: "Do first", criteria: ["First done"] },
        { id: "second", text: "Do second", criteria: ["Second done"] },
      ] }],
    });
    await controller.awaitLastWork();

    const [first, second] = controller.getState().plans[0].phases[0].tasks;
    expect(first.status).toBe("attention");
    expect(second.status).toBe("attention");
    expect(second.criteria[0].satisfied).toBe(false);
  });

  test("rejected plan, phase, and task edits do not mutate existing records", async () => {
    async function setupController() {
      const controller = new TaskedSubagentsController(fakePi(), { launcher: new CompletingLauncher() });
      await controller.acceptValidatedPlan({
        title: "Plan",
        spec: "Spec",
        phases: [{ id: "main", title: "Main", tasks: [{ id: "task", text: "Do task", criteria: ["Done"] }] }],
      });
      await controller.awaitLastWork();
      return controller;
    }

    const planController = await setupController();
    await expect(planController.editPlan({ targetId: "plan-1", title: "" })).resolves.toMatchObject({ edited: false });
    expect(planController.getState().plans[0].title).toBe("Plan");

    const phaseController = await setupController();
    await expect(phaseController.editPlan({ targetId: "main", phase: { title: "", tasks: [{ id: "bad", text: "Bad", criteria: [] }] } })).resolves.toMatchObject({ edited: false });
    expect(phaseController.getState().plans[0].phases[0].title).toBe("Main");

    const taskController = await setupController();
    await expect(taskController.editPlan({ targetId: "task", task: { text: "", criteria: [] } })).resolves.toMatchObject({ edited: false });
    const task = taskController.getState().plans[0].phases[0].tasks[0];
    expect(task.text).toBe("Do task");
    expect(task.criteria).toHaveLength(1);
  });

  test("rejects invalid phase dependency edits without mutating or dispatching", async () => {
    const cases = [
      {
        name: "unknown phase",
        phaseId: "build",
        dependsOn: ["missing"],
        error: "Phase build depends on unknown phase missing",
      },
      {
        name: "self dependency",
        phaseId: "build",
        dependsOn: ["build"],
        error: "Phase build cannot depend on itself",
      },
      {
        name: "cycle",
        phaseId: "design",
        dependsOn: ["build"],
        error: "Phase dependency cycle detected",
      },
    ];

    for (const testCase of cases) {
      const launcher = new CompletingLauncher();
      const controller = new TaskedSubagentsController(fakePi(), { launcher });
      await controller.acceptValidatedPlan({
        title: "Plan",
        spec: "Spec",
        phases: [
          { id: "design", title: "Design", tasks: [{ id: "design-task", text: "Design task", criteria: ["Designed"] }] },
          { id: "build", title: "Build", dependsOn: ["design"], tasks: [{ id: "build-task", text: "Build task", criteria: ["Built"] }] },
        ],
      });
      await controller.awaitLastWork();

      const before = controller.getState().plans[0];
      const beforeDependsOn = before.phases.map((phase) => ({ id: phase.id, dependsOn: [...phase.dependsOn] }));
      const requestCount = launcher.requests.length;

      const result = await controller.editPlan({
        targetId: testCase.phaseId,
        phase: { title: `${testCase.name} edited`, dependsOn: testCase.dependsOn },
      });
      await controller.awaitLastWork();

      expect(result.edited).toBe(false);
      expect(result.errors.some((error) => error.includes(testCase.error))).toBe(true);
      const after = controller.getState().plans[0];
      expect(after.phases.map((phase) => ({ id: phase.id, dependsOn: phase.dependsOn }))).toEqual(beforeDependsOn);
      expect(after.phases.find((phase) => phase.id === testCase.phaseId)?.title).toBe(before.phases.find((phase) => phase.id === testCase.phaseId)?.title);
      expect(launcher.requests).toHaveLength(requestCount);
    }
  });

  test("rejects invalid task dependency edits without mutating or dispatching", async () => {
    const cases = [
      {
        name: "unknown task",
        taskId: "build-task",
        dependsOn: ["missing"],
        error: "Task build-task depends on unknown task missing",
      },
      {
        name: "self dependency",
        taskId: "build-task",
        dependsOn: ["build-task"],
        error: "Task build-task cannot depend on itself",
      },
      {
        name: "cycle",
        taskId: "design-task",
        dependsOn: ["build-task"],
        error: "Task dependency cycle detected",
      },
    ];

    for (const testCase of cases) {
      const launcher = new CompletingLauncher();
      const controller = new TaskedSubagentsController(fakePi(), { launcher });
      await controller.acceptValidatedPlan({
        title: "Plan",
        spec: "Spec",
        phases: [{ id: "main", title: "Main", tasks: [
          { id: "design-task", text: "Design task", criteria: ["Designed"] },
          { id: "build-task", text: "Build task", criteria: ["Built"], dependsOn: ["design-task"] },
        ] }],
      });
      await controller.awaitLastWork();

      const before = controller.getState().plans[0];
      const beforeTasks = before.phases[0].tasks.map((task) => ({ id: task.id, text: task.text, dependsOn: [...task.dependsOn], assignmentIds: [...task.assignmentIds] }));
      const requestCount = launcher.requests.length;

      const result = await controller.editPlan({
        targetId: testCase.taskId,
        task: { text: `${testCase.name} edited`, criteria: ["Still done"], dependsOn: testCase.dependsOn },
      });
      await controller.awaitLastWork();

      expect(result.edited).toBe(false);
      expect(result.errors.some((error) => error.includes(testCase.error))).toBe(true);
      const afterTasks = controller.getState().plans[0].phases[0].tasks.map((task) => ({ id: task.id, text: task.text, dependsOn: task.dependsOn, assignmentIds: task.assignmentIds }));
      expect(afterTasks).toEqual(beforeTasks);
      expect(launcher.requests).toHaveLength(requestCount);
    }
  });

  test("replacing phase tasks removes assignments and artifacts for old phase tasks", async () => {
    const controller = new TaskedSubagentsController(fakePi(), { launcher: new CompletingLauncher() });
    controller.restoreState({
      version: 2,
      currentPlanId: "plan-1",
      updatedAt: 1,
      plans: [{
        id: "plan-1",
        title: "Plan",
        request: "Do it",
        spec: "Spec",
        status: "completed",
        phases: [{
          id: "main",
          title: "Main",
          status: "completed",
          dependsOn: [],
          tasks: [{
            id: "old-task",
            text: "Old task",
            status: "completed",
            criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [{ criterionId: "C1", assignmentId: "old-a1", summary: "done", artifactPath: "old.md", createdAt: 1 }] }],
            dependsOn: [],
            assignmentIds: ["old-a1"],
            createdAt: 1,
            updatedAt: 1,
            completedAt: 1,
          }],
          createdAt: 1,
          updatedAt: 1,
          completedAt: 1,
        }],
        assignments: [{
          id: "old-a1",
          planId: "plan-1",
          phaseId: "main",
          taskId: "old-task",
          agent: "delegate",
          prompt: "Old task",
          status: "completed",
          result: { assignmentId: "old-a1", status: "completed", summary: "done", criteriaEvidence: [{ criteriaIndex: 0, criterionId: "C1", evidence: "done" }], artifacts: [{ label: "old", path: "old.md", assignmentId: "old-a1", phaseId: "main", taskId: "old-task" }], followUps: [], createdAt: 1 },
          createdAt: 1,
          updatedAt: 1,
          completedAt: 1,
        }],
        artifacts: [{ label: "old", path: "old.md", assignmentId: "old-a1", phaseId: "main", taskId: "old-task" }],
        createdAt: 1,
        updatedAt: 1,
        completedAt: 1,
      }],
    });

    const edited = await controller.editPlan({
      targetId: "main",
      phase: { tasks: [{ id: "new-task", text: "New task", criteria: ["New done"] }] },
    });

    expect(edited.edited).toBe(true);
    const state = controller.getState();
    expect(state.plans[0].phases[0].tasks.map((task) => task.id)).toEqual(["new-task"]);
    expect(state.plans[0].assignments.some((assignment) => assignment.taskId === "old-task")).toBe(false);
    expect(state.plans[0].artifacts.some((artifact) => artifact.taskId === "old-task")).toBe(false);
  });

  test("continue creates a new assignment with the continuation prompt", async () => {
    const launcher = new FailingThenCompletingLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", tasks: [{ id: "task", text: "Do task", criteria: ["Done"] }] }],
    });
    await controller.awaitLastWork();
    expect(controller.getState().plans[0].phases[0].tasks[0].status).toBe("failed");

    await expect(controller.continueTarget("task", "retry with missing evidence")).resolves.toBe(true);
    await controller.awaitLastWork();

    expect(launcher.requests).toHaveLength(2);
    expect(launcher.requests[1].tasks[0].prompt).toContain("retry with missing evidence");
    expect(controller.getState().plans[0].phases[0].tasks[0].status).toBe("completed");
  });

  test("continue after stop creates a new assignment with the continuation prompt", async () => {
    const launcher = new CompletingLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });
    controller.restoreState({
      version: 2,
      currentPlanId: "plan-1",
      updatedAt: 1,
      plans: [{
        id: "plan-1",
        title: "Plan",
        request: "Do it",
        spec: "Spec",
        status: "attention",
        phases: [{
          id: "main",
          title: "Main",
          status: "attention",
          dependsOn: [],
          tasks: [{
            id: "task",
            text: "Do task",
            status: "attention",
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
          status: "paused",
          runId: "run-1",
          createdAt: 1,
          updatedAt: 1,
        }],
        artifacts: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    await expect(controller.continueTarget("task", "resume after stop")).resolves.toBe(true);
    await controller.awaitLastWork();

    expect(launcher.requests).toHaveLength(1);
    expect(launcher.requests[0].tasks[0].prompt).toContain("resume after stop");
    expect(controller.getState().plans[0].assignments).toHaveLength(2);
  });

  test("stop preserves completed assignments while pausing active assignments in the same run", async () => {
    const launcher = new StopSpyLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });
    controller.restoreState({
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
          maxConcurrency: 2,
          tasks: [
            {
              id: "done",
              text: "Done task",
              status: "completed",
              criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [{ criterionId: "C1", assignmentId: "a1", summary: "done", createdAt: 1 }] }],
              dependsOn: [],
              assignmentIds: ["a1"],
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: "active",
              text: "Active task",
              status: "running",
              criteria: [{ id: "C1", text: "Active", satisfied: false, evidence: [] }],
              dependsOn: [],
              assignmentIds: ["a2"],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        }],
        assignments: [
          {
            id: "a1",
            planId: "plan-1",
            phaseId: "main",
            taskId: "done",
            agent: "delegate",
            prompt: "done",
            status: "completed",
            runId: "run-1",
            result: { assignmentId: "a1", status: "completed", summary: "done", criteriaEvidence: [{ criteriaIndex: 0, criterionId: "C1", evidence: "done" }], artifacts: [], followUps: [], createdAt: 1 },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "a2",
            planId: "plan-1",
            phaseId: "main",
            taskId: "active",
            agent: "delegate",
            prompt: "active",
            status: "running",
            runId: "run-1",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        artifacts: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    await expect(controller.stopRun("a2")).resolves.toBe(true);

    const [completed, active] = controller.getState().plans[0].assignments;
    expect(completed.status).toBe("completed");
    expect(active.status).toBe("paused");
  });

  test("stop resolves an assignment id to its owning run id", async () => {
    const launcher = new StopSpyLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", tasks: [{ id: "task", text: "Do task", criteria: ["Done"] }] }],
    });
    await controller.awaitLastWork();

    const assignment = controller.getState().plans[0].assignments[0];
    await expect(controller.stopRun(assignment.id)).resolves.toBe(true);

    expect(launcher.stopped).toEqual([assignment.runId]);
  });

  test("cancel resolves an assignment id and cancels non-final assignments in the same run", async () => {
    const launcher = new CancelSpyLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });
    restoreMixedRun(controller);

    await expect(controller.cancelRun("a2")).resolves.toBe(true);

    expect(launcher.cancelled).toEqual(["run-1"]);
    const [completed, active] = controller.getState().plans[0].assignments;
    expect(completed.status).toBe("completed");
    expect(active.status).toBe("cancelled");
    expect(controller.getState().plans[0].phases[0].tasks[1].status).toBe("cancelled");
  });

  test("failed stop and cancel launcher returns do not mutate state", async () => {
    const launcher = new RefusingControlLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });
    restoreMixedRun(controller);
    const beforeStop = JSON.stringify(controller.getState());

    await expect(controller.stopRun("a2")).resolves.toBe(false);
    expect(JSON.stringify(controller.getState())).toBe(beforeStop);

    await expect(controller.cancelRun("a2")).resolves.toBe(false);
    expect(JSON.stringify(controller.getState())).toBe(beforeStop);
  });

  test("clear all removes active and completed plans", async () => {
    const controller = new TaskedSubagentsController(fakePi(), { launcher: new CompletingLauncher() });
    restoreMixedRun(controller);

    await expect(controller.clear("all")).resolves.toBe(1);

    expect(controller.getState().plans).toEqual([]);
  });

  test("resolve relaunches an attention task with verification context and completes when resolved", async () => {
    const launcher = new AttentionThenCompletingLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", tasks: [{ id: "task", text: "Review task", criteria: ["Review resolved"] }] }],
    });
    await controller.awaitLastWork();
    expect(controller.getState().plans[0].status).toBe("attention");

    await expect(controller.resolveTarget("task", "Fixed in commit abc123")).resolves.toBe(true);
    await controller.awaitLastWork();

    expect(launcher.requests).toHaveLength(2);
    expect(launcher.requests[1].tasks[0]).toMatchObject({ taskId: "task" });
    expect(launcher.requests[1].tasks[0].prompt).toContain("Verification only");
    expect(launcher.requests[1].tasks[0].prompt).toContain("Fixed in commit abc123");
    expect(launcher.requests[1].tasks[0].prompt).toContain("review found issues");
    expect(launcher.requests[1].tasks[0].prompt).toContain("fix issue before resolving");
    const state = controller.getState();
    expect(state.plans[0].status).toBe("completed");
    expect(state.plans[0].phases[0].tasks[0].status).toBe("completed");
    expect(state.plans[0].assignments).toHaveLength(2);
  });

  test("continue clears stale completion timestamps when reopening completed work", async () => {
    const launcher = new CompletingLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", tasks: [{ id: "task", text: "Done task", criteria: ["Done"] }] }],
    });
    await controller.awaitLastWork();

    expect(controller.getState().plans[0].completedAt).toBeDefined();
    expect(controller.getState().plans[0].phases[0].completedAt).toBeDefined();
    expect(controller.getState().plans[0].phases[0].tasks[0].completedAt).toBeDefined();

    await expect(controller.continueTarget("task", "reopen for follow-up")).resolves.toBe(true);

    const reopened = controller.getState().plans[0];
    expect(reopened.completedAt).toBeUndefined();
    expect(reopened.phases[0].completedAt).toBeUndefined();
    expect(reopened.phases[0].tasks[0].completedAt).toBeUndefined();
    await controller.awaitLastWork();
  });

  test("resolve keeps the task in attention when verification still reports findings", async () => {
    const launcher = new AlwaysAttentionLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", tasks: [{ id: "task", text: "Review task", criteria: ["Review resolved"] }] }],
    });
    await controller.awaitLastWork();

    await expect(controller.resolveTarget("task", "Fixed in commit abc123")).resolves.toBe(true);
    await controller.awaitLastWork();

    const state = controller.getState();
    expect(state.plans[0].status).toBe("attention");
    expect(state.plans[0].phases[0].tasks[0].status).toBe("attention");
    expect(state.plans[0].assignments).toHaveLength(2);
    expect(state.plans[0].assignments[1].result?.summary).toBe("still unresolved");
  });

  test("continue by assignment id relaunches owning task with continuation text", async () => {
    const launcher = new CompletingLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });
    restoreMixedRun(controller, "attention");

    await expect(controller.continueTarget("a2", "resume by assignment")).resolves.toBe(true);
    await controller.awaitLastWork();

    expect(launcher.requests).toHaveLength(1);
    expect(launcher.requests[0].tasks[0]).toMatchObject({ taskId: "active" });
    expect(launcher.requests[0].tasks[0].prompt).toContain("resume by assignment");
  });

  test("continue by phase id readies only recoverable tasks in that phase", async () => {
    const launcher = new CompletingLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });
    controller.restoreState({
      version: 2,
      currentPlanId: "plan-1",
      updatedAt: 1,
      plans: [{
        id: "plan-1",
        title: "Plan",
        request: "Do it",
        spec: "Spec",
        status: "attention",
        phases: [{
          id: "main",
          title: "Main",
          status: "attention",
          dependsOn: [],
          maxConcurrency: 4,
          tasks: [
            { id: "attention", text: "Attention", status: "attention", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 },
            { id: "failed", text: "Failed", status: "failed", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 },
            { id: "blocked", text: "Blocked", status: "blocked", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 },
            { id: "cancelled", text: "Cancelled", status: "cancelled", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 },
            { id: "done", text: "Done", status: "completed", criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 },
          ],
          createdAt: 1,
          updatedAt: 1,
        }],
        assignments: [],
        artifacts: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    await expect(controller.continueTarget("main", "phase retry")).resolves.toBe(true);
    await controller.awaitLastWork();

    expect(launcher.requests[0].tasks.map((task) => task.taskId)).toEqual(["attention", "failed", "blocked", "cancelled"]);
    expect(controller.getState().plans[0].phases[0].tasks.find((task) => task.id === "done")?.status).toBe("completed");
  });

  test("returns only the requested assignment output from a multi-result run", async () => {
    const launcher = new AssignmentScopedResultLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", maxConcurrency: 2, tasks: [
        { id: "first", text: "Do first", criteria: ["First done"] },
        { id: "second", text: "Do second", criteria: ["Second done"] },
      ] }],
    });
    await controller.awaitLastWork();

    const [, second] = controller.getState().plans[0].assignments;
    const result = await controller.getRunResult(second.id);

    expect(result).toContain("second output");
    expect(result).not.toContain("first output");
    await expect(controller.getRunResult("unknown-assignment")).resolves.toBeUndefined();
  });

  test("returns undefined when multi-result output has no child for the assignment", async () => {
    const launcher = new MissingAssignmentResultLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", maxConcurrency: 2, tasks: [
        { id: "first", text: "Do first", criteria: ["First done"] },
        { id: "second", text: "Do second", criteria: ["Second done"] },
      ] }],
    });
    await controller.awaitLastWork();

    const [, second] = controller.getState().plans[0].assignments;
    await expect(controller.getRunResult(second.id)).resolves.toBeUndefined();
  });

  test("returns single raw run output unchanged", async () => {
    const launcher = new SingleRawResultLauncher();
    const controller = new TaskedSubagentsController(fakePi(), { launcher });

    await controller.acceptValidatedPlan({
      title: "Plan",
      spec: "Spec",
      phases: [{ id: "main", title: "Main", tasks: [{ id: "task", text: "Do task", criteria: ["Done"] }] }],
    });
    await controller.awaitLastWork();

    const assignment = controller.getState().plans[0].assignments[0];
    await expect(controller.getRunResult(assignment.id)).resolves.toBe("single raw output");
  });
});
