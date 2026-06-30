import { describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { TaskedSubagentsController } from "../src/orchestration/controller.js";
import type {
  AttachResult,
  EditGroupInput,
  EditGroupResult,
  EditTaskInput,
  EditTaskResult,
  LaunchTaskGraphRequest,
  RunProgressSnapshot,
  RunStatus,
  SetTasksInput,
  SetTasksResult,
  SubagentRunHandle,
  SubagentRuntime,
  TaskAssignmentRecord,
  TaskRunRecord,
  TaskedSubagentsState,
} from "../src/types.js";

interface TaskRunControllerApi {
  setTasks(input: SetTasksInput, ctx?: unknown): Promise<SetTasksResult>;
  editTask(input: EditTaskInput, ctx?: unknown): Promise<EditTaskResult>;
  editGroup(input: EditGroupInput, ctx?: unknown): Promise<EditGroupResult>;
  patchTaskRun(input: { taskRunId?: string; groups?: SetTasksInput["groups"]; tasks?: SetTasksInput["tasks"]; wait?: boolean }, ctx?: unknown): Promise<{ patched: boolean; taskRunId?: string; errors: string[]; dispatchScheduled: boolean }>;
  dispatchReady(options?: { taskRunId?: string; ctx?: unknown }): Promise<{ launched: number; skipped: number; errors: string[]; hasBlockingIssue: boolean }>;
  attachTarget(targetId?: string, ctx?: unknown): Promise<AttachResult>;
  continueTarget(targetId: string, prompt: string, ctx?: unknown): Promise<boolean>;
  resolveTarget(targetId: string, prompt: string, ctx?: unknown): Promise<boolean>;
  stopRun(assignmentId: string): Promise<boolean>;
  cancelRun(assignmentId: string): Promise<boolean>;
  clear(scope?: "completed" | "all"): Promise<number>;
  handleUserAsk(prompt: string, ctx?: unknown): Promise<unknown>;
  awaitLastWork(): Promise<void>;
  restoreState(state: TaskedSubagentsState): void;
  getState(): TaskedSubagentsState;
}

function fakePi(): ExtensionAPI {
  return {
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;
}

function asTaskRunApi(controller: TaskedSubagentsController): TaskRunControllerApi {
  return controller as unknown as TaskRunControllerApi;
}

class CompletingRuntime implements SubagentRuntime {
  requests: LaunchTaskGraphRequest[] = [];
  waitHandles: Array<SubagentRunHandle | undefined> = [];
  resultHandles: SubagentRunHandle[] = [];

  async launchTaskGraph(request: LaunchTaskGraphRequest): Promise<SubagentRunHandle> {
    this.requests.push(request);
    return {
      runId: request.runId,
      asyncId: `async-${request.runId}`,
      resultPath: `/tmp/${request.runId}.json`,
      assignments: request.tasks.map((task) => ({ assignmentId: task.assignmentId, runId: request.runId, resultPath: `/tmp/${request.runId}.json` })),
    };
  }

  async stopRun(_handle: SubagentRunHandle): Promise<boolean> { return true; }
  async cancelRun(_handle: SubagentRunHandle): Promise<boolean> { return true; }

  async waitForRunSignal(handle: SubagentRunHandle | undefined, options?: { onUpdate?: (snapshot: RunProgressSnapshot) => void | Promise<void> }): Promise<RunStatus> {
    this.waitHandles.push(handle);
    const request = this.requests.at(-1);
    if (request) await options?.onUpdate?.({
      runId: request.runId,
      status: "running",
      steps: request.tasks.map((task) => ({ id: task.assignmentId, status: "running", agent: task.agent })),
    });
    return "completed";
  }

  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    this.resultHandles.push(handle);
    const request = this.requests.find((candidate) => candidate.runId === handle.runId) ?? this.requests.at(-1);
    if (!request) return undefined;
    const reports = request.tasks.map((task) => JSON.stringify({
      taskRunId: task.taskRunId,
      ...(task.groupId ? { groupId: task.groupId } : {}),
      taskId: task.taskId,
      assignmentId: task.assignmentId,
      status: "completed",
      summary: `${task.taskId} done`,
      criteriaEvidence: [{ criteriaIndex: 0, evidence: `${task.taskId} evidence` }],
      artifacts: [],
      followUps: [],
    }));
    if (reports.length === 1) return reports[0];
    return JSON.stringify({ results: reports.map((output, index) => ({ stepId: request.tasks[index].assignmentId, output })) });
  }

  getSnapshot() {
    return { assignments: [], counts: { queued: 0, running: 0, blocked: 0, attention: 0, completed: 0, failed: 0, cancelled: 0, paused: 0, skipped: 0 } };
  }
}

class MalformedIdExpansionRuntime extends CompletingRuntime {
  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    this.resultHandles.push(handle);
    const request = this.requests.find((candidate) => candidate.runId === handle.runId) ?? this.requests.at(-1);
    const task = request?.tasks[0];
    if (!task) return undefined;
    return JSON.stringify({
      taskRunId: task.taskRunId,
      ...(task.groupId ? { groupId: task.groupId } : {}),
      taskId: task.taskId,
      assignmentId: task.assignmentId,
      status: "completed",
      summary: "Triage attempted malformed id task",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "Identified malformed follow-up" }],
      taskRunPatch: {
        tasks: [{ id: 42, group: "main", text: "Malformed id", criteria: ["Rejected"] }],
      },
    });
  }
}

class DuplicateExpansionRuntime extends CompletingRuntime {
  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    this.resultHandles.push(handle);
    const request = this.requests.find((candidate) => candidate.runId === handle.runId) ?? this.requests.at(-1);
    const task = request?.tasks[0];
    if (!task) return undefined;
    return JSON.stringify({
      taskRunId: task.taskRunId,
      ...(task.groupId ? { groupId: task.groupId } : {}),
      taskId: task.taskId,
      assignmentId: task.assignmentId,
      status: "completed",
      summary: "Triage attempted duplicate task",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "Identified duplicate follow-up" }],
      taskRunPatch: {
        tasks: [{ id: "triage", group: "main", text: "Replace triage", criteria: ["Replaced"] }],
      },
    });
  }
}

class ExpansionRuntime extends CompletingRuntime {
  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    this.resultHandles.push(handle);
    const request = this.requests.find((candidate) => candidate.runId === handle.runId) ?? this.requests.at(-1);
    const task = request?.tasks[0];
    if (!task) return undefined;
    if (task.taskId === "triage") {
      return JSON.stringify({
        taskRunId: task.taskRunId,
        ...(task.groupId ? { groupId: task.groupId } : {}),
        taskId: task.taskId,
        assignmentId: task.assignmentId,
        status: "completed",
        summary: "Triage produced review task",
        criteriaEvidence: [{ criteriaIndex: 0, evidence: "Identified review follow-up" }],
        taskRunPatch: {
          tasks: [{ id: "review", group: "main", text: "Review triage output", criteria: ["Reviewed"], dependsOn: ["triage"] }],
        },
      });
    }
    return super.getRunResult(handle);
  }
}

class DuplicateEvidenceRuntime extends CompletingRuntime {
  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    this.resultHandles.push(handle);
    const request = this.requests.find((candidate) => candidate.runId === handle.runId) ?? this.requests.at(-1);
    const task = request?.tasks[0];
    if (!task) return undefined;
    return JSON.stringify({
      taskRunId: task.taskRunId,
      ...(task.groupId ? { groupId: task.groupId } : {}),
      taskId: task.taskId,
      assignmentId: task.assignmentId,
      status: "completed",
      summary: "completed with extra evidence",
      criteriaEvidence: [
        { criteriaIndex: 0, evidence: "first criterion evidence" },
        { criteriaIndex: 1, evidence: "second criterion evidence" },
        { criteriaIndex: 1, evidence: "additional second criterion evidence" },
      ],
      artifacts: [],
      followUps: [],
    });
  }
}

class ControlledRuntime extends CompletingRuntime {
  private waitStartedResolve!: () => void;
  private waitResolve: ((status: RunStatus) => void) | undefined;
  private waitReject: ((error: Error) => void) | undefined;
  readonly waitStarted = new Promise<void>((resolve) => {
    this.waitStartedResolve = resolve;
  });

  async waitForRunSignal(handle: SubagentRunHandle | undefined): Promise<RunStatus> {
    this.waitHandles.push(handle);
    this.waitStartedResolve();
    return new Promise<RunStatus>((resolve, reject) => {
      this.waitResolve = resolve;
      this.waitReject = reject;
    });
  }

  complete(status: RunStatus = "completed"): void {
    this.waitResolve?.(status);
  }

  fail(error = new Error("wait failed")): void {
    this.waitReject?.(error);
  }
}

class ResultControlledRuntime extends CompletingRuntime {
  private resultStartedResolve!: () => void;
  private resultResolve: (() => void) | undefined;
  readonly resultStarted = new Promise<void>((resolve) => {
    this.resultStartedResolve = resolve;
  });

  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    this.resultStartedResolve();
    await new Promise<void>((resolve) => {
      this.resultResolve = resolve;
    });
    return super.getRunResult(handle);
  }

  releaseResult(): void {
    this.resultResolve?.();
  }
}

class FirstResultControlledRuntime extends CompletingRuntime {
  private resultStartedResolve!: () => void;
  private resultReleaseResolve: (() => void) | undefined;
  private blocked = false;
  readonly resultStarted = new Promise<void>((resolve) => {
    this.resultStartedResolve = resolve;
  });

  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    if (!this.blocked) {
      this.blocked = true;
      this.resultStartedResolve();
      await new Promise<void>((resolve) => {
        this.resultReleaseResolve = resolve;
      });
    }
    return super.getRunResult(handle);
  }

  releaseResult(): void {
    this.resultReleaseResolve?.();
  }
}

class ControlledSpyRuntime extends ControlledRuntime {
  stopped: SubagentRunHandle[] = [];
  cancelled: SubagentRunHandle[] = [];

  async stopRun(handle: SubagentRunHandle): Promise<boolean> {
    this.stopped.push(handle);
    return true;
  }

  async cancelRun(handle: SubagentRunHandle): Promise<boolean> {
    this.cancelled.push(handle);
    return true;
  }
}

class LaunchControlledRuntime extends CompletingRuntime {
  cancelled: SubagentRunHandle[] = [];
  private launchStartedResolve!: () => void;
  private launchReleaseResolve: (() => void) | undefined;
  readonly launchStarted = new Promise<void>((resolve) => {
    this.launchStartedResolve = resolve;
  });

  async launchTaskGraph(request: LaunchTaskGraphRequest): Promise<SubagentRunHandle> {
    this.requests.push(request);
    this.launchStartedResolve();
    await new Promise<void>((resolve) => {
      this.launchReleaseResolve = resolve;
    });
    return {
      runId: request.runId,
      asyncId: `async-${request.runId}`,
      resultPath: `/tmp/${request.runId}.json`,
      assignments: request.tasks.map((task) => ({ assignmentId: task.assignmentId, runId: request.runId, resultPath: `/tmp/${request.runId}.json` })),
    };
  }

  releaseLaunch(): void {
    this.launchReleaseResolve?.();
  }

  async cancelRun(handle: SubagentRunHandle): Promise<boolean> {
    this.cancelled.push(handle);
    return true;
  }
}

class LaunchRejectControlledRuntime extends CompletingRuntime {
  private launchStartedResolve!: () => void;
  private launchReject: ((error: Error) => void) | undefined;
  readonly launchStarted = new Promise<void>((resolve) => {
    this.launchStartedResolve = resolve;
  });

  async launchTaskGraph(request: LaunchTaskGraphRequest): Promise<SubagentRunHandle> {
    this.requests.push(request);
    this.launchStartedResolve();
    return new Promise<SubagentRunHandle>((_resolve, reject) => {
      this.launchReject = reject;
    });
  }

  rejectLaunch(error = new Error("launch failed")): void {
    this.launchReject?.(error);
  }
}

class MultiLaunchControlledRuntime extends CompletingRuntime {
  cancelled: SubagentRunHandle[] = [];
  private readonly launchResolvers: Array<() => void> = [];

  async launchTaskGraph(request: LaunchTaskGraphRequest): Promise<SubagentRunHandle> {
    this.requests.push(request);
    await new Promise<void>((resolve) => {
      this.launchResolvers.push(resolve);
    });
    return {
      runId: request.runId,
      asyncId: `async-${request.runId}`,
      resultPath: `/tmp/${request.runId}.json`,
      assignments: request.tasks.map((task) => ({ assignmentId: task.assignmentId, runId: request.runId, resultPath: `/tmp/${request.runId}.json` })),
    };
  }

  releaseLaunch(index: number): void {
    this.launchResolvers[index]?.();
  }

  async cancelRun(handle: SubagentRunHandle): Promise<boolean> {
    this.cancelled.push(handle);
    return true;
  }
}

class CompletedProgressFailRuntime extends CompletingRuntime {
  private waitStartedResolve!: () => void;
  private waitReject: ((error: Error) => void) | undefined;
  readonly waitStarted = new Promise<void>((resolve) => {
    this.waitStartedResolve = resolve;
  });

  async waitForRunSignal(
    handle: SubagentRunHandle | undefined,
    options?: { onUpdate?: (snapshot: RunProgressSnapshot) => void | Promise<void> },
  ): Promise<RunStatus> {
    this.waitHandles.push(handle);
    const request = this.requests.at(-1);
    if (request) await options?.onUpdate?.({
      runId: request.runId,
      status: "running",
      steps: request.tasks.map((task) => ({ id: task.assignmentId, status: "completed", agent: task.agent })),
    });
    this.waitStartedResolve();
    return new Promise<RunStatus>((_resolve, reject) => {
      this.waitReject = reject;
    });
  }

  fail(error = new Error("wait failed")): void {
    this.waitReject?.(error);
  }
}

class CompletedProgressNoResultRuntime extends CompletingRuntime {
  async waitForRunSignal(
    handle: SubagentRunHandle | undefined,
    options?: { onUpdate?: (snapshot: RunProgressSnapshot) => void | Promise<void> },
  ): Promise<RunStatus> {
    this.waitHandles.push(handle);
    const request = this.requests.at(-1);
    if (request) await options?.onUpdate?.({
      runId: request.runId,
      status: "running",
      steps: request.tasks.map((task) => ({ id: task.assignmentId, status: "completed", agent: task.agent })),
    });
    return "completed";
  }

  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    this.resultHandles.push(handle);
    return undefined;
  }
}

class AttentionThenCompletingRuntime extends CompletingRuntime {
  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    const request = this.requests.find((candidate) => candidate.runId === handle.runId) ?? this.requests.at(-1);
    if (!request) return undefined;
    const task = request.tasks[0];
    const firstAttempt = this.requests.indexOf(request) === 0;
    return JSON.stringify({
      taskRunId: task.taskRunId,
      ...(task.groupId ? { groupId: task.groupId } : {}),
      taskId: task.taskId,
      assignmentId: task.assignmentId,
      status: firstAttempt ? "attention" : "completed",
      summary: firstAttempt ? "review found issues" : "verification passed",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: firstAttempt ? "review finding evidence" : "verified" }],
      followUps: firstAttempt ? ["fix issue before resolving"] : [],
    });
  }
}

class StopSpyRuntime extends CompletingRuntime {
  stopped: SubagentRunHandle[] = [];
  async stopRun(handle: SubagentRunHandle): Promise<boolean> {
    this.stopped.push(handle);
    return true;
  }
}

class CancelSpyRuntime extends CompletingRuntime {
  cancelled: SubagentRunHandle[] = [];
  async cancelRun(handle: SubagentRunHandle): Promise<boolean> {
    this.cancelled.push(handle);
    return true;
  }
}

class SignalRuntime extends CompletingRuntime {
  constructor(private readonly signalStatus: RunStatus) {
    super();
  }

  async waitForRunSignal(): Promise<RunStatus> {
    return this.signalStatus;
  }

  async getRunResult(_handle: SubagentRunHandle): Promise<string | undefined> {
    return undefined;
  }
}

function controllerWith(runtime: SubagentRuntime = new CompletingRuntime()): { controller: TaskRunControllerApi; runtime: SubagentRuntime } {
  const controller = new TaskedSubagentsController(fakePi(), { launcher: runtime });
  return { controller: asTaskRunApi(controller), runtime };
}

function markRunLive(controller: TaskRunControllerApi, runId: string): void {
  (controller as unknown as { liveRunIds: Set<string> }).liveRunIds.add(runId);
}

const baseSetTasks = {
  taskRunId: "task-run-1",
  title: "Task run",
  request: "Ship the feature",
  context: "Repo context",
  groups: [{ id: "main", title: "Main", maxConcurrency: 2 }],
  tasks: [{ id: "task", group: "main", text: "Do task", criteria: ["Done"], agentHint: "delegate" }],
} satisfies SetTasksInput;

function launchRef(): SubagentRunHandle {
  return {
    runId: "run-1",
    asyncId: "async-run-1",
    resultPath: "/tmp/run-1.json",
    assignments: [
      { assignmentId: "a1", runId: "run-1", resultPath: "/tmp/run-1.json" },
      { assignmentId: "a2", runId: "run-1", resultPath: "/tmp/run-1.json" },
    ],
  };
}

function recoverableState(status: TaskAssignmentRecord["status"] = "attention"): TaskedSubagentsState {
  const ref = launchRef();
  const run: TaskRunRecord = {
    id: "task-run-1",
    title: "Task run",
    request: "Ship it",
    context: "Context",
    status: "attention",
    groups: [{ id: "main", title: "Main", status: "attention", dependsOn: [], maxConcurrency: 4, createdAt: 1, updatedAt: 1 }],
    tasks: [
      { id: "attention", groupId: "main", text: "Attention task", status: "attention", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: ["a1"], createdAt: 1, updatedAt: 1 },
      { id: "failed", groupId: "main", text: "Failed task", status: "failed", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: ["a2"], createdAt: 1, updatedAt: 1 },
      { id: "done", groupId: "main", text: "Done task", status: "completed", criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 },
    ],
    assignments: [
      { id: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "attention", agent: "delegate", prompt: "attention", status, runId: "run-1", launchRef: ref, createdAt: 1, updatedAt: 1 },
      { id: "a2", taskRunId: "task-run-1", groupId: "main", taskId: "failed", agent: "delegate", prompt: "failed", status: "failed", runId: "run-1", launchRef: ref, createdAt: 1, updatedAt: 1 },
    ],
    artifacts: [],
    createdAt: 1,
    updatedAt: 1,
  };
  return { version: 4, taskRuns: [run], currentTaskRunId: "task-run-1", updatedAt: 1 };
}

describe("TaskedSubagentsController TaskRun public API", () => {
  test("setTasks creates a TaskRun and dispatches assignments with taskRunId prompts", async () => {
    const runtime = new CompletingRuntime();
    const { controller } = controllerWith(runtime);

    await expect(controller.setTasks(baseSetTasks)).resolves.toMatchObject({ accepted: true, taskRunId: "task-run-1", dispatchScheduled: true });
    await controller.awaitLastWork();

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0].tasks[0]).toMatchObject({ taskRunId: "task-run-1", groupId: "main", taskId: "task", agent: "delegate" });
    expect(runtime.requests[0].tasks[0].prompt).toContain("taskRunId");
    expect(runtime.requests[0].tasks[0].prompt).toContain("task-run-1");
    expect(runtime.requests[0].tasks[0].prompt).not.toContain("planId");
    const state = controller.getState();
    expect(state).toMatchObject({ version: 4, currentTaskRunId: "task-run-1" });
    expect(state.taskRuns[0].tasks[0].status).toBe("completed");
    expect(state.taskRuns[0].status).toBe("completed");
  });

  test("completed dispatch accepts duplicate criterion evidence when all criteria are covered", async () => {
    const { controller } = controllerWith(new DuplicateEvidenceRuntime());

    await controller.setTasks({
      ...baseSetTasks,
      tasks: [{ id: "task", group: "main", text: "Do task", criteria: ["First", "Second"], agentHint: "delegate" }],
    });
    await controller.awaitLastWork();

    const taskRun = controller.getState().taskRuns[0];
    expect(taskRun.status).toBe("completed");
    expect(taskRun.assignments[0].status).toBe("completed");
    expect(taskRun.tasks[0].status).toBe("completed");
    expect(taskRun.tasks[0].criteria[1].evidence.map((evidence) => evidence.summary)).toEqual([
      "second criterion evidence",
      "additional second criterion evidence",
    ]);
  });

  test("triage expansion appends visible tasks to the same TaskRun and continues dispatch", async () => {
    const runtime = new ExpansionRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks({
      ...baseSetTasks,
      tasks: [{ id: "triage", group: "main", text: "Plan review work", criteria: ["Plan produced"], expansionMode: "append_tasks" }],
      wait: true,
    });

    const taskRun = controller.getState().taskRuns[0];
    expect(taskRun.tasks.map((task) => task.id)).toEqual(["triage", "review"]);
    expect(taskRun.tasks.find((task) => task.id === "triage")?.status).toBe("completed");
    expect(taskRun.tasks.find((task) => task.id === "review")?.status).toBe("completed");
    expect(runtime.requests.map((request) => request.tasks.map((task) => task.taskId))).toEqual([["triage"], ["review"]]);
  });

  test("triage expansion malformed task ids mark visible task attention without throwing", async () => {
    const runtime = new MalformedIdExpansionRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks({
      ...baseSetTasks,
      tasks: [{ id: "triage", group: "main", text: "Plan review work", criteria: ["Plan produced"], expansionMode: "append_tasks" }],
      wait: true,
    });

    const taskRun = controller.getState().taskRuns[0];
    expect(taskRun.tasks.map((task) => task.id)).toEqual(["triage"]);
    expect(taskRun.tasks[0].status).toBe("attention");
    expect(taskRun.assignments[0].status).toBe("attention");
    expect(taskRun.assignments[0].result?.followUps).toContain("Patch task 1 id is required");
  });

  test("triage expansion duplicate task ids mark visible task attention without hidden work", async () => {
    const runtime = new DuplicateExpansionRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks({
      ...baseSetTasks,
      tasks: [{ id: "triage", group: "main", text: "Plan review work", criteria: ["Plan produced"], expansionMode: "append_tasks" }],
      wait: true,
    });

    const taskRun = controller.getState().taskRuns[0];
    expect(taskRun.tasks.map((task) => task.id)).toEqual(["triage"]);
    expect(taskRun.tasks[0].status).toBe("attention");
    expect(taskRun.assignments).toHaveLength(1);
    expect(taskRun.assignments[0].status).toBe("attention");
    expect(taskRun.assignments[0].result?.followUps).toContain("Task triage already exists; use edit_task to modify existing tasks");
    expect(runtime.requests.map((request) => request.tasks.map((task) => task.taskId))).toEqual([["triage"]]);
  });

  test("setTasks appends a new task run when taskRunId is omitted", async () => {
    const { controller } = controllerWith(new CompletingRuntime());

    await controller.setTasks(baseSetTasks);
    await controller.awaitLastWork();
    const { taskRunId: _omittedTaskRunId, ...nextTasks } = baseSetTasks;
    await expect(controller.setTasks({ ...nextTasks, title: "Next", tasks: [{ id: "next", group: "main", text: "Do next", criteria: ["Done"] }] })).resolves.toMatchObject({ accepted: true, taskRunId: "task-run-2" });

    const state = controller.getState();
    expect(state.taskRuns.map((run) => run.id)).toEqual(["task-run-1", "task-run-2"]);
    expect(state.taskRuns[1].title).toBe("Next");
    expect(state.taskRuns[1].tasks.map((task) => task.id)).toEqual(["next"]);
  });

  test("setTasks replaces an existing task run when taskRunId is explicit", async () => {
    const { controller } = controllerWith(new CompletingRuntime());

    await controller.setTasks(baseSetTasks);
    await controller.awaitLastWork();
    await expect(controller.setTasks({ ...baseSetTasks, taskRunId: "task-run-1", title: "Replacement", tasks: [{ id: "replacement", group: "main", text: "Do replacement", criteria: ["Done"] }] })).resolves.toMatchObject({ accepted: true, taskRunId: "task-run-1" });

    const state = controller.getState();
    expect(state.taskRuns.map((run) => run.id)).toEqual(["task-run-1"]);
    expect(state.taskRuns[0].title).toBe("Replacement");
    expect(state.taskRuns[0].tasks.map((task) => task.id)).toEqual(["replacement"]);
    expect(state.taskRuns[0].assignments.some((assignment) => assignment.taskId === "task")).toBe(false);
  });

  test("patchTaskRun appends visible tasks without replacing completed task history", async () => {
    const runtime = new CompletingRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks(baseSetTasks);
    await controller.awaitLastWork();
    const beforePatch = controller.getState().taskRuns[0];
    const originalAssignmentId = beforePatch.assignments[0].id;
    expect(beforePatch.status).toBe("completed");

    await expect(controller.patchTaskRun({
      taskRunId: "task-run-1",
      tasks: [{ id: "review", group: "main", text: "Review generated follow-up", criteria: ["Reviewed"], dependsOn: ["task"] }],
      wait: true,
    })).resolves.toMatchObject({ patched: true, taskRunId: "task-run-1", dispatchScheduled: true });

    const taskRun = controller.getState().taskRuns[0];
    expect(taskRun.tasks.map((task) => task.id)).toEqual(["task", "review"]);
    expect(taskRun.assignments.some((assignment) => assignment.id === originalAssignmentId)).toBe(true);
    expect(taskRun.tasks[0]).toMatchObject({ id: "task", status: "completed", assignmentIds: [originalAssignmentId] });
    expect(taskRun.tasks[1]).toMatchObject({ id: "review", status: "completed" });
    expect(runtime.requests.map((request) => request.tasks.map((task) => task.taskId))).toEqual([["task"], ["review"]]);
  });

  test("patchTaskRun schedules existing tasks after existing group dependency changes", async () => {
    const runtime = new CompletingRuntime();
    const { controller } = controllerWith(runtime);
    const blockedState: TaskedSubagentsState = {
      version: 4,
      currentTaskRunId: "task-run-1",
      updatedAt: 1,
      taskRuns: [{
        id: "task-run-1",
        title: "Task run",
        request: "Ship the feature",
        context: "Repo context",
        status: "attention",
        groups: [
          { id: "gate", title: "Gate", status: "attention", dependsOn: [], maxConcurrency: 1, createdAt: 1, updatedAt: 1 },
          { id: "main", title: "Main", status: "pending", dependsOn: ["gate"], maxConcurrency: 1, createdAt: 1, updatedAt: 1 },
        ],
        tasks: [
          { id: "gate-task", groupId: "gate", text: "Gate task", status: "attention", criteria: [{ id: "C1", text: "Gate done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 },
          { id: "main-task", groupId: "main", text: "Main task", status: "pending", criteria: [{ id: "C1", text: "Main done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 },
        ],
        assignments: [],
        artifacts: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    controller.restoreState(blockedState);

    await expect(controller.patchTaskRun({ taskRunId: "task-run-1", groups: [{ id: "main", dependsOn: [] }], wait: true }))
      .resolves.toMatchObject({ patched: true, dispatchScheduled: true });

    expect(runtime.requests.map((request) => request.tasks.map((task) => task.taskId))).toEqual([["main-task"]]);
    expect(controller.getState().taskRuns[0].tasks.find((task) => task.id === "main-task")?.status).toBe("completed");
  });

  test("patchTaskRun rejects duplicate task ids instead of replacing existing tasks", async () => {
    const { controller } = controllerWith(new CompletingRuntime());

    await controller.setTasks(baseSetTasks);
    await controller.awaitLastWork();
    const beforePatch = controller.getState().taskRuns[0];

    await expect(controller.patchTaskRun({
      taskRunId: "task-run-1",
      tasks: [{ id: "task", group: "main", text: "Replace task", criteria: ["Replaced"] }],
    })).resolves.toMatchObject({ patched: false, dispatchScheduled: false, errors: ["Task task already exists; use edit_task to modify existing tasks"] });

    expect(controller.getState().taskRuns[0]).toEqual(beforePatch);
  });

  test("patchTaskRun does not invalidate an active dispatch result", async () => {
    const runtime = new FirstResultControlledRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks(baseSetTasks);
    await runtime.resultStarted;

    await expect(controller.patchTaskRun({
      taskRunId: "task-run-1",
      tasks: [{ id: "review", group: "main", text: "Review after task", criteria: ["Reviewed"], dependsOn: ["task"] }],
    })).resolves.toMatchObject({ patched: true, taskRunId: "task-run-1", dispatchScheduled: true });

    runtime.releaseResult();
    await controller.awaitLastWork();

    const taskRun = controller.getState().taskRuns[0];
    expect(taskRun.tasks.find((task) => task.id === "task")?.status).toBe("completed");
    expect(taskRun.assignments.find((assignment) => assignment.taskId === "task")?.result?.summary).toBe("task done");
    expect(taskRun.tasks.find((task) => task.id === "review")?.status).toBe("completed");
  });

  test("editTask patches one task and reschedules only that task", async () => {
    const runtime = new CompletingRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks({
      ...baseSetTasks,
      tasks: [
        { id: "first", group: "main", text: "Do first", criteria: ["First done"] },
        { id: "second", group: "main", text: "Do second", criteria: ["Second done"] },
      ],
    });
    await controller.awaitLastWork();

    await expect(controller.editTask({ taskRunId: "task-run-1", targetId: "second", task: { text: "Do second again", criteria: ["Second redone"] } })).resolves.toMatchObject({ edited: true, taskRunId: "task-run-1", taskId: "second", dispatchScheduled: true });
    await controller.awaitLastWork();

    expect(runtime.requests.at(-1)?.tasks.map((task) => task.taskId)).toEqual(["second"]);
    const second = controller.getState().taskRuns[0].tasks.find((task) => task.id === "second");
    expect(second).toMatchObject({ text: "Do second again", status: "completed" });
    expect(second?.criteria.map((criterion) => criterion.text)).toEqual(["Second redone"]);
  });

  test("editGroup patches group concurrency and dependencies without phase ids", async () => {
    const { controller } = controllerWith(new CompletingRuntime());

    await controller.setTasks({
      taskRunId: "task-run-1",
      title: "Grouped run",
      request: "Ship groups",
      groups: [
        { id: "setup", title: "Setup" },
        { id: "deploy", title: "Deploy" },
      ],
      tasks: [
        { id: "setup-task", group: "setup", text: "Setup", criteria: ["Setup done"] },
        { id: "deploy-task", group: "deploy", text: "Deploy", criteria: ["Deploy done"] },
      ],
    });
    await controller.awaitLastWork();

    await expect(controller.editGroup({ taskRunId: "task-run-1", targetId: "deploy", group: { dependsOn: ["setup"], maxConcurrency: 2 } })).resolves.toMatchObject({ edited: true, taskRunId: "task-run-1", groupId: "deploy" });

    const deploy = controller.getState().taskRuns[0].groups.find((group) => group.id === "deploy");
    expect(deploy).toMatchObject({ dependsOn: ["setup"], maxConcurrency: 2 });
    expect(JSON.stringify(controller.getState())).not.toContain("phaseId");
  });

  test("setTasks wait mode blocks until scheduled task work finishes", async () => {
    const runtime = new ControlledRuntime();
    const { controller } = controllerWith(runtime);

    let settled = false;
    const accepted = controller.setTasks({ ...baseSetTasks, wait: true }).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    await runtime.waitStarted;
    await Promise.resolve();

    expect(settled).toBe(false);

    runtime.complete();

    await expect(accepted).resolves.toMatchObject({ accepted: true, taskRunId: "task-run-1" });
    expect(controller.getState().taskRuns[0].status).toBe("completed");
    expect(controller.getState().taskRuns[0].assignments[0].result?.summary).toBe("task done");
  });

  test("attachTarget fails fast for unknown explicit targets without waiting on unrelated work", async () => {
    const runtime = new ControlledRuntime();
    const { controller } = controllerWith(runtime);

    await expect(controller.setTasks(baseSetTasks)).resolves.toMatchObject({ accepted: true, taskRunId: "task-run-1" });
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    await runtime.waitStarted;

    let settled = false;
    await expect(controller.attachTarget("missing-target").then((result) => {
      settled = true;
      return result;
    })).resolves.toMatchObject({
      attached: false,
      targetId: "missing-target",
      report: "Attach target not found: missing-target.",
    });

    expect(settled).toBe(true);
    expect(controller.getState().taskRuns[0].status).toBe("running");

    runtime.complete();
    await controller.awaitLastWork();
  });

  test("attachTarget waits for scheduled task work before returning results", async () => {
    const runtime = new ControlledRuntime();
    const { controller } = controllerWith(runtime);

    await expect(controller.setTasks(baseSetTasks)).resolves.toMatchObject({ accepted: true, taskRunId: "task-run-1" });
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    await runtime.waitStarted;

    let settled = false;
    const attached = controller.attachTarget("task-run-1").then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();

    expect(settled).toBe(false);

    runtime.complete();

    await expect(attached).resolves.toMatchObject({
      attached: true,
      targetId: "task-run-1",
    });
    await expect(attached).resolves.toMatchObject({
      report: expect.stringContaining("Assignment: task-run-1-group-main-task-task-assignment-1"),
    });
    expect(controller.getState().taskRuns[0].status).toBe("completed");
    expect(controller.getState().taskRuns[0].assignments[0].result?.summary).toBe("task done");
  });

  test("dispatchReady launches ready assignments for the requested taskRunId only", async () => {
    const runtime = new CompletingRuntime();
    const { controller } = controllerWith(runtime);

    controller.restoreState({
      version: 4,
      currentTaskRunId: "task-run-2",
      updatedAt: 1,
      taskRuns: [
        {
          id: "task-run-1",
          title: "First run",
          request: "Run one",
          context: "Run one",
          status: "pending",
          groups: [],
          tasks: [{ id: "one", text: "One", status: "pending", criteria: [{ id: "C1", text: "One done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 }],
          assignments: [],
          artifacts: [],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "task-run-2",
          title: "Second run",
          request: "Run two",
          context: "Run two",
          status: "pending",
          groups: [],
          tasks: [{ id: "two", text: "Two", status: "pending", criteria: [{ id: "C1", text: "Two done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 }],
          assignments: [],
          artifacts: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    await expect(controller.dispatchReady({ taskRunId: "task-run-2" })).resolves.toMatchObject({ launched: 1, errors: [] });
    await controller.awaitLastWork();

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0].tasks.map((task) => task.taskRunId)).toEqual(["task-run-2"]);
    expect(runtime.requests[0].tasks.map((task) => task.taskId)).toEqual(["two"]);
  });

  test.each([
    ["taskRunId", "task-run-1", ["attention", "failed"]],
    ["groupId", "main", ["attention", "failed"]],
    ["taskId", "attention", ["attention"]],
    ["assignmentId", "a1", ["attention"]],
  ] as const)("continueTarget accepts %s", async (_kind, targetId, expectedTaskIds) => {
    const runtime = new CompletingRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState());

    await expect(controller.continueTarget(targetId, "resume with context")).resolves.toBe(true);
    await controller.awaitLastWork();

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0].tasks.map((task) => task.taskId)).toEqual(expectedTaskIds);
    expect(runtime.requests[0].tasks[0].prompt).toContain("resume with context");
  });

  test.each([
    ["taskRunId", "task-run-1", ["attention", "failed"]],
    ["groupId", "main", ["attention", "failed"]],
    ["taskId", "attention", ["attention"]],
    ["assignmentId", "a1", ["attention"]],
  ] as const)("resolveTarget accepts %s", async (_kind, targetId, expectedTaskIds) => {
    const runtime = new AttentionThenCompletingRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState());

    await expect(controller.resolveTarget(targetId, "Fixed in commit abc123")).resolves.toBe(true);
    await controller.awaitLastWork();

    expect(runtime.requests.at(-1)?.tasks.map((task) => task.taskId)).toEqual(expectedTaskIds);
    expect(runtime.requests.at(-1)?.tasks[0].prompt).toContain("Verification only");
    expect(runtime.requests.at(-1)?.tasks[0].prompt).toContain("Fixed in commit abc123");
  });

  test("stopRun uses the assignment launch handle without plan ids", async () => {
    const runtime = new StopSpyRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState("running"));
    markRunLive(controller, "run-1");

    await expect(controller.stopRun("a1")).resolves.toBe(true);

    expect(runtime.stopped).toEqual([launchRef()]);
    expect(JSON.stringify(runtime.stopped[0])).not.toContain("planId");
    expect(controller.getState().taskRuns[0].assignments.find((assignment) => assignment.id === "a1")?.status).toBe("paused");
  });

  test("cancelRun uses the assignment launch handle and cancels non-final assignments in the same run", async () => {
    const runtime = new CancelSpyRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState("running"));
    markRunLive(controller, "run-1");

    await expect(controller.cancelRun("a1")).resolves.toBe(true);

    expect(runtime.cancelled).toEqual([launchRef()]);
    expect(JSON.stringify(runtime.cancelled[0])).not.toContain("planId");
    const assignments = controller.getState().taskRuns[0].assignments;
    expect(assignments.find((assignment) => assignment.id === "a1")?.status).toBe("cancelled");
    expect(assignments.find((assignment) => assignment.id === "a2")?.status).toBe("failed");
  });

  test("cancelRun marks an attention assignment without signalling stale pids", async () => {
    const runtime = new CancelSpyRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState("attention"));

    await expect(controller.cancelRun("a1")).resolves.toBe(true);

    expect(runtime.cancelled).toEqual([]);
    expect(controller.getState().taskRuns[0].assignments.find((assignment) => assignment.id === "a1")?.status).toBe("cancelled");
  });

  test("cancelRun marks a stale running assignment without signalling stale pids", async () => {
    const runtime = new CancelSpyRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState("running"));

    await expect(controller.cancelRun("a1")).resolves.toBe(true);

    expect(runtime.cancelled).toEqual([]);
    expect(controller.getState().taskRuns[0].assignments.find((assignment) => assignment.id === "a1")?.status).toBe("cancelled");
  });

  test("restoreState clears live run tracking before accepting restored handles", async () => {
    const runtime = new StopSpyRuntime();
    const { controller } = controllerWith(runtime);
    markRunLive(controller, "run-1");
    controller.restoreState(recoverableState("running"));

    await expect(controller.stopRun("a1")).resolves.toBe(false);

    expect(runtime.stopped).toEqual([]);
  });

  test("restoreState fences in-flight dispatch results from restored state", async () => {
    const runtime = new ControlledRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks(baseSetTasks);
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    await runtime.waitStarted;

    const restored = recoverableState("running");
    const restoredRunId = runtime.requests[0].runId;
    const ref = { ...launchRef(), runId: restoredRunId, asyncId: `async-${restoredRunId}` };
    for (const assignment of restored.taskRuns[0].assignments) {
      assignment.runId = restoredRunId;
      assignment.launchRef = ref;
    }
    controller.restoreState(restored);

    runtime.complete("completed");
    await controller.awaitLastWork();

    expect(controller.getState().taskRuns[0].assignments.find((assignment) => assignment.id === "a1")?.status).toBe("running");
  });

  test("restoreState fences in-flight dispatch result reads from restored state", async () => {
    const runtime = new ResultControlledRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks(baseSetTasks);
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    await runtime.resultStarted;

    const restored = recoverableState("running");
    const restoredRunId = runtime.requests[0].runId;
    const ref = { ...launchRef(), runId: restoredRunId, asyncId: `async-${restoredRunId}` };
    for (const assignment of restored.taskRuns[0].assignments) {
      assignment.runId = restoredRunId;
      assignment.launchRef = ref;
    }
    controller.restoreState(restored);

    runtime.releaseResult();
    await controller.awaitLastWork();

    expect(controller.getState().taskRuns[0].assignments.find((assignment) => assignment.id === "a1")?.status).toBe("running");
  });

  test.each([
    ["stopRun", "completed"],
    ["stopRun", "paused"],
    ["stopRun", "running"],
    ["cancelRun", "cancelled"],
    ["cancelRun", "paused"],
  ] as const)("%s refuses stale non-live assignment handles", async (method, status) => {
    const runtime = method === "stopRun" ? new StopSpyRuntime() : new CancelSpyRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState(status));

    await expect(controller[method]("a1")).resolves.toBe(false);

    expect(runtime instanceof StopSpyRuntime ? runtime.stopped : runtime.cancelled).toEqual([]);
  });

  test.each([
    ["stopRun", "paused"],
    ["cancelRun", "cancelled"],
  ] as const)("dispatch failures preserve %s terminal control status", async (method, expectedStatus) => {
    const runtime = new ControlledSpyRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks(baseSetTasks);
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    await runtime.waitStarted;
    const assignmentId = controller.getState().taskRuns[0].assignments[0].id;
    await expect(controller[method](assignmentId)).resolves.toBe(true);

    runtime.fail();
    await controller.awaitLastWork();

    expect(controller.getState().taskRuns[0].assignments[0].status).toBe(expectedStatus);
  });

  test("dispatch failures recover completed progress without result as attention", async () => {
    const runtime = new CompletedProgressFailRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks(baseSetTasks);
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    await runtime.waitStarted;

    runtime.fail();
    await controller.awaitLastWork();

    const taskRun = controller.getState().taskRuns[0];
    expect(taskRun.assignments[0].status).toBe("attention");
    expect(taskRun.tasks[0].status).toBe("attention");
  });

  test("completed progress without result stays attention without completedAt", async () => {
    const { controller } = controllerWith(new CompletedProgressNoResultRuntime());

    await controller.setTasks(baseSetTasks);
    await controller.awaitLastWork();

    const assignment = controller.getState().taskRuns[0].assignments[0];
    expect(assignment.status).toBe("attention");
    expect(assignment.completedAt).toBeUndefined();
  });

  test.each([
    ["paused", "paused"],
    ["cancelled", "cancelled"],
  ] as const)("dispatch outcome marks unreported assignments %s", async (signalStatus, expectedStatus) => {
    const { controller } = controllerWith(new SignalRuntime(signalStatus));

    await controller.setTasks(baseSetTasks);
    await controller.awaitLastWork();

    expect(controller.getState().taskRuns[0].assignments[0].status).toBe(expectedStatus);
  });

  test("freeform asks create a one-task TaskRun", async () => {
    const runtime = new CompletingRuntime();
    const { controller } = controllerWith(runtime);

    await controller.handleUserAsk("Inspect the controller");
    await controller.awaitLastWork();

    const taskRun = controller.getState().taskRuns[0];
    expect(taskRun.tasks).toHaveLength(1);
    expect(taskRun.tasks[0]).toMatchObject({ id: "task", text: "Inspect the controller" });
    expect(runtime.requests[0].tasks[0]).toMatchObject({ taskRunId: taskRun.id, taskId: "task" });
  });

  test("clear removes completed task runs", async () => {
    const { controller } = controllerWith(new CompletingRuntime());
    await controller.setTasks(baseSetTasks);
    await controller.awaitLastWork();

    await expect(controller.clear()).resolves.toBe(1);

    expect(controller.getState().taskRuns).toEqual([]);
  });

  test("clear fences in-flight launch before it can update state", async () => {
    const runtime = new LaunchControlledRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks(baseSetTasks);
    await runtime.launchStarted;
    await expect(controller.clear("all")).resolves.toBe(1);

    runtime.releaseLaunch();
    await controller.awaitLastWork();

    expect(runtime.cancelled).toHaveLength(1);
    expect(controller.getState().taskRuns).toEqual([]);
  });

  test("launch rejection after epoch changes rolls back stale queued assignments", async () => {
    const runtime = new LaunchRejectControlledRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState({
      version: 4,
      currentTaskRunId: "task-run-active",
      updatedAt: 1,
      taskRuns: [{
        id: "task-run-active",
        title: "Active run",
        request: "Do it",
        context: "Do it",
        status: "pending",
        groups: [{ id: "main", title: "Main", status: "ready", dependsOn: [], maxConcurrency: 1, createdAt: 1, updatedAt: 1 }],
        tasks: [{ id: "task", groupId: "main", text: "Do task", status: "ready", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 }],
        assignments: [],
        artifacts: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    const dispatch = controller.dispatchReady({ taskRunId: "task-run-active" });
    await runtime.launchStarted;
    await expect(controller.editGroup({ taskRunId: "task-run-active", targetId: "main", group: { maxConcurrency: 2 } })).resolves.toMatchObject({ edited: true });

    runtime.rejectLaunch();
    await dispatch;

    const activeRun = controller.getState().taskRuns.find((taskRun) => taskRun.id === "task-run-active");
    expect(activeRun?.assignments).toEqual([]);
    expect(activeRun?.tasks[0].assignmentIds).toEqual([]);
    expect(activeRun?.tasks[0].status).toBe("ready");
  });

  test("stale rollback does not remove replacement assignment with reused id", async () => {
    const runtime = new MultiLaunchControlledRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState({
      version: 4,
      currentTaskRunId: "task-run-active",
      updatedAt: 1,
      taskRuns: [{
        id: "task-run-active",
        title: "Active run",
        request: "Do it",
        context: "Do it",
        status: "pending",
        groups: [{ id: "main", title: "Main", status: "ready", dependsOn: [], maxConcurrency: 1, createdAt: 1, updatedAt: 1 }],
        tasks: [{ id: "task", groupId: "main", text: "Do task", status: "ready", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 }],
        assignments: [],
        artifacts: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    const firstDispatch = controller.dispatchReady({ taskRunId: "task-run-active" });
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    const firstAssignmentId = runtime.requests[0].tasks[0].assignmentId;
    await expect(controller.editTask({ taskRunId: "task-run-active", targetId: "task", task: { text: "Do task again", criteria: ["Done again"] } })).resolves.toMatchObject({ edited: true });
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(2));

    runtime.releaseLaunch(0);
    await firstDispatch;

    const activeRun = controller.getState().taskRuns[0];
    expect(runtime.cancelled).toHaveLength(1);
    expect(runtime.requests[1].tasks[0].assignmentId).toBe(firstAssignmentId);
    expect(activeRun.assignments).toHaveLength(1);
    expect(activeRun.assignments[0].id).toBe(firstAssignmentId);
    expect(activeRun.tasks[0].assignmentIds).toEqual([firstAssignmentId]);

    runtime.releaseLaunch(1);
    await controller.awaitLastWork();
    expect(controller.getState().taskRuns[0].tasks[0].status).toBe("completed");
  });

  test("clear completed does not invalidate active post-commit dispatch", async () => {
    const runtime = new ControlledRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState({
      version: 4,
      currentTaskRunId: "task-run-active",
      updatedAt: 1,
      taskRuns: [
        {
          id: "task-run-completed",
          title: "Completed run",
          request: "Done",
          context: "Done",
          status: "completed",
          groups: [],
          tasks: [{ id: "done", text: "Done", status: "completed", criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1, completedAt: 1 }],
          assignments: [],
          artifacts: [],
          createdAt: 1,
          updatedAt: 1,
          completedAt: 1,
        },
        {
          id: "task-run-active",
          title: "Active run",
          request: "Do it",
          context: "Do it",
          status: "pending",
          groups: [{ id: "main", title: "Main", status: "ready", dependsOn: [], maxConcurrency: 1, createdAt: 1, updatedAt: 1 }],
          tasks: [{ id: "task", groupId: "main", text: "Do task", status: "ready", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 }],
          assignments: [],
          artifacts: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const dispatch = controller.dispatchReady({ taskRunId: "task-run-active" });
    await runtime.waitStarted;
    await expect(controller.clear()).resolves.toBe(1);

    runtime.complete();
    await dispatch;

    const activeRun = controller.getState().taskRuns.find((taskRun) => taskRun.id === "task-run-active");
    expect(controller.getState().taskRuns.map((taskRun) => taskRun.id)).toEqual(["task-run-active"]);
    expect(activeRun?.assignments[0].status).toBe("completed");
    expect(activeRun?.tasks[0].status).toBe("completed");
  });

  test("clear completed does not invalidate active pre-commit dispatch", async () => {
    const runtime = new LaunchControlledRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState({
      version: 4,
      currentTaskRunId: "task-run-active",
      updatedAt: 1,
      taskRuns: [
        {
          id: "task-run-completed",
          title: "Completed run",
          request: "Done",
          context: "Done",
          status: "completed",
          groups: [],
          tasks: [{ id: "done", text: "Done", status: "completed", criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1, completedAt: 1 }],
          assignments: [],
          artifacts: [],
          createdAt: 1,
          updatedAt: 1,
          completedAt: 1,
        },
        {
          id: "task-run-active",
          title: "Active run",
          request: "Do it",
          context: "Do it",
          status: "pending",
          groups: [{ id: "main", title: "Main", status: "ready", dependsOn: [], maxConcurrency: 1, createdAt: 1, updatedAt: 1 }],
          tasks: [{ id: "task", groupId: "main", text: "Do task", status: "ready", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 }],
          assignments: [],
          artifacts: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const dispatch = controller.dispatchReady({ taskRunId: "task-run-active" });
    await runtime.launchStarted;
    await expect(controller.clear()).resolves.toBe(1);

    runtime.releaseLaunch();
    await dispatch;

    const activeRun = controller.getState().taskRuns.find((taskRun) => taskRun.id === "task-run-active");
    expect(runtime.cancelled).toHaveLength(0);
    expect(controller.getState().taskRuns.map((taskRun) => taskRun.id)).toEqual(["task-run-active"]);
    expect(activeRun?.assignments).toHaveLength(1);
    expect(activeRun?.tasks[0].status).toBe("completed");
  });
});
