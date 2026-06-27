import { describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { TaskedSubagentsController } from "../src/orchestration/controller.js";
import type {
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
  dispatchReady(options?: { taskRunId?: string; ctx?: unknown }): Promise<{ launched: number; skipped: number; errors: string[]; hasBlockingIssue: boolean }>;
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

function controllerWith(runtime: SubagentRuntime = new CompletingRuntime()): { controller: TaskRunControllerApi; runtime: SubagentRuntime } {
  const controller = new TaskedSubagentsController(fakePi(), { launcher: runtime });
  return { controller: asTaskRunApi(controller), runtime };
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

  test("setTasks replaces an existing task run instead of appending plan history", async () => {
    const { controller } = controllerWith(new CompletingRuntime());

    await controller.setTasks(baseSetTasks);
    await controller.awaitLastWork();
    await expect(controller.setTasks({ ...baseSetTasks, title: "Replacement", tasks: [{ id: "replacement", group: "main", text: "Do replacement", criteria: ["Done"] }] })).resolves.toMatchObject({ accepted: true, taskRunId: "task-run-1" });

    const state = controller.getState();
    expect(state.taskRuns.map((run) => run.id)).toEqual(["task-run-1"]);
    expect(state.taskRuns[0].title).toBe("Replacement");
    expect(state.taskRuns[0].tasks.map((task) => task.id)).toEqual(["replacement"]);
    expect(state.taskRuns[0].assignments.some((assignment) => assignment.taskId === "task")).toBe(false);
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

    await expect(controller.stopRun("a1")).resolves.toBe(true);

    expect(runtime.stopped).toEqual([launchRef()]);
    expect(JSON.stringify(runtime.stopped[0])).not.toContain("planId");
    expect(controller.getState().taskRuns[0].assignments.find((assignment) => assignment.id === "a1")?.status).toBe("paused");
  });

  test("cancelRun uses the assignment launch handle and cancels non-final assignments in the same run", async () => {
    const runtime = new CancelSpyRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState("running"));

    await expect(controller.cancelRun("a1")).resolves.toBe(true);

    expect(runtime.cancelled).toEqual([launchRef()]);
    expect(JSON.stringify(runtime.cancelled[0])).not.toContain("planId");
    const assignments = controller.getState().taskRuns[0].assignments;
    expect(assignments.find((assignment) => assignment.id === "a1")?.status).toBe("cancelled");
    expect(assignments.find((assignment) => assignment.id === "a2")?.status).toBe("failed");
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
});
