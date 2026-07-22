import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CheckpointContext, CheckpointResult } from "../src/state/persistence-coordinator.js";

import { TaskedSubagentsController } from "../src/orchestration/controller.js";
import { formatInspectReport, formatStatusReport } from "../src/orchestration/commands.js";
import { buildWidgetLines } from "../src/ui/widget.js";
import { DurableObjectStore } from "../src/state/object-store.js";
import { sha256Hex } from "../src/state/canonical-json.js";
import { projectAssignmentArchive, type ArchiveRef } from "../src/state/durable-projection.js";
import { restoreBranchState } from "../src/state/restore.js";
import { syntheticTaskRun } from "./persistence-fixtures.js";
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
  DurableSubagentRunHandle,
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
  dispatchReady(options?: { taskRunId?: string; ctx?: unknown; emitTerminalSignal?: boolean }): Promise<{ launched: number; skipped: number; errors: string[]; hasBlockingIssue: boolean }>;
  attachTarget(targetId?: string, ctx?: unknown): Promise<AttachResult>;
  continueTarget(targetId: string, prompt: string, ctx?: unknown): Promise<boolean>;
  resolveTarget(targetId: string, prompt: string, ctx?: unknown): Promise<boolean>;
  ackTarget(targetId: string, reason: string, ctx?: unknown): Promise<{ acked: boolean; taskRunId?: string; error?: string }>;
  remindPendingAttention(ctx?: unknown): Promise<void>;
  rearmAttentionReminders(): Promise<void>;
  stopRun(assignmentId: string): Promise<boolean>;
  cancelRun(assignmentId: string): Promise<boolean>;
  cancelActiveRuns(): Promise<number>;
  clear(scope?: "completed" | "all", targetId?: string): Promise<number>;
  handleUserAsk(prompt: string, ctx?: unknown): Promise<unknown>;
  flushPersistence(ctx?: unknown): Promise<void>;
  getRunResult(assignmentId: string, archiveId?: string): Promise<string | undefined>;
  awaitLastWork(): Promise<void>;
  restoreState(state: TaskedSubagentsState, archiveRefs?: readonly ArchiveRef[]): void;
  fenceRestore(): number;
  installRestoredState(state: TaskedSubagentsState, archiveRefs: readonly ArchiveRef[] | undefined, expectedEpoch: number): boolean;
  reconcileRestoredRuns(ctx?: unknown): void;
  getState(): TaskedSubagentsState;
}

const temporaryControllerRoots = new Set<string>();

async function createControllerDataRoot(prefix: string): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), prefix));
  temporaryControllerRoots.add(dataRoot);
  return dataRoot;
}

afterEach(async () => {
  await Promise.all([...temporaryControllerRoots].map((dataRoot) => rm(dataRoot, { recursive: true, force: true })));
  temporaryControllerRoots.clear();
});

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

  async launchTaskGraph(request: LaunchTaskGraphRequest): Promise<DurableSubagentRunHandle> {
    this.requests.push(request);
    return {
      runId: request.runId,
      asyncId: `async-${request.runId}`,
      sessionId: "test-session",
      asyncDir: `/tmp/async-${request.runId}`,
      resultId: "a".repeat(32),
      resultPath: `/tmp/${request.runId}.json`,
      resultReservationPath: `/tmp/${request.runId}.json.reservation`,
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

class DurableResultRuntime extends CompletingRuntime {
  readonly resultId = "a".repeat(32);

  override async launchTaskGraph(request: LaunchTaskGraphRequest): Promise<DurableSubagentRunHandle> {
    const handle = await super.launchTaskGraph(request);
    return { ...handle, resultId: this.resultId, assignments: handle.assignments.map((assignment) => ({ ...assignment, resultId: this.resultId })) };
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

class CancelControlledRuntime extends ControlledSpyRuntime {
  private cancelStartedResolve!: () => void;
  private releaseCancelResolve!: () => void;
  readonly cancelStarted = new Promise<void>((resolve) => {
    this.cancelStartedResolve = resolve;
  });
  private readonly releaseCancel = new Promise<void>((resolve) => {
    this.releaseCancelResolve = resolve;
  });

  async cancelRun(handle: SubagentRunHandle): Promise<boolean> {
    this.cancelStartedResolve();
    await this.releaseCancel;
    return super.cancelRun(handle);
  }

  finishCancel(): void {
    this.releaseCancelResolve();
  }
}

class LaunchControlledRuntime extends CompletingRuntime {
  cancelled: SubagentRunHandle[] = [];
  private launchStartedResolve!: () => void;
  private launchReleaseResolve: (() => void) | undefined;
  readonly launchStarted = new Promise<void>((resolve) => {
    this.launchStartedResolve = resolve;
  });

  async launchTaskGraph(request: LaunchTaskGraphRequest): Promise<DurableSubagentRunHandle> {
    this.requests.push(request);
    this.launchStartedResolve();
    await new Promise<void>((resolve) => {
      this.launchReleaseResolve = resolve;
    });
    return {
      runId: request.runId,
      asyncId: `async-${request.runId}`,
      sessionId: "test-session",
      asyncDir: `/tmp/async-${request.runId}`,
      resultId: "b".repeat(32),
      resultPath: `/tmp/${request.runId}.json`,
      resultReservationPath: `/tmp/${request.runId}.json.reservation`,
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

class PostSpawnCancelControlledRuntime extends LaunchControlledRuntime {
  private cancelStartedResolve!: () => void;
  private releaseCancelResolve!: () => void;
  readonly cancelStarted = new Promise<void>((resolve) => {
    this.cancelStartedResolve = resolve;
  });
  private readonly releaseCancel = new Promise<void>((resolve) => {
    this.releaseCancelResolve = resolve;
  });

  override async cancelRun(handle: SubagentRunHandle): Promise<boolean> {
    this.cancelStartedResolve();
    await this.releaseCancel;
    return super.cancelRun(handle);
  }

  finishCancel(): void {
    this.releaseCancelResolve();
  }
}

class LaunchRejectControlledRuntime extends CompletingRuntime {
  private launchStartedResolve!: () => void;
  private launchReject: ((error: Error) => void) | undefined;
  readonly launchStarted = new Promise<void>((resolve) => {
    this.launchStartedResolve = resolve;
  });

  async launchTaskGraph(request: LaunchTaskGraphRequest): Promise<DurableSubagentRunHandle> {
    this.requests.push(request);
    this.launchStartedResolve();
    return new Promise<DurableSubagentRunHandle>((_resolve, reject) => {
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

  async launchTaskGraph(request: LaunchTaskGraphRequest): Promise<DurableSubagentRunHandle> {
    this.requests.push(request);
    await new Promise<void>((resolve) => {
      this.launchResolvers.push(resolve);
    });
    return {
      runId: request.runId,
      asyncId: `async-${request.runId}`,
      sessionId: "test-session",
      asyncDir: `/tmp/async-${request.runId}`,
      resultId: "c".repeat(32),
      resultPath: `/tmp/${request.runId}.json`,
      resultReservationPath: `/tmp/${request.runId}.json.reservation`,
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

class PartialCancelRuntime extends CompletingRuntime {
  attempted: string[] = [];

  async cancelRun(handle: SubagentRunHandle): Promise<boolean> {
    this.attempted.push(handle.runId);
    if (handle.runId === "run-1") throw new Error("cancel run-1 failed");
    return true;
  }
}

class FailedLaunchCancellationRuntime extends CompletingRuntime {
  cancelled: SubagentRunHandle[] = [];

  async cancelRun(handle: SubagentRunHandle): Promise<boolean> {
    this.cancelled.push(handle);
    return false;
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

function reconciledReport(): string {
  return JSON.stringify({
    taskRunId: "task-run-1",
    groupId: "main",
    taskId: "attention",
    assignmentId: "a1",
    status: "completed",
    summary: "reconciled done",
    criteriaEvidence: [{ criteriaIndex: 0, evidence: "reconciled evidence" }],
    artifacts: [],
    followUps: [],
  });
}

class RestoredCompletingRuntime extends CompletingRuntime {
  async waitForRunSignal(handle: SubagentRunHandle | undefined): Promise<RunStatus> {
    this.waitHandles.push(handle);
    return "completed";
  }

  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    this.resultHandles.push(handle);
    return reconciledReport();
  }
}

class DeadAttentionRuntime extends CompletingRuntime {
  timeouts: Array<number | undefined> = [];

  async waitForRunSignal(handle: SubagentRunHandle | undefined, options?: { timeoutMs?: number; onUpdate?: (snapshot: RunProgressSnapshot) => void | Promise<void> }): Promise<RunStatus> {
    this.waitHandles.push(handle);
    this.timeouts.push(options?.timeoutMs);
    return "attention";
  }

  async isRunAlive(): Promise<boolean> {
    return false;
  }

  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    this.resultHandles.push(handle);
    return undefined;
  }
}

class RestoredControlledRuntime extends CompletingRuntime {
  private waitStartedResolve!: () => void;
  private waitResolve: ((status: RunStatus) => void) | undefined;
  readonly waitStarted = new Promise<void>((resolve) => {
    this.waitStartedResolve = resolve;
  });

  async waitForRunSignal(handle: SubagentRunHandle | undefined): Promise<RunStatus> {
    this.waitHandles.push(handle);
    this.waitStartedResolve();
    return new Promise<RunStatus>((resolve) => {
      this.waitResolve = resolve;
    });
  }

  complete(status: RunStatus = "completed"): void {
    this.waitResolve?.(status);
  }

  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    this.resultHandles.push(handle);
    return reconciledReport();
  }
}

class AliveThenCompleteRuntime extends CompletingRuntime {
  waitCalls = 0;
  aliveCalls = 0;
  resultCalls = 0;

  async waitForRunSignal(handle: SubagentRunHandle | undefined): Promise<RunStatus> {
    this.waitHandles.push(handle);
    this.waitCalls += 1;
    return this.waitCalls >= 3 ? "completed" : "attention";
  }

  async isRunAlive(): Promise<boolean> {
    this.aliveCalls += 1;
    return true;
  }

  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    this.resultHandles.push(handle);
    this.resultCalls += 1;
    return reconciledReport();
  }
}

class MultiWaitControlledRuntime extends CompletingRuntime {
  resultCalls = 0;
  readonly waitResolvers: Array<(status: RunStatus) => void> = [];

  async waitForRunSignal(handle: SubagentRunHandle | undefined): Promise<RunStatus> {
    this.waitHandles.push(handle);
    return new Promise<RunStatus>((resolve) => {
      this.waitResolvers.push(resolve);
    });
  }

  resolveWait(index: number, status: RunStatus = "completed"): void {
    this.waitResolvers[index]?.(status);
  }

  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    this.resultCalls += 1;
    return super.getRunResult(handle);
  }
}

class ManualProgressRuntime extends CompletingRuntime {
  onUpdate?: (snapshot: RunProgressSnapshot) => void | Promise<void>;
  private waitStartedResolve!: () => void;
  private resolveWait?: (status: RunStatus) => void;
  readonly waitStarted = new Promise<void>((resolve) => {
    this.waitStartedResolve = resolve;
  });

  override async waitForRunSignal(
    handle: SubagentRunHandle | undefined,
    options?: { onUpdate?: (snapshot: RunProgressSnapshot) => void | Promise<void> },
  ): Promise<RunStatus> {
    this.waitHandles.push(handle);
    this.onUpdate = options?.onUpdate;
    this.waitStartedResolve();
    return new Promise<RunStatus>((resolve) => {
      this.resolveWait = resolve;
    });
  }

  async tick(snapshot: RunProgressSnapshot): Promise<void> {
    await this.onUpdate?.(snapshot);
  }

  finish(status: RunStatus = "attention"): void {
    this.resolveWait?.(status);
  }
}

function staleRunningState(base: number, overrides: { currentTool?: string } = {}): TaskedSubagentsState {
  const run: TaskRunRecord = {
    id: "task-run-1",
    title: "Task run",
    request: "Ship it",
    context: "Context",
    status: "running",
    groups: [{ id: "main", title: "Main", status: "running", dependsOn: [], maxConcurrency: 4, createdAt: 1, updatedAt: 1 }],
    tasks: [
      { id: "work", groupId: "main", text: "Work task", status: "running", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: ["a1"], createdAt: 1, updatedAt: 1 },
    ],
    assignments: [
      {
        id: "a1",
        taskRunId: "task-run-1",
        groupId: "main",
        taskId: "work",
        agent: "delegate",
        prompt: "work",
        status: "running",
        runId: "run-1",
        launchRef: launchRef(),
        ...(overrides.currentTool ? { currentTool: overrides.currentTool } : {}),
        lastActionAt: base,
        lastActionSummary: "tool end: bash",
        createdAt: base,
        updatedAt: base,
      },
    ],
    artifacts: [],
    createdAt: 1,
    updatedAt: base,
  };
  return { version: 4, taskRuns: [run], currentTaskRunId: "task-run-1", updatedAt: base };
}

function assignmentById(controller: TaskRunControllerApi, id: string): TaskAssignmentRecord | undefined {
  return controller.getState().taskRuns[0].assignments.find((assignment) => assignment.id === id);
}

function liveRunIds(controller: TaskRunControllerApi): Map<string, number> {
  return (controller as unknown as { liveRunIds: Map<string, number> }).liveRunIds;
}

function signalSuppressionCounts(controller: TaskRunControllerApi): Map<string, number> {
  return (controller as unknown as { signalSuppressionCounts: Map<string, number> }).signalSuppressionCounts;
}

function controllerWith(runtime: SubagentRuntime = new CompletingRuntime()): { controller: TaskRunControllerApi; runtime: SubagentRuntime } {
  const controller = new TaskedSubagentsController(fakePi(), { launcher: runtime });
  return { controller: asTaskRunApi(controller), runtime };
}

function markRunLive(controller: TaskRunControllerApi, runId: string): void {
  (controller as unknown as { liveRunIds: Map<string, number> }).liveRunIds.set(runId, 0);
}

class RecordingPersistence {
  readonly snapshots: TaskedSubagentsState[] = [];
  failAt?: number;

  async checkpoint(state: TaskedSubagentsState, _context: CheckpointContext): Promise<CheckpointResult> {
    this.snapshots.push(structuredClone(state));
    if (this.failAt === this.snapshots.length) {
      return { committed: false, dirty: true, error: { code: "pointer_append", message: "durability unavailable" } };
    }
    return {
      committed: true,
      deduplicated: false,
      pointer: { version: 5, checkpointId: `${this.snapshots.length}`.padStart(64, "0"), sequence: this.snapshots.length, writtenAt: 1 },
    };
  }

  async retryDirty(): Promise<CheckpointResult> {
    throw new Error("not used by this test");
  }

  async flush(): Promise<void> {}
  invalidate(): void {}
}

class ToggleFailingPersistence extends RecordingPersistence {
  fail = false;

  override async checkpoint(state: TaskedSubagentsState, context: CheckpointContext): Promise<CheckpointResult> {
    if (this.fail) {
      this.snapshots.push(structuredClone(state));
      return { committed: false, dirty: true, error: { code: "pointer_append", message: "durability unavailable" } };
    }
    return super.checkpoint(state, context);
  }
}

class ArchiveRefRecordingPersistence extends RecordingPersistence {
  readonly checkpointContexts: CheckpointContext[] = [];

  override async checkpoint(state: TaskedSubagentsState, context: CheckpointContext): Promise<CheckpointResult> {
    this.checkpointContexts.push(structuredClone(context));
    return super.checkpoint(state, context);
  }
}

class ContextRecordingPersistence extends RecordingPersistence {
  readonly checkpointContexts: CheckpointContext[] = [];
  readonly flushContexts: CheckpointContext[] = [];

  override async checkpoint(state: TaskedSubagentsState, context: CheckpointContext): Promise<CheckpointResult> {
    this.checkpointContexts.push(structuredClone(context));
    return super.checkpoint(state, context);
  }

  override async flush(context?: CheckpointContext): Promise<void> {
    if (context) this.flushContexts.push(structuredClone(context));
  }
}

function persistenceContext(sessionId: string, checkpointId: string): unknown {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => [{ customType: "pi-tasked-subagents:state", data: { version: 5, checkpointId, sequence: 1, writtenAt: 1 } }],
    },
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  };
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
    legacy: true,
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
  test("concurrent mutations retain their entry session context through the locked checkpoint", async () => {
    const persistence = new ContextRecordingPersistence();
    const controller = asTaskRunApi(new TaskedSubagentsController(fakePi(), { persistence }));
    const internals = controller as unknown as {
      lock: { withLock: (callback: () => unknown | Promise<unknown>) => Promise<unknown> };
      scheduleDispatch: (taskRunId: string) => Promise<void>;
    };
    const withLock = internals.lock.withLock.bind(internals.lock);
    let releaseFirstLock!: () => void;
    const firstLockReleased = new Promise<void>((resolve) => { releaseFirstLock = resolve; });
    let firstLockEnteredResolve!: () => void;
    const firstLockEntered = new Promise<void>((resolve) => { firstLockEnteredResolve = resolve; });
    let first = true;
    internals.lock.withLock = (callback) => {
      if (!first) return withLock(callback);
      first = false;
      return withLock(async () => {
        firstLockEnteredResolve();
        await firstLockReleased;
        return callback();
      });
    };
    internals.scheduleDispatch = () => Promise.resolve();

    const firstContext = persistenceContext("session-a", "a".repeat(64));
    const secondContext = persistenceContext("session-b", "b".repeat(64));
    const firstMutation = controller.setTasks({ ...baseSetTasks, taskRunId: "task-run-a" }, firstContext);
    await firstLockEntered;
    const secondMutation = controller.setTasks({ ...baseSetTasks, taskRunId: "task-run-b" }, secondContext);
    releaseFirstLock();

    await Promise.all([firstMutation, secondMutation]);
    await controller.flushPersistence(firstContext);

    expect(persistence.checkpointContexts).toEqual([
      { sessionId: "session-a", visiblePointers: [{ version: 5, checkpointId: "a".repeat(64), sequence: 1, writtenAt: 1 }] },
      { sessionId: "session-b", visiblePointers: [{ version: 5, checkpointId: "b".repeat(64), sequence: 1, writtenAt: 1 }] },
    ]);
    expect(persistence.flushContexts).toEqual([
      { sessionId: "session-a", visiblePointers: [{ version: 5, checkpointId: "a".repeat(64), sequence: 1, writtenAt: 1 }] },
    ]);
  });

  test("uses the last live context when flushing without a call context", async () => {
    const persistence = new ContextRecordingPersistence();
    const controller = asTaskRunApi(new TaskedSubagentsController(fakePi(), { persistence, runtime: new CompletingRuntime() }));
    const context = persistenceContext("session-retained", "c".repeat(64));

    await controller.setTasks({ ...baseSetTasks, taskRunId: "task-run-retained", wait: true }, context);
    await controller.flushPersistence();

    expect(persistence.flushContexts).toHaveLength(1);
    expect(persistence.flushContexts[0]).toMatchObject({
      sessionId: "session-retained",
      visiblePointers: [{ version: 5, checkpointId: "c".repeat(64), sequence: 1, writtenAt: 1 }],
      archiveRefs: [{ taskRunId: "task-run-retained", resultId: "a".repeat(32) }],
    });
  });

  test("creating an unrelated TaskRun does not fence an active dispatch outcome", async () => {
    const runtime = new MultiWaitControlledRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState({
      version: 4,
      currentTaskRunId: "task-run-active",
      updatedAt: 1,
      taskRuns: [{
        id: "task-run-active",
        title: "Active run",
        request: "Complete active work",
        context: "Context",
        status: "pending",
        groups: [{ id: "main", title: "Main", status: "ready", dependsOn: [], maxConcurrency: 1, createdAt: 1, updatedAt: 1 }],
        tasks: [{ id: "active-task", groupId: "main", text: "Complete active work", status: "ready", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 }],
        assignments: [],
        artifacts: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    const activeDispatch = controller.dispatchReady({ taskRunId: "task-run-active" });
    await vi.waitFor(() => expect(runtime.waitResolvers).toHaveLength(1));
    const { taskRunId: _taskRunId, ...newTaskRun } = baseSetTasks;
    await expect(controller.setTasks({ ...newTaskRun, title: "Unrelated run", tasks: [{ id: "new-task", group: "main", text: "Do unrelated work", criteria: ["Done"] }] })).resolves.toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(runtime.waitResolvers).toHaveLength(2));

    runtime.resolveWait(0);
    await activeDispatch;

    expect(controller.getState().taskRuns.find((taskRun) => taskRun.id === "task-run-active")?.assignments[0]?.status).toBe("completed");
    runtime.resolveWait(1);
    await controller.awaitLastWork();
  });

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

  test("stores and links terminal assignment archives before checkpointing", async () => {
    const dataRoot = await createControllerDataRoot("tasked-archive-");
    const runtime = new DurableResultRuntime();
    await mkdir(join(dataRoot, "results", "pi-tasked-subagents"), { recursive: true });
    await writeFile(join(dataRoot, "results", "pi-tasked-subagents", `${runtime.resultId}.json`), "authoritative output");
    const controller = asTaskRunApi(new TaskedSubagentsController(fakePi(), { runtime, dataRoot }));

    await controller.setTasks({ ...baseSetTasks, wait: true });
    const assignmentId = controller.getState().taskRuns[0].assignments[0].id;
    const archives = await new DurableObjectStore(dataRoot).listAssignmentArchives("pi-tasked-subagents", assignmentId);

    expect(archives).toHaveLength(1);
    expect(archives[0].archive).toMatchObject({ assignmentId, resultId: runtime.resultId, runId: expect.any(String) });
  });

  test("flush retries a failed clear checkpoint with pruned archive references", async () => {
    const dataRoot = await createControllerDataRoot("tasked-dirty-terminal-");
    const sessionId = "pi-tasked-subagents";
    const assignmentId = "assignment-001";
    const selectedResultId = "a".repeat(32);
    const competingResultId = "b".repeat(32);
    let failAppend = true;
    const pi = {
      appendEntry: () => {
        if (failAppend) throw new Error("append unavailable");
      },
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
    } as unknown as ExtensionAPI;
    try {
      const store = new DurableObjectStore(dataRoot);
      const createArchive = async (runId: string, resultId: string) => {
        const archive = projectAssignmentArchive({
          assignmentId,
          taskRunId: "task-run-001",
          taskId: "task-001",
          status: "completed",
          summary: "terminal result",
          criteriaEvidence: [],
          artifacts: [],
          followUps: [],
          runId,
          resultId,
          completedAt: 1,
        });
        const archiveId = await store.put("assignment", archive, 256 * 1024);
        await store.linkAssignmentArchive(sessionId, assignmentId, archiveId);
        return { archive, archiveId };
      };
      const selected = await createArchive("selected-run", selectedResultId);
      await createArchive("competing-run", competingResultId);
      await mkdir(join(dataRoot, "results", sessionId), { recursive: true });
      await writeFile(join(dataRoot, "results", sessionId, `${selectedResultId}.json`), "selected branch result");
      await writeFile(join(dataRoot, "results", sessionId, `${competingResultId}.json`), "competing branch result");

      const terminal = syntheticTaskRun(1, "completed");
      const state: TaskedSubagentsState = { version: 4, taskRuns: [terminal], currentTaskRunId: terminal.id, updatedAt: terminal.updatedAt };
      const archiveRef: ArchiveRef = {
        assignmentId,
        assignmentIdHash: sha256Hex(assignmentId),
        archiveId: selected.archiveId,
        resultId: selectedResultId,
        taskRunId: terminal.id,
        completedAt: terminal.completedAt ?? terminal.updatedAt,
      };
      const controller = asTaskRunApi(new TaskedSubagentsController(pi, { dataRoot }));
      controller.restoreState(state, [archiveRef]);

      await expect(controller.clear("completed")).rejects.toThrow("append unavailable");
      // Clear removes archive references before checkpointing, so a retry
      // cannot revive a result that the user explicitly cleared.
      failAppend = false;
      await controller.flushPersistence();

      const refs = JSON.parse(await readFile(join(dataRoot, "sessions", sessionId, "refs.json"), "utf8")) as { checkpointIds: string[] };
      const checkpointId = refs.checkpointIds.at(-1);
      expect(checkpointId).toMatch(/^[a-f0-9]{64}$/);
      const restored = await restoreBranchState(
        [{ type: "custom", customType: "pi-tasked-subagents:state", data: { version: 5, checkpointId, sequence: 1, writtenAt: 1 } }],
        store,
        { sessionId, allEntries: [], appendMigratedPointer: () => undefined },
      );
      expect(restored).toMatchObject({ restored: true, archiveRefs: [] });
      if (!restored.restored) throw new Error("terminal checkpoint should restore");

      const restarted = asTaskRunApi(new TaskedSubagentsController(fakePi(), { dataRoot }));
      restarted.restoreState(restored.state, restored.archiveRefs);
      await expect(restarted.getRunResult(assignmentId)).resolves.toContain(`Ambiguous result for ${assignmentId}`);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("loads only the selected immutable result and never silently chooses an ambiguous archive", async () => {
    const dataRoot = await createControllerDataRoot("tasked-result-");
    const store = new DurableObjectStore(dataRoot);
    const assignmentId = "old-assignment";
    const createArchive = async (runId: string, resultId: string) => {
      const archive = projectAssignmentArchive({
        assignmentId,
        taskRunId: `run-${runId}`,
        taskId: "task",
        status: "completed",
        summary: "done",
        criteriaEvidence: [],
        artifacts: [],
        followUps: [],
        runId,
        resultId,
        completedAt: 1,
      });
      const archiveId = await store.put("assignment", archive, 256 * 1024);
      await store.linkAssignmentArchive("pi-tasked-subagents", assignmentId, archiveId);
      return { archive, archiveId };
    };
    const firstResultId = "a".repeat(32);
    const secondResultId = "b".repeat(32);
    await mkdir(join(dataRoot, "results", "pi-tasked-subagents"), { recursive: true });
    await writeFile(join(dataRoot, "results", "pi-tasked-subagents", `${firstResultId}.json`), "first authoritative output");
    await writeFile(join(dataRoot, "results", "pi-tasked-subagents", `${secondResultId}.json`), "second authoritative output");
    const first = await createArchive("branch-one", firstResultId);
    const second = await createArchive("branch-two", secondResultId);
    const controller = asTaskRunApi(new TaskedSubagentsController(fakePi(), { dataRoot }));
    const empty: TaskedSubagentsState = { version: 4, taskRuns: [], updatedAt: 1 };

    controller.restoreState(empty, [{
      assignmentId,
      assignmentIdHash: sha256Hex(assignmentId),
      archiveId: second.archiveId,
      resultId: secondResultId,
      taskRunId: second.archive.taskRunId,
      completedAt: second.archive.completedAt,
    }]);
    await expect(controller.getRunResult(assignmentId)).resolves.toBe("second authoritative output");

    controller.restoreState(empty);
    await expect(controller.getRunResult(assignmentId)).resolves.toContain(`Ambiguous result for ${assignmentId}`);
    await expect(controller.getRunResult(assignmentId, first.archiveId)).resolves.toBe("first authoritative output");
  });

  test("restore fencing preserves selected archive result lookup when tree restore later fails", async () => {
    const dataRoot = await createControllerDataRoot("tasked-result-");
    const store = new DurableObjectStore(dataRoot);
    const assignmentId = "archived-assignment";
    const resultId = "c".repeat(32);
    const archive = projectAssignmentArchive({
      assignmentId, taskRunId: "archived-run", taskId: "task", status: "completed", summary: "done",
      criteriaEvidence: [], artifacts: [], followUps: [], runId: "archived-dispatch", resultId, completedAt: 1,
    });
    const archiveId = await store.put("assignment", archive, 256 * 1024);
    await mkdir(join(dataRoot, "results", "pi-tasked-subagents"), { recursive: true });
    await writeFile(join(dataRoot, "results", "pi-tasked-subagents", `${resultId}.json`), "preserved archive output");
    const controller = asTaskRunApi(new TaskedSubagentsController(fakePi(), { dataRoot }));
    controller.restoreState({ version: 4, taskRuns: [], updatedAt: 1 }, [{
      assignmentId, assignmentIdHash: sha256Hex(assignmentId), archiveId, resultId, taskRunId: "archived-run", completedAt: 1,
    }]);

    controller.fenceRestore();

    await expect(controller.getRunResult(assignmentId)).resolves.toBe("preserved archive output");
  });

  test("a newer restore fence rejects stale asynchronous restore installation", () => {
    const controller = asTaskRunApi(new TaskedSubagentsController(fakePi()));
    controller.restoreState(recoverableState());
    const staleEpoch = controller.fenceRestore();
    controller.fenceRestore();

    expect(controller.installRestoredState({ version: 4, taskRuns: [], updatedAt: 2 }, undefined, staleEpoch)).toBe(false);
    expect(controller.getState().taskRuns).toHaveLength(1);
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

  test("wait mode does not queue automatic completion turns", async () => {
    const pi = fakePi();
    const controller = asTaskRunApi(new TaskedSubagentsController(pi, { runtime: new ExpansionRuntime() }));

    await controller.setTasks({
      ...baseSetTasks,
      tasks: [{ id: "triage", group: "main", text: "Plan review work", criteria: ["Plan produced"], expansionMode: "append_tasks" }],
      wait: true,
    });

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  test("background multi-wave dispatch queues one turn only after the TaskRun is terminal", async () => {
    const pi = fakePi();
    const controller = asTaskRunApi(new TaskedSubagentsController(pi, { runtime: new ExpansionRuntime() }));

    await controller.setTasks({
      ...baseSetTasks,
      tasks: [{ id: "triage", group: "main", text: "Plan review work", criteria: ["Plan produced"], expansionMode: "append_tasks" }],
    });
    await controller.awaitLastWork();

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ taskRunId: "task-run-1", status: "completed" }) }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
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
    const beforePatch = structuredClone(controller.getState().taskRuns[0]);

    await expect(controller.patchTaskRun({
      taskRunId: "task-run-1",
      tasks: [{ id: "task", group: "main", text: "Replace task", criteria: ["Replaced"] }],
    })).resolves.toMatchObject({ patched: false, dispatchScheduled: false, errors: ["Task task already exists; use edit_task to modify existing tasks"] });

    expect(controller.getState().taskRuns[0]).toEqual(beforePatch);
  });

  test("patchTaskRun rejects unsupported top-level expansionMode before mutating", async () => {
    const { controller } = controllerWith(new CompletingRuntime());

    await controller.setTasks(baseSetTasks);
    await controller.awaitLastWork();
    const beforePatch = structuredClone(controller.getState().taskRuns[0]);

    await expect(controller.patchTaskRun({
      taskRunId: "task-run-1",
      expansionMode: "append_tasks",
      tasks: [{ id: "review", group: "main", text: "Review task", criteria: ["Reviewed"] }],
    } as never)).resolves.toMatchObject({ patched: false, dispatchScheduled: false, errors: ["Patch expansionMode is not supported; set expansionMode on appended tasks"] });

    expect(controller.getState().taskRuns[0]).toEqual(beforePatch);
  });

  test("waited patch suppresses a terminal signal from an already-running background dispatch", async () => {
    const runtime = new FirstResultControlledRuntime();
    const pi = fakePi();
    const controller = asTaskRunApi(new TaskedSubagentsController(pi, { runtime }));

    await controller.setTasks(baseSetTasks);
    await runtime.resultStarted;

    const patch = controller.patchTaskRun({
      taskRunId: "task-run-1",
      tasks: [{ id: "review", group: "main", text: "Review after task", criteria: ["Reviewed"], dependsOn: ["task"] }],
      wait: true,
    });
    runtime.releaseResult();
    await patch;

    expect(controller.getState().taskRuns[0].status).toBe("completed");
    expect(pi.sendMessage).not.toHaveBeenCalled();
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

    expect(runtime.requests.map((request) => request.tasks.map((task) => task.taskId))).toEqual([["task"]]);

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

  test("successful resolution supersedes historical failures and completes the run", async () => {
    const runtime = new CompletingRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState());

    await expect(controller.resolveTarget("task-run-1", "Fixed in commit abc123")).resolves.toBe(true);
    await controller.awaitLastWork();

    const taskRun = controller.getState().taskRuns[0];
    expect(taskRun.status).toBe("completed");
    expect(taskRun.groups[0].status).toBe("completed");
    expect(taskRun.tasks.map((task) => task.status)).toEqual(["completed", "completed", "completed"]);
    expect(taskRun.assignments
      .filter((assignment) => assignment.id === "a1" || assignment.id === "a2")
      .every((assignment) => Boolean(assignment.supersededByAssignmentId))).toBe(true);
    expect(taskRun.assignments.filter((assignment) => !assignment.supersededAt).map((assignment) => assignment.status))
      .toEqual(["completed", "completed"]);
  });

  test("ackTarget on a run resolves attention/failed descendants externally and leaves the widget", async () => {
    const { controller } = controllerWith();
    controller.restoreState(recoverableState());

    await expect(controller.ackTarget("task-run-1", "fixed and verified by run-14")).resolves.toMatchObject({ acked: true, taskRunId: "task-run-1" });

    const run = controller.getState().taskRuns[0];
    expect(run.status).toBe("completed");
    expect(run.tasks.map((task) => task.status)).toEqual(["completed", "completed", "completed"]);
    expect(run.tasks.find((task) => task.id === "attention")?.resolvedExternally).toMatchObject({ reason: "fixed and verified by run-14" });
    expect(run.tasks.find((task) => task.id === "failed")?.resolvedExternally).toMatchObject({ reason: "fixed and verified by run-14" });
    expect(run.assignments.find((assignment) => assignment.id === "a1")?.status).toBe("completed");
    expect(run.assignments.find((assignment) => assignment.id === "a1")?.resolvedExternally?.reason).toBe("fixed and verified by run-14");
    expect(buildWidgetLines(controller.getState(), 14)).toHaveLength(0);
    await expect(controller.clear("completed")).resolves.toBe(1);
  });

  test("ackTarget on a single task re-derives its group and run status", async () => {
    const { controller } = controllerWith();
    controller.restoreState(recoverableState());

    await expect(controller.ackTarget("attention", "fixed by hand")).resolves.toMatchObject({ acked: true });

    const run = controller.getState().taskRuns[0];
    expect(run.tasks.find((task) => task.id === "attention")?.status).toBe("completed");
    expect(run.tasks.find((task) => task.id === "attention")?.resolvedExternally?.reason).toBe("fixed by hand");
    expect(run.tasks.find((task) => task.id === "failed")?.status).toBe("failed");
    expect(run.groups[0].status).toBe("failed");
    expect(run.status).toBe("failed");
  });

  test("ackTarget cancels never-started tasks and skips queued assignments without claiming work", async () => {
    const { controller } = controllerWith();
    const state = recoverableState();
    const run = state.taskRuns[0];
    run.tasks.push({ id: "later", groupId: "main", text: "Never started", status: "pending", criteria: [{ id: "C1", text: "Later done", satisfied: false, evidence: [] }], dependsOn: ["attention"], assignmentIds: [], createdAt: 1, updatedAt: 1 });
    run.tasks.push({ id: "queuedTask", groupId: "main", text: "Queued task", status: "running", criteria: [{ id: "C1", text: "Queued done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: ["aq"], createdAt: 1, updatedAt: 1 });
    run.assignments.push({ id: "aq", taskRunId: "task-run-1", groupId: "main", taskId: "queuedTask", agent: "delegate", prompt: "queued", status: "queued", runId: "run-1", launchRef: launchRef(), createdAt: 1, updatedAt: 1 });
    controller.restoreState(state);

    await expect(controller.ackTarget("task-run-1", "resolved externally")).resolves.toMatchObject({ acked: true });

    const acked = controller.getState().taskRuns[0];
    expect(acked.tasks.find((task) => task.id === "later")?.status).toBe("cancelled");
    expect(acked.tasks.find((task) => task.id === "later")?.resolvedExternally).toBeUndefined();
    expect(acked.tasks.find((task) => task.id === "queuedTask")?.status).toBe("blocked");
    expect(acked.assignments.find((assignment) => assignment.id === "aq")?.status).toBe("skipped");
    expect(acked.assignments.find((assignment) => assignment.id === "aq")?.resolvedExternally).toBeUndefined();
    expect(acked.tasks.find((task) => task.id === "attention")?.status).toBe("completed");
  });

  test("ackTarget rejects empty reason, unknown targets, running descendants, and already-resolved targets", async () => {
    const { controller } = controllerWith();
    controller.restoreState(recoverableState("running"));

    await expect(controller.ackTarget("task-run-1", "   ")).resolves.toMatchObject({ acked: false });
    await expect(controller.ackTarget("does-not-exist", "reason")).resolves.toMatchObject({ acked: false });
    const running = await controller.ackTarget("attention", "reason");
    expect(running.acked).toBe(false);
    expect(running.error).toContain("running");

    controller.restoreState(recoverableState());
    const alreadyResolved = await controller.ackTarget("done", "reason");
    expect(alreadyResolved.acked).toBe(false);
    expect(alreadyResolved.error).toContain("nothing");
  });

  test("ack annotations and nag flags survive a persistence round-trip", async () => {
    const dataRoot = await createControllerDataRoot("tasked-ack-persist-");
    const pointers: unknown[] = [];
    const pi = {
      appendEntry: (_type: string, data: unknown) => { pointers.push(data); },
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
    } as unknown as ExtensionAPI;
    const controller = asTaskRunApi(new TaskedSubagentsController(pi, { dataRoot }));
    controller.restoreState(recoverableState());

    await expect(controller.ackTarget("attention", "fixed by a later run")).resolves.toMatchObject({ acked: true });
    // The settle right after an ack skips that run; the next settle arms the nag.
    await controller.remindPendingAttention();
    await controller.remindPendingAttention();

    const latestPointer = pointers.at(-1);
    const restored = await restoreBranchState(
      [{ type: "custom", customType: "pi-tasked-subagents:state", data: latestPointer }],
      new DurableObjectStore(dataRoot),
      { sessionId: "pi-tasked-subagents", allEntries: [], appendMigratedPointer: () => undefined },
    );
    expect(restored.restored).toBe(true);
    if (!restored.restored) throw new Error("expected the acked checkpoint to restore");
    const restoredRun = restored.state.taskRuns[0];
    expect(restoredRun.tasks.find((task) => task.id === "attention")?.resolvedExternally).toMatchObject({ reason: "fixed by a later run" });
    expect(restoredRun.attentionNagTriggered).toBe(true);
  });

  test("reminds once with triggerTurn for a stale attention run, then stays silent and re-arms after restore", async () => {
    const dataRoot = await createControllerDataRoot("tasked-remind-");
    const pi = fakePi();
    const controller = asTaskRunApi(new TaskedSubagentsController(pi, { dataRoot }));
    const sendMessage = pi.sendMessage as unknown as ReturnType<typeof vi.fn>;
    controller.restoreState(recoverableState());

    await controller.remindPendingAttention();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = sendMessage.mock.calls[0];
    expect(message.customType).toBe("pi-tasked-subagents:attention-reminder");
    expect(message.content).toContain("task-run-1");
    expect(message.content).toContain("attention");
    expect(message.details).toMatchObject({ taskRunIds: ["task-run-1"] });
    expect(options).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });

    await controller.remindPendingAttention();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    controller.restoreState(recoverableState());
    await controller.remindPendingAttention();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("does not remind while the attention run still has a running assignment", async () => {
    const dataRoot = await createControllerDataRoot("tasked-remind-active-");
    const pi = fakePi();
    const controller = asTaskRunApi(new TaskedSubagentsController(pi, { dataRoot }));
    const sendMessage = pi.sendMessage as unknown as ReturnType<typeof vi.fn>;
    controller.restoreState(recoverableState("running"));

    await controller.remindPendingAttention();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not remind about a run the settling turn already acked", async () => {
    const dataRoot = await createControllerDataRoot("tasked-remind-acked-");
    const pi = fakePi();
    const controller = asTaskRunApi(new TaskedSubagentsController(pi, { dataRoot }));
    const sendMessage = pi.sendMessage as unknown as ReturnType<typeof vi.fn>;
    controller.restoreState(recoverableState());

    await expect(controller.ackTarget("attention", "handled inline")).resolves.toMatchObject({ acked: true });
    await controller.remindPendingAttention();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("warns once for a stale assignment, then escalates and recovers across poll ticks", async () => {
    const base = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const dataRoot = await createControllerDataRoot("tasked-stale-");
      const pi = fakePi();
      const runtime = new ManualProgressRuntime();
      const controller = asTaskRunApi(new TaskedSubagentsController(pi, { launcher: runtime, dataRoot, staleWarningMs: 1_000, staleAttentionMs: 3_000 }));
      const sendMessage = pi.sendMessage as unknown as ReturnType<typeof vi.fn>;
      controller.restoreState(staleRunningState(base));
      controller.reconcileRestoredRuns();
      await runtime.waitStarted;

      const snapshot: RunProgressSnapshot = { runId: "run-1", status: "running", steps: [{ id: "a1", status: "running", agent: "delegate", lastActionAt: base }] };

      nowSpy.mockReturnValue(base + 500);
      await runtime.tick(snapshot);
      expect(sendMessage).not.toHaveBeenCalled();

      nowSpy.mockReturnValue(base + 1_500);
      await runtime.tick(snapshot);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [warning, warningOptions] = sendMessage.mock.calls[0];
      expect(warning.customType).toBe("pi-tasked-subagents:stale-assignment");
      expect(warning.display).toBe(false);
      expect(warning.content).toContain("[tasked-subagents] stale assignment detected");
      expect(warning.content).toContain("assignment: a1 (delegate)");
      expect(warning.content).toContain("last event: tool end: bash");
      expect(warning.content).toContain("active tool: none");
      expect(warning.details).toMatchObject({ taskRunId: "task-run-1", assignmentIds: ["a1"], kind: "stale-assignment" });
      expect(warningOptions).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });

      // Repeated identical ticks below the attention threshold stay silent.
      nowSpy.mockReturnValue(base + 2_000);
      await runtime.tick(snapshot);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // Crossing the attention threshold escalates exactly once.
      nowSpy.mockReturnValue(base + 3_500);
      await runtime.tick(snapshot);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      const [escalation] = sendMessage.mock.calls[1];
      expect(escalation.customType).toBe("pi-tasked-subagents:stale-assignment");
      expect(escalation.content).toContain("[tasked-subagents] stale assignment escalated to attention");
      expect(escalation.details).toMatchObject({ kind: "stale-escalation", assignmentIds: ["a1"] });
      expect(assignmentById(controller, "a1")?.status).toBe("attention");
      expect(assignmentById(controller, "a1")?.staleEscalatedAt).toBe(base + 3_500);
      expect(controller.getState().taskRuns[0].status).toBe("attention");

      nowSpy.mockReturnValue(base + 4_500);
      await runtime.tick(snapshot);
      expect(sendMessage).toHaveBeenCalledTimes(2);

      // Fresh activity clears the markers and restores the running status. The
      // first fresh tick updates the stored action time; the next recovers.
      const fresh: RunProgressSnapshot = { runId: "run-1", status: "running", steps: [{ id: "a1", status: "running", agent: "delegate", lastActionAt: base + 5_000 }] };
      nowSpy.mockReturnValue(base + 5_000);
      await runtime.tick(fresh);
      nowSpy.mockReturnValue(base + 5_001);
      await runtime.tick(fresh);

      expect(sendMessage).toHaveBeenCalledTimes(2);
      const recovered = assignmentById(controller, "a1");
      expect(recovered?.status).toBe("running");
      expect(recovered?.staleWarnedAt).toBeUndefined();
      expect(recovered?.staleEscalatedAt).toBeUndefined();
      expect(controller.getState().taskRuns[0].status).toBe("running");
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("never flags a stale assignment while a tool is active", async () => {
    const base = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const dataRoot = await createControllerDataRoot("tasked-stale-tool-");
      const pi = fakePi();
      const runtime = new ManualProgressRuntime();
      const controller = asTaskRunApi(new TaskedSubagentsController(pi, { launcher: runtime, dataRoot, staleWarningMs: 1_000, staleAttentionMs: 3_000 }));
      const sendMessage = pi.sendMessage as unknown as ReturnType<typeof vi.fn>;
      controller.restoreState(staleRunningState(base, { currentTool: "bash" }));
      controller.reconcileRestoredRuns();
      await runtime.waitStarted;

      nowSpy.mockReturnValue(base + 60_000);
      await runtime.tick({ runId: "run-1", status: "running", steps: [{ id: "a1", status: "running", agent: "delegate", currentTool: "bash", lastActionAt: base }] });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(assignmentById(controller, "a1")?.status).toBe("running");
      expect(assignmentById(controller, "a1")?.staleWarnedAt).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("stale heartbeat markers survive a persistence round-trip", async () => {
    const dataRoot = await createControllerDataRoot("tasked-stale-persist-");
    const pointers: unknown[] = [];
    const pi = {
      appendEntry: (_type: string, data: unknown) => { pointers.push(data); },
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
    } as unknown as ExtensionAPI;
    const controller = asTaskRunApi(new TaskedSubagentsController(pi, { dataRoot }));
    const state = recoverableState();
    state.taskRuns[0].assignments[0].staleWarnedAt = 1_800_000_000_111;
    state.taskRuns[0].assignments[0].staleEscalatedAt = 1_800_000_000_222;
    controller.restoreState(state);

    // Any checkpoint durably projects the current graph; arming the nag is a
    // convenient one that does not disturb the assignment markers.
    await controller.remindPendingAttention();

    const latestPointer = pointers.at(-1);
    const restored = await restoreBranchState(
      [{ type: "custom", customType: "pi-tasked-subagents:state", data: latestPointer }],
      new DurableObjectStore(dataRoot),
      { sessionId: "pi-tasked-subagents", allEntries: [], appendMigratedPointer: () => undefined },
    );
    expect(restored.restored).toBe(true);
    if (!restored.restored) throw new Error("expected the checkpoint to restore");
    const restoredAssignment = restored.state.taskRuns[0].assignments.find((assignment) => assignment.id === "a1");
    expect(restoredAssignment?.staleWarnedAt).toBe(1_800_000_000_111);
    expect(restoredAssignment?.staleEscalatedAt).toBe(1_800_000_000_222);
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

  test("cancelActiveRuns cancels each live subagent run", async () => {
    const runtime = new CancelSpyRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState("running"));
    markRunLive(controller, "run-1");

    await expect(controller.cancelActiveRuns()).resolves.toBe(1);

    expect(runtime.cancelled).toEqual([launchRef()]);
    expect(controller.getState().taskRuns[0].assignments.every((assignment) => assignment.status === "cancelled" || assignment.status === "failed")).toBe(true);
  });

  test("cancelActiveRuns catches dispatch scheduling before launchTaskGraph starts", async () => {
    const runtime = new LaunchControlledRuntime();
    const { controller } = controllerWith(runtime);
    const state = recoverableState();
    state.taskRuns[0].status = "running";
    state.taskRuns[0].groups[0].status = "ready";
    state.taskRuns[0].tasks = [
      { id: "ready", groupId: "main", text: "Ready task", status: "ready", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 },
    ];
    state.taskRuns[0].assignments = [];
    controller.restoreState(state);

    const dispatch = controller.dispatchReady({ taskRunId: "task-run-1" });
    await expect(controller.cancelActiveRuns()).resolves.toBe(1);
    await dispatch;

    expect(runtime.requests).toHaveLength(0);
    expect(controller.getState().taskRuns[0].assignments[0]?.status).toBe("cancelled");
  });

  test("cancelActiveRuns cancels a launch that is still being committed", async () => {
    const runtime = new LaunchControlledRuntime();
    const { controller } = controllerWith(runtime);
    const setTasks = controller.setTasks({ ...baseSetTasks, wait: true });
    await runtime.launchStarted;

    await expect(controller.cancelActiveRuns()).resolves.toBe(1);
    runtime.releaseLaunch();
    await setTasks;

    expect(runtime.cancelled).toHaveLength(1);
    expect(controller.getState().taskRuns[0].assignments[0]?.status).toBe("cancelled");
  });

  test("cancelActiveRuns catches a resolved launch before assignment commit", async () => {
    const runtime = new LaunchControlledRuntime();
    const { controller } = controllerWith(runtime);
    const setTasks = controller.setTasks({ ...baseSetTasks, wait: true });
    await runtime.launchStarted;

    let lockStarted!: () => void;
    let releaseLock!: () => void;
    const started = new Promise<void>((resolve) => { lockStarted = resolve; });
    const lock = (controller as unknown as { lock: { withLock<T>(operation: () => Promise<T>): Promise<T> } }).lock;
    const blocker = lock.withLock(() => {
      lockStarted();
      return new Promise<void>((resolve) => { releaseLock = resolve; });
    });
    await started;

    const cancellation = controller.cancelActiveRuns();
    runtime.releaseLaunch();
    releaseLock();
    await blocker;
    await expect(cancellation).resolves.toBe(1);
    await setTasks;

    expect(runtime.cancelled).toHaveLength(1);
    expect(controller.getState().taskRuns[0].assignments[0]?.status).toBe("cancelled");
  });

  test("restoreState retains completed history counts and archive inspection", () => {
    const controller = asTaskRunApi(new TaskedSubagentsController(fakePi()));
    controller.restoreState({
      version: 4, taskRuns: [], updatedAt: 4,
      completedHistory: [{
        taskRunId: "completed-run", title: "Completed", status: "completed", createdAt: 1, updatedAt: 4, completedAt: 4,
        groupCount: 2, taskCount: 3, assignmentCount: 4, assignmentArchiveIds: ["a".repeat(64)],
        archives: [{ archiveId: "a".repeat(64), assignmentId: "archived", taskRunId: "completed-run", taskId: "task", status: "completed", runId: "run", resultId: "b".repeat(32), completedAt: 4, summary: "Archived", criteriaEvidence: [], artifacts: [], followUps: [] }],
      }],
    });

    const restored = controller.getState();
    expect(formatStatusReport(restored, "completed-run")).toContain("tasks: 3");
    expect(formatInspectReport(restored, "archived")).toContain("Archived");
  });

  test("restoreState clears launch cancellation bookkeeping", async () => {
    const runtime = new LaunchControlledRuntime();
    const { controller } = controllerWith(runtime);
    const setTasks = controller.setTasks({ ...baseSetTasks, wait: true });
    await runtime.launchStarted;

    controller.restoreState({ version: 4, taskRuns: [], updatedAt: 2 });
    await expect(controller.cancelActiveRuns()).resolves.toBe(0);
    runtime.releaseLaunch();
    await setTasks;

    expect(runtime.cancelled).toHaveLength(1);
    expect(controller.getState().taskRuns).toEqual([]);
  });

  test("cancelActiveRuns continues after one live run fails to cancel", async () => {
    const runtime = new PartialCancelRuntime();
    const { controller } = controllerWith(runtime);
    const state = recoverableState("running");
    const secondRun = structuredClone(state.taskRuns[0]);
    secondRun.id = "task-run-2";
    secondRun.tasks[0].id = "attention-2";
    secondRun.tasks[0].assignmentIds = ["b1"];
    secondRun.tasks[1].id = "failed-2";
    secondRun.tasks[1].assignmentIds = ["b2"];
    const secondRef: SubagentRunHandle = {
      runId: "run-2",
      asyncId: "async-run-2",
      legacy: true,
      resultPath: "/tmp/run-2.json",
      assignments: [
        { assignmentId: "b1", runId: "run-2", resultPath: "/tmp/run-2.json" },
        { assignmentId: "b2", runId: "run-2", resultPath: "/tmp/run-2.json" },
      ],
    };
    secondRun.assignments[0] = { ...secondRun.assignments[0], id: "b1", taskRunId: "task-run-2", taskId: "attention-2", runId: "run-2", launchRef: secondRef };
    secondRun.assignments[1] = { ...secondRun.assignments[1], id: "b2", taskRunId: "task-run-2", taskId: "failed-2", runId: "run-2", launchRef: secondRef };
    state.taskRuns.push(secondRun);
    controller.restoreState(state);
    markRunLive(controller, "run-1");
    markRunLive(controller, "run-2");

    await expect(controller.cancelActiveRuns()).rejects.toThrow("cancel run-1 failed");

    expect(runtime.attempted).toEqual(["run-1", "run-2"]);
    expect(controller.getState().taskRuns[1].assignments[0].status).toBe("cancelled");
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

  test("restoreState seeds dispatch run counter from restored assignment run ids", async () => {
    const runtime = new CompletingRuntime();
    const { controller } = controllerWith(runtime);
    const restored: TaskedSubagentsState = {
      version: 4,
      currentTaskRunId: "task-run-1",
      updatedAt: 1,
      taskRuns: [{
        id: "task-run-1",
        title: "Task run",
        request: "Ship it",
        context: "Context",
        status: "running",
        groups: [{ id: "main", title: "Main", status: "ready", dependsOn: [], maxConcurrency: 2, createdAt: 1, updatedAt: 1 }],
        tasks: [
          { id: "done", groupId: "main", text: "Done task", status: "completed", criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [] }], dependsOn: [], assignmentIds: ["old-a1"], createdAt: 1, updatedAt: 1, completedAt: 1 },
          { id: "next", groupId: "main", text: "Next task", status: "ready", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 },
        ],
        assignments: [{ id: "old-a1", taskRunId: "task-run-1", groupId: "main", taskId: "done", agent: "delegate", prompt: "done", status: "completed", runId: "task-run-1-123-7", createdAt: 1, updatedAt: 1, completedAt: 1 }],
        artifacts: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    controller.restoreState(restored);

    await controller.dispatchReady({ taskRunId: "task-run-1" });
    await controller.awaitLastWork();

    expect(runtime.requests[0].runId).toMatch(/-8$/u);
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

  test("background launch failure emits one terminal failure signal after its populated failure checkpoint", async () => {
    const pi = fakePi();
    const runtime = new LaunchRejectControlledRuntime();
    const controller = asTaskRunApi(new TaskedSubagentsController(pi, { runtime }));

    await controller.setTasks(baseSetTasks);
    await runtime.launchStarted;
    runtime.rejectLaunch();
    await controller.awaitLastWork();

    expect(controller.getState().taskRuns[0].status).toBe("failed");
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(controller.getState().taskRuns[0].assignments[0].id),
        details: expect.objectContaining({ status: "failed" }),
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
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

  test("checkpoint failures release wait signal suppression for every mutation scope", async () => {
    const persistence = new ToggleFailingPersistence();
    const controller = asTaskRunApi(new TaskedSubagentsController(fakePi(), { persistence, runtime: new CompletingRuntime() }));

    persistence.fail = true;
    await expect(controller.setTasks({ ...baseSetTasks, wait: true })).rejects.toThrow("durability unavailable");
    expect(signalSuppressionCounts(controller)).toEqual(new Map());

    persistence.fail = false;
    await controller.setTasks({ ...baseSetTasks, wait: true });
    persistence.fail = true;
    await expect(controller.patchTaskRun({ taskRunId: "task-run-1", tasks: [{ id: "next", group: "main", text: "Next", criteria: ["Done"] }], wait: true })).rejects.toThrow("durability unavailable");
    expect(signalSuppressionCounts(controller)).toEqual(new Map());
    await expect(controller.editTask({ taskRunId: "task-run-1", targetId: "task", task: { text: "Retry", criteria: ["Done"] }, wait: true })).rejects.toThrow("durability unavailable");
    expect(signalSuppressionCounts(controller)).toEqual(new Map());
    await expect(controller.editGroup({ taskRunId: "task-run-1", targetId: "main", group: { title: "Retry group" }, wait: true })).rejects.toThrow("durability unavailable");
    expect(signalSuppressionCounts(controller)).toEqual(new Map());
  });

  test("terminal control archives assignments before checkpointing", async () => {
    const dataRoot = await createControllerDataRoot("tasked-control-archive-");
    const controller = asTaskRunApi(new TaskedSubagentsController(fakePi(), { runtime: new CancelSpyRuntime(), dataRoot }));
    controller.restoreState(recoverableState("attention"));

    await expect(controller.cancelRun("a1")).resolves.toBe(true);

    const archives = await new DurableObjectStore(dataRoot).listAssignmentArchives("pi-tasked-subagents", "a1");
    expect(archives).toHaveLength(1);
    expect(archives[0].archive).toMatchObject({ assignmentId: "a1", status: "cancelled", runId: "run-1" });
  });

  test("terminal handling consumes wait suppression without emitting when signals are disabled", async () => {
    const pi = fakePi();
    const controllerWithPi = asTaskRunApi(new TaskedSubagentsController(pi, { runtime: new CompletingRuntime() }));
    controllerWithPi.restoreState({
      version: 4, currentTaskRunId: "task-run-1", updatedAt: 1,
      taskRuns: [{
        id: "task-run-1", title: "Task run", request: "Do it", context: "Context", status: "pending",
        groups: [{ id: "main", title: "Main", status: "ready", dependsOn: [], maxConcurrency: 1, createdAt: 1, updatedAt: 1 }],
        tasks: [{ id: "task", groupId: "main", text: "Do it", status: "ready", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 }],
        assignments: [], artifacts: [], createdAt: 1, updatedAt: 1,
      }],
    });
    signalSuppressionCounts(controllerWithPi).set("task-run-1", 1);

    await controllerWithPi.dispatchReady({ taskRunId: "task-run-1", emitTerminalSignal: false });

    expect(signalSuppressionCounts(controllerWithPi)).toEqual(new Map());
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  test("clear checkpoints only archive refs retained by the resulting state", async () => {
    const persistence = new ArchiveRefRecordingPersistence();
    const controller = asTaskRunApi(new TaskedSubagentsController(fakePi(), { persistence }));
    const state = recoverableState("attention");
    const refs: ArchiveRef[] = [
      { assignmentId: "a1", assignmentIdHash: sha256Hex("a1"), archiveId: "a".repeat(64), taskRunId: "task-run-1", completedAt: 1 },
      { assignmentId: "other", assignmentIdHash: sha256Hex("other"), archiveId: "b".repeat(64), taskRunId: "other-run", completedAt: 1 },
    ];
    controller.restoreState(state, refs);

    await expect(controller.clear("completed", "task-run-1")).resolves.toBe(1);
    expect(persistence.checkpointContexts.at(-1)?.archiveRefs).toEqual([refs[1]]);

    controller.restoreState(state, refs);
    await expect(controller.clear("all")).resolves.toBe(1);
    expect(persistence.checkpointContexts.at(-1)?.archiveRefs).toEqual([]);
  });

  test("clear removes completed task runs", async () => {
    const { controller } = controllerWith(new CompletingRuntime());
    await controller.setTasks(baseSetTasks);
    await controller.awaitLastWork();

    await expect(controller.clear()).resolves.toBe(1);

    expect(controller.getState().taskRuns).toEqual([]);
  });

  test("targeted clear resolves completed archive group, task, and assignment ids without clearing active runs", async () => {
    const { controller } = controllerWith(new CompletingRuntime());
    const active = recoverableState("running");
    active.completedHistory = [{
      taskRunId: "completed-run", title: "Completed", status: "completed", createdAt: 1, updatedAt: 2, completedAt: 2,
      groupCount: 1, taskCount: 1, assignmentCount: 1, assignmentArchiveIds: ["a".repeat(64)],
      archives: [{ archiveId: "a".repeat(64), assignmentId: "archived-assignment", taskRunId: "completed-run", groupId: "archived-group", taskId: "archived-task", status: "completed", runId: "archived-run", resultId: "b".repeat(32), completedAt: 2, summary: "Done", criteriaEvidence: [], artifacts: [], followUps: [] }],
    }];
    controller.restoreState(active);

    for (const targetId of ["archived-group", "archived-task", "archived-assignment"]) {
      controller.restoreState(active);
      await expect(controller.clear("completed", targetId)).resolves.toBe(1);
      expect(controller.getState().taskRuns).toHaveLength(1);
      expect(controller.getState().completedHistory).toEqual([]);
    }

    await expect(controller.clear("completed", "a1")).resolves.toBe(0);
    expect(controller.getState().taskRuns).toHaveLength(1);
  });

  test("targeted clear removes only the requested inactive TaskRun", async () => {
    const { controller } = controllerWith(new CompletingRuntime());
    const state = recoverableState("attention");
    const other = structuredClone(state.taskRuns[0]);
    other.id = "task-run-other";
    other.title = "Other run";
    other.assignments[0].taskRunId = other.id;
    state.taskRuns.push(other);
    state.currentTaskRunId = other.id;
    controller.restoreState(state);

    await expect(controller.clear("completed", "task-run-1")).resolves.toBe(1);

    expect(controller.getState().taskRuns.map((taskRun) => taskRun.id)).toEqual(["task-run-other"]);
  });

  test("targeted relaunch becomes the TaskRun displayed after clearing the prior current run", async () => {
    const runtime = new CompletingRuntime();
    const { controller } = controllerWith(runtime);
    const state = recoverableState("attention");
    state.taskRuns[0].id = "task-run-relaunch";
    state.taskRuns[0].title = "Relaunched run";
    state.taskRuns[0].assignments[0].taskRunId = "task-run-relaunch";
    const stale = structuredClone(state.taskRuns[0]);
    stale.id = "task-run-stale";
    stale.title = "Stale run";
    stale.assignments[0].taskRunId = stale.id;
    const completed = structuredClone(state.taskRuns[0]);
    completed.id = "task-run-completed";
    completed.title = "Completed current run";
    completed.status = "completed";
    completed.tasks[0].status = "completed";
    completed.assignments[0].taskRunId = completed.id;
    completed.assignments[0].status = "completed";
    state.taskRuns = [state.taskRuns[0], stale, completed];
    state.currentTaskRunId = completed.id;
    controller.restoreState(state);

    await controller.clear();
    await expect(controller.continueTarget("task-run-relaunch", "retry now")).resolves.toBe(true);
    await controller.awaitLastWork();

    expect(controller.getState().currentTaskRunId).toBe("task-run-relaunch");
  });

  test("awaits durable structural, launch, and terminal boundaries while keeping progress UI-only", async () => {
    const pi = fakePi();
    const runtime = new CompletedProgressNoResultRuntime();
    const persistence = new RecordingPersistence();
    const controller = asTaskRunApi(new TaskedSubagentsController(pi, { runtime, persistence } as never));

    await controller.setTasks({ ...baseSetTasks, wait: true });

    expect(persistence.snapshots).toHaveLength(4);
    expect(persistence.snapshots[0].taskRuns[0].assignments).toHaveLength(0);
    expect(persistence.snapshots[1].taskRuns[0].assignments[0]).toMatchObject({ status: "queued" });
    expect(persistence.snapshots[2].taskRuns[0].assignments[0]).toMatchObject({ status: "running", launchRef: expect.any(Object) });
    expect(persistence.snapshots[3].taskRuns[0].assignments[0]).toMatchObject({ status: "attention" });
    expect(controller.getState().taskRuns[0].assignments[0].status).toBe("attention");
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  test("cancels and rolls back a spawned launch when launch-handle durability fails", async () => {
    const pi = fakePi();
    const runtime = new LaunchControlledRuntime();
    const persistence = new RecordingPersistence();
    persistence.failAt = 3;
    const controller = asTaskRunApi(new TaskedSubagentsController(pi, { runtime, persistence } as never));

    const request = controller.setTasks({ ...baseSetTasks, wait: true });
    await runtime.launchStarted;
    runtime.releaseLaunch();
    await request;

    expect(runtime.cancelled).toHaveLength(1);
    const assignment = controller.getState().taskRuns[0].assignments[0];
    expect(assignment).toMatchObject({ status: "queued" });
    expect(assignment.launchRef).toBeUndefined();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  test("launch durability compensation re-resolves a replaced live assignment by id", async () => {
    const runtime = new PostSpawnCancelControlledRuntime();
    const persistence = new RecordingPersistence();
    persistence.failAt = 3;
    const controller = asTaskRunApi(new TaskedSubagentsController(fakePi(), { runtime, persistence } as never));

    const request = controller.setTasks({ ...baseSetTasks, wait: true });
    await runtime.launchStarted;
    runtime.releaseLaunch();
    await runtime.cancelStarted;

    const live = (controller as unknown as { state: TaskedSubagentsState }).state.taskRuns[0].assignments[0];
    (controller as unknown as { state: TaskedSubagentsState }).state.taskRuns[0].assignments[0] = {
      ...live,
      status: "running",
      runId: runtime.requests[0].runId,
      updatedAt: 999,
    };
    runtime.finishCancel();
    await request;

    const assignment = controller.getState().taskRuns[0].assignments[0];
    expect(assignment).toMatchObject({ status: "queued" });
    expect(assignment.updatedAt).not.toBe(999);
    expect(assignment.runId).toBeUndefined();
    expect(assignment.launchRef).toBeUndefined();
  });

  test("does not claim cancellation or checkpoint queued compensation when post-spawn cancellation fails", async () => {
    const runtime = new FailedLaunchCancellationRuntime();
    const persistence = new RecordingPersistence();
    persistence.failAt = 2;
    const controller = asTaskRunApi(new TaskedSubagentsController(fakePi(), { runtime, persistence } as never));
    controller.restoreState({
      version: 4,
      currentTaskRunId: "task-run-1",
      updatedAt: 1,
      taskRuns: [{
        id: "task-run-1",
        title: "Task run",
        request: "Ship it",
        context: "Context",
        status: "pending",
        groups: [{ id: "main", title: "Main", status: "ready", dependsOn: [], maxConcurrency: 1, createdAt: 1, updatedAt: 1 }],
        tasks: [{ id: "task", groupId: "main", text: "Do task", status: "ready", criteria: [{ id: "C1", text: "Done", satisfied: false, evidence: [] }], dependsOn: [], assignmentIds: [], createdAt: 1, updatedAt: 1 }],
        assignments: [],
        artifacts: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    await expect(controller.dispatchReady({ taskRunId: "task-run-1" })).resolves.toMatchObject({
      launched: 0,
      hasBlockingIssue: true,
      errors: [expect.stringContaining("Could not cancel")],
    });

    expect(runtime.cancelled).toHaveLength(1);
    expect(persistence.snapshots).toHaveLength(2);
    expect(controller.getState().taskRuns[0].assignments[0]).toMatchObject({
      status: "running",
      runId: runtime.requests[0].runId,
      launchRef: expect.objectContaining({ runId: runtime.requests[0].runId }),
    });
    expect(liveRunIds(controller).has(runtime.requests[0].runId)).toBe(true);
  });

  test("preflights oversized structural mutations without changing controller state", async () => {
    const runtime = new CompletingRuntime();
    const { controller } = controllerWith(runtime);
    await controller.setTasks({ ...baseSetTasks, wait: true });
    const initial = controller.getState();
    const oversized = "x".repeat(2 * 1024 * 1024);

    await expect(controller.patchTaskRun({ taskRunId: "task-run-1", tasks: [{ id: "large", group: "main", text: oversized, criteria: ["Done"] }] }))
      .resolves.toMatchObject({ patched: false, dispatchScheduled: false, errors: [expect.stringContaining("2 MiB")] });
    expect(controller.getState()).toEqual(initial);

    await expect(controller.editTask({ taskRunId: "task-run-1", targetId: "task", task: { text: oversized } }))
      .resolves.toMatchObject({ edited: false, dispatchScheduled: false, errors: [expect.stringContaining("2 MiB")] });
    expect(controller.getState()).toEqual(initial);

    controller.restoreState(recoverableState());
    const recoverableInitial = controller.getState();
    await expect(controller.editGroup({ taskRunId: "task-run-1", targetId: "main", group: { title: oversized } }))
      .resolves.toMatchObject({ edited: false, dispatchScheduled: false, errors: [expect.stringContaining("2 MiB")] });
    expect(controller.getState()).toEqual(recoverableInitial);

    await expect(controller.continueTarget("attention", oversized)).resolves.toBe(false);
    expect(controller.getState()).toEqual(recoverableInitial);
    await expect(controller.resolveTarget("attention", oversized)).resolves.toBe(false);
    expect(controller.getState()).toEqual(recoverableInitial);
  });

  test("rejects a missing session persistence context before it reaches the coordinator", async () => {
    const { controller } = controllerWith(new CompletingRuntime());

    await expect(controller.flushPersistence({})).rejects.toThrow("Checkpoint context has no active session");
  });

  test("preflights oversized setTasks and more than 100 recoverable runs before mutating", async () => {
    const { controller } = controllerWith(new CompletingRuntime());
    const oversized = "x".repeat(2 * 1024 * 1024);
    await expect(controller.setTasks({ ...baseSetTasks, context: oversized }))
      .resolves.toMatchObject({ accepted: false, dispatchScheduled: false, errors: [expect.stringContaining("2 MiB")] });
    expect(controller.getState()).toEqual({ version: 4, taskRuns: [], updatedAt: expect.any(Number) });

    const seeded = recoverableState();
    seeded.taskRuns = Array.from({ length: 100 }, (_, index) => {
      const run = structuredClone(recoverableState().taskRuns[0]);
      run.id = `task-run-${index}`;
      return run;
    });
    seeded.currentTaskRunId = seeded.taskRuns[0].id;
    controller.restoreState(seeded);
    const before = controller.getState();

    await expect(controller.setTasks({ ...baseSetTasks, taskRunId: "task-run-101" }))
      .resolves.toMatchObject({ accepted: false, dispatchScheduled: false, errors: [expect.stringContaining("more than 100")] });
    expect(controller.getState()).toEqual(before);
  });

  test("clear all rejects new TaskRuns while active cancellation is in progress", async () => {
    const runtime = new CancelControlledRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks(baseSetTasks);
    await runtime.waitStarted;
    const clearing = controller.clear("all");
    await runtime.cancelStarted;

    await expect(controller.setTasks({ ...baseSetTasks, title: "Too late" })).resolves.toMatchObject({
      accepted: false,
      dispatchScheduled: false,
    });

    runtime.finishCancel();
    await clearing;
    expect(controller.getState().taskRuns).toEqual([]);
  });

  test("clear all cancels a committed active run before removing its state", async () => {
    const runtime = new ControlledSpyRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks(baseSetTasks);
    await runtime.waitStarted;

    await expect(controller.clear("all")).resolves.toBe(1);

    expect(runtime.cancelled).toHaveLength(1);
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

  test("reconcileRestoredRuns re-attaches an orphaned running assignment and applies completion", async () => {
    const runtime = new RestoredCompletingRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState("running"));

    controller.reconcileRestoredRuns();
    await controller.awaitLastWork();

    const taskRun = controller.getState().taskRuns[0];
    expect(taskRun.assignments.find((assignment) => assignment.id === "a1")?.status).toBe("completed");
    expect(liveRunIds(controller).size).toBe(0);
  });

  test("reconcileRestoredRuns marks a dead orphaned run as attention instead of leaving it running", async () => {
    const runtime = new DeadAttentionRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState("running"));

    controller.reconcileRestoredRuns();
    await controller.awaitLastWork();

    expect(controller.getState().taskRuns[0].assignments.find((assignment) => assignment.id === "a1")?.status).toBe("attention");
    expect(liveRunIds(controller).size).toBe(0);
  });

  test("reconcileRestoredRuns keeps waiting while an alive run times out, then applies once", async () => {
    const runtime = new AliveThenCompleteRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState("running"));

    controller.reconcileRestoredRuns();
    await controller.awaitLastWork();

    expect(runtime.waitCalls).toBe(3);
    expect(runtime.aliveCalls).toBeGreaterThanOrEqual(2);
    expect(runtime.resultCalls).toBe(1);
    expect(controller.getState().taskRuns[0].assignments.find((assignment) => assignment.id === "a1")?.status).toBe("completed");
  });

  test("restored lifecycle retains dependency and attention context for attach, status, inspect, results, and controls", async () => {
    const dataRoot = await createControllerDataRoot("tasked-restored-lifecycle-");
    try {
      const assignmentId = "archived-assignment";
      const resultId = "d".repeat(32);
      const store = new DurableObjectStore(dataRoot);
      const archive = projectAssignmentArchive({
        assignmentId,
        taskRunId: "archived-run",
        taskId: "archived-task",
        status: "completed",
        summary: "archived lifecycle result",
        criteriaEvidence: [],
        artifacts: [],
        followUps: [],
        runId: "archived-dispatch",
        resultId,
        completedAt: 1,
      });
      const archiveId = await store.put("assignment", archive, 256 * 1024);
      await store.linkAssignmentArchive("pi-tasked-subagents", assignmentId, archiveId);
      await mkdir(join(dataRoot, "results", "pi-tasked-subagents"), { recursive: true });
      await writeFile(join(dataRoot, "results", "pi-tasked-subagents", `${resultId}.json`), "restored authoritative result");

      const runtime = new StopSpyRuntime();
      const controller = asTaskRunApi(new TaskedSubagentsController(fakePi(), { runtime, dataRoot }));
      const restored = recoverableState("attention");
      restored.taskRuns[0].groups.unshift({
        id: "setup",
        title: "Setup",
        status: "completed",
        dependsOn: [],
        maxConcurrency: 1,
        createdAt: 1,
        updatedAt: 1,
        completedAt: 1,
      });
      restored.taskRuns[0].groups.find((group) => group.id === "main")!.dependsOn = ["setup"];
      controller.restoreState(restored, [{
        assignmentId,
        assignmentIdHash: sha256Hex(assignmentId),
        archiveId,
        resultId,
        taskRunId: "archived-run",
        completedAt: 1,
      }]);

      await expect(controller.attachTarget("attention")).resolves.toMatchObject({ attached: true, taskRunId: "task-run-1" });
      expect(formatStatusReport(controller.getState(), "attention")).toMatch(/attention/i);
      expect(formatInspectReport(controller.getState(), "main")).toContain("depends on: setup");
      await expect(controller.getRunResult(assignmentId)).resolves.toBe("restored authoritative result");

      await expect(controller.cancelRun("a1")).resolves.toBe(true);
      expect(controller.getState().taskRuns[0].assignments.find((assignment) => assignment.id === "a1")?.status).toBe("cancelled");

      controller.restoreState(recoverableState("attention"));
      await expect(controller.continueTarget("attention", "resume restored attention")).resolves.toBe(true);
      await controller.awaitLastWork();
      expect(controller.getState().taskRuns[0].assignments.some((assignment) => assignment.status === "completed")).toBe(true);

      controller.restoreState(recoverableState("attention"));
      await expect(controller.resolveTarget("attention", "verify restored recovery")).resolves.toBe(true);
      await controller.awaitLastWork();
      expect(controller.getState().taskRuns[0].tasks.find((task) => task.id === "attention")?.status).toBe("completed");

      controller.restoreState(recoverableState("running"));
      markRunLive(controller, "run-1");
      await expect(controller.stopRun("a1")).resolves.toBe(true);
      expect(runtime.stopped).toContainEqual(expect.objectContaining({ runId: "run-1" }));
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("session_tree restore re-attaches an in-flight run and applies the outcome exactly once", async () => {
    const runtime = new MultiWaitControlledRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks(baseSetTasks);
    await vi.waitFor(() => expect(runtime.waitResolvers.length).toBe(1));
    await vi.waitFor(() => expect(controller.getState().taskRuns[0].assignments[0]?.status).toBe("running"));

    const restored = controller.getState();
    controller.restoreState(restored);
    controller.reconcileRestoredRuns();
    await vi.waitFor(() => expect(runtime.waitResolvers.length).toBe(2));

    runtime.resolveWait(1, "completed");
    await controller.awaitLastWork();

    runtime.resolveWait(0, "completed");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const taskRun = controller.getState().taskRuns[0];
    expect(taskRun.assignments[0].status).toBe("completed");
    expect(runtime.resultCalls).toBe(1);
  });

  test("an aborted prior-epoch dispatch does not clear the reconciled watcher's liveness", async () => {
    const runtime = new MultiWaitControlledRuntime();
    const { controller } = controllerWith(runtime);

    await controller.setTasks(baseSetTasks);
    await vi.waitFor(() => expect(runtime.waitResolvers.length).toBe(1));
    await vi.waitFor(() => expect(controller.getState().taskRuns[0].assignments[0]?.status).toBe("running"));

    const restored = controller.getState();
    const runId = runtime.requests[0].runId;
    controller.restoreState(restored);
    controller.reconcileRestoredRuns();
    await vi.waitFor(() => expect(runtime.waitResolvers.length).toBe(2));

    expect(liveRunIds(controller).has(runId)).toBe(true);

    runtime.resolveWait(0, "completed");
    await Promise.resolve();
    await Promise.resolve();

    expect(liveRunIds(controller).has(runId)).toBe(true);

    runtime.resolveWait(1, "completed");
    await controller.awaitLastWork();

    expect(liveRunIds(controller).has(runId)).toBe(false);
    expect(controller.getState().taskRuns[0].assignments[0].status).toBe("completed");
  });

  test("reconcileRestoredRuns gives a dead run only a short result grace before resolving attention", async () => {
    const runtime = new DeadAttentionRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState("running"));

    controller.reconcileRestoredRuns();
    await controller.awaitLastWork();

    expect(runtime.timeouts[0]).toBe(5_000);
    expect(controller.getState().taskRuns[0].assignments.find((assignment) => assignment.id === "a1")?.status).toBe("attention");
  });

  test("attachTarget waits for reconciled restored watchers before reporting", async () => {
    const runtime = new RestoredControlledRuntime();
    const { controller } = controllerWith(runtime);
    controller.restoreState(recoverableState("running"));
    controller.reconcileRestoredRuns();
    await runtime.waitStarted;

    let settled = false;
    const attached = controller.attachTarget("task-run-1").then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();

    expect(settled).toBe(false);

    runtime.complete("completed");

    await expect(attached).resolves.toMatchObject({ attached: true, targetId: "task-run-1" });
    expect(controller.getState().taskRuns[0].assignments.find((assignment) => assignment.id === "a1")?.status).toBe("completed");
  });
});
