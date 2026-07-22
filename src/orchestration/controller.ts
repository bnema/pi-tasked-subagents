// ──────────────────────────────────────────────
// Task-run controller for pi-tasked-subagents
// ──────────────────────────────────────────────

import { readFile } from "node:fs/promises";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  COMMAND_NAME,
  DEFAULT_WIDGET_LINES,
  ENTRY_TYPE_ATTENTION,
  ENTRY_TYPE_ATTENTION_REMINDER,
  ENTRY_TYPE_COMPLETION,
  ENTRY_TYPE_FAILURE,
  ENTRY_TYPE_STALE_ASSIGNMENT,
  ENTRY_TYPE_STATE,
  PACKAGE_NAME,
  STALE_ASSIGNMENT_ATTENTION_MS,
  STALE_ASSIGNMENT_WARNING_MS,
} from "../defaults.js";
import type {
  AckResult,
  AttachResult,
  EditGroupInput,
  EditGroupResult,
  EditTaskInput,
  EditTaskResult,
  PatchTaskRunInput,
  PatchTaskRunResult,
  RunProgressSnapshot,
  RunStatus,
  SetTasksInput,
  SetTasksResult,
  SubagentRunHandle,
  SubagentRuntime,
  SubagentTaskReport,
  TaskAssignmentRecord,
  TaskGroupRecord,
  TaskRecord,
  TaskRunRecord,
  TaskedSubagentsState,
} from "../types.js";
import { PiRunnerAdapter } from "../launcher/pi-runner-adapter.js";
import type { RunnerRuntimeContext } from "../launcher/interface.js";
import { cloneState, createEmptyState, createStateLock, ensureState } from "../state/store.js";
import { DurableObjectStore } from "../state/object-store.js";
import { sha256Hex } from "../state/canonical-json.js";
import {
  buildCheckpointProjection,
  projectAssignmentArchive,
  type ArchiveRef,
} from "../state/durable-projection.js";
import type { AssignmentArchiveV1, TerminalAssignmentArchiveStatus } from "../state/durable-types.js";
import { resultFilePath, sessionStoragePaths } from "../state/storage-paths.js";
import {
  PersistenceCoordinator,
  type CheckpointContext,
  type CheckpointResult,
} from "../state/persistence-coordinator.js";
import type { StatePointerV5 } from "../state/durable-types.js";
import { resolveStorageRoot } from "../state/storage-paths.js";
import { normalizeTaskRunInput, validateTaskRunInput } from "../state/task-run-validation.js";
import { statusLabel } from "../ui/messages.js";
import { buildFooterStatus } from "../ui/status.js";
import { buildWidgetLines, createWidgetContent } from "../ui/widget.js";
import { formatCompactDuration, shortTitle } from "../utils/text.js";
import {
  applyAssignmentProgress,
  createReadyAssignments,
  deriveTaskRunStatus,
  toLaunchTaskEntries,
} from "./task-scheduler.js";
import { applySubagentTaskReport, parseTaskReport } from "./task-result-reducer.js";
import { isSupersededAssignment } from "./assignment-attempts.js";
import { formatAttachReport } from "./commands.js";
import { normalizeTargetId } from "./ids.js";
import { maxDispatchRunCounter, maxTaskRunCounter } from "./run-counters.js";
import { applyTaskRunPatchMutable, taskRunToInput } from "./task-run-patch.js";

export type { AckResult, AttachResult, EditGroupInput, EditGroupResult, EditTaskInput, EditTaskResult, PatchTaskRunInput, PatchTaskRunResult, SetTasksInput, SetTasksResult } from "../types.js";

export interface DispatchOptions {
  maxConcurrency?: number;
  defaultAgent?: string;
  defaultCwd?: string;
  ctx?: ExtensionContext;
  taskRunId?: string;
  emitTerminalSignal?: boolean;
}

export interface DispatchResult {
  launched: number;
  skipped: number;
  errors: string[];
  hasBlockingIssue: boolean;
}

export interface ControllerPersistence {
  checkpoint(state: TaskedSubagentsState, context: CheckpointContext): Promise<CheckpointResult>;
  retryDirty(context: CheckpointContext): Promise<CheckpointResult>;
  flush(context: CheckpointContext): Promise<void>;
  invalidate(epoch: number): void;
}

export interface TaskedSubagentsControllerOptions {
  runtime?: SubagentRuntime<RunnerRuntimeContext>;
  launcher?: SubagentRuntime<RunnerRuntimeContext>;
  defaultAgent?: string;
  /** Injectable coordinator boundary for tests and extension lifecycle wiring. */
  persistence?: ControllerPersistence;
  dataRoot?: string;
  /** Test seam; production uses the same store for archives and checkpoints. */
  objectStore?: DurableObjectStore;
  /** Idle span before a running assignment emits a heartbeat warning. */
  staleWarningMs?: number;
  /** Idle span before a running assignment escalates to attention. */
  staleAttentionMs?: number;
}

export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceError";
  }
}

const DEFAULT_OPTIONS = {
  runtime: new PiRunnerAdapter(),
  defaultAgent: "delegate",
} satisfies { runtime: SubagentRuntime<RunnerRuntimeContext>; defaultAgent: string };

const DEAD_RUN_RESULT_GRACE_MS = 5_000;

function terminalStatus(status: RunStatus): boolean {
  return status !== "queued" && status !== "running";
}

function finalWaitStatus(status: RunStatus): RunStatus {
  return terminalStatus(status) ? status : "attention";
}

function completedStatus(status: RunStatus): boolean {
  return status === "completed" || status === "skipped";
}

function finalAssignmentStatus(status: TaskAssignmentRecord["status"]): status is TerminalAssignmentArchiveStatus {
  return status === "completed" || status === "failed" || status === "skipped" || status === "cancelled";
}

function statusForUnhandledAssignment(
  assignment: TaskAssignmentRecord,
  runStatus: RunStatus,
): TaskAssignmentRecord["status"] | undefined {
  if (assignment.status === "completed") return assignment.result ? undefined : "attention";
  if (assignment.status === "failed" || assignment.status === "skipped" || assignment.status === "cancelled") return undefined;
  if (completedStatus(runStatus)) return "attention";
  if (runStatus === "blocked") return "attention";
  return runStatus;
}

function controlStatusForAssignment(
  currentStatus: TaskAssignmentRecord["status"],
  targetStatus: RunStatus,
): TaskAssignmentRecord["status"] | undefined {
  if (targetStatus === "paused") return currentStatus === "queued" || currentStatus === "running" ? "paused" : undefined;
  if (targetStatus === "cancelled") return finalAssignmentStatus(currentStatus) ? undefined : "cancelled";
  return undefined;
}

interface StaleAssignmentEntry {
  assignmentId: string;
  agent: string;
  idleMs: number;
  lastActionSummary?: string;
}

interface StaleAssignmentSignal {
  taskRunId: string;
  kind: "stale-assignment" | "stale-escalation";
  entries: StaleAssignmentEntry[];
}

function staleEntry(assignment: TaskAssignmentRecord, idleMs: number): StaleAssignmentEntry {
  return {
    assignmentId: assignment.id,
    agent: assignment.agent,
    idleMs,
    ...(assignment.lastActionSummary ? { lastActionSummary: assignment.lastActionSummary } : {}),
  };
}

function progressSignature(snapshot: RunProgressSnapshot): string {
  return JSON.stringify({
    runId: snapshot.runId,
    status: snapshot.status,
    steps: snapshot.steps.map((step) => ({
      id: step.id,
      status: step.status,
      currentTool: step.currentTool,
      lastActionAt: step.lastActionAt,
      lastActionSummary: step.lastActionSummary,
      recentActivity: step.recentActivity,
    })),
  });
}

function parseReportsFromRaw(raw: string | undefined): Array<{ assignmentId?: string; report: SubagentTaskReport }> {
  if (!raw?.trim()) return [];
  const single = parseTaskReport(raw);
  if (single) return [{ assignmentId: single.assignmentId, report: single }];

  try {
    const parsed = JSON.parse(raw) as { results?: Array<{ stepId?: string | number; output?: string; rawOutput?: string }> };
    return (parsed.results ?? [])
      .map((result) => {
        const output = result.rawOutput ?? result.output ?? "";
        const report = parseTaskReport(output);
        return report ? { assignmentId: String(result.stepId ?? report.assignmentId), report } : undefined;
      })
      .filter((entry): entry is { assignmentId: string; report: SubagentTaskReport } => Boolean(entry));
  } catch {
    return [];
  }
}

type MutableTarget =
  | { kind: "taskRun"; taskRun: TaskRunRecord }
  | { kind: "group"; taskRun: TaskRunRecord; group: TaskGroupRecord }
  | { kind: "task"; taskRun: TaskRunRecord; group?: TaskGroupRecord; task: TaskRecord }
  | { kind: "assignment"; taskRun: TaskRunRecord; assignment: TaskAssignmentRecord; group?: TaskGroupRecord; task: TaskRecord };

function recoverableTaskStatus(status: string): boolean {
  return status === "attention" || status === "failed" || status === "blocked" || status === "cancelled";
}

/** A task/assignment state an external fix can acknowledge as resolved. */
function ackEligibleStatus(status: string): boolean {
  return status === "attention" || status === "blocked" || status === "paused" || status === "failed";
}

function assignmentResolutionLines(taskRun: TaskRunRecord, task: TaskRecord): string[] {
  return task.assignmentIds
    .map((assignmentId) => taskRun.assignments.find((assignment) => assignment.id === assignmentId))
    .filter((assignment): assignment is TaskAssignmentRecord => Boolean(assignment))
    .map((assignment) => {
      const details = [
        assignment.result?.summary ? `summary: ${assignment.result.summary}` : undefined,
        assignment.result?.followUps.length ? `follow-ups: ${assignment.result.followUps.join("; ")}` : undefined,
      ].filter((line): line is string => Boolean(line));
      return [`- ${assignment.id} (${assignment.status})`, ...details.map((line) => `  ${line}`)].join("\n");
    });
}

function buildResolutionPrompt(taskRun: TaskRunRecord, task: TaskRecord, prompt: string): string {
  const priorAssignments = assignmentResolutionLines(taskRun, task);
  return [
    "The main agent reports that previous findings or blockers for this task were fixed.",
    "Verification only: inspect the fix context, run focused checks when useful, and do not perform broad unrelated work.",
    "Return status=completed only if the issue is resolved with concrete evidence. Return status=attention with remaining findings if unresolved.",
    "",
    "Fix context:",
    prompt.trim(),
    priorAssignments.length > 0 ? "" : undefined,
    priorAssignments.length > 0 ? "Previous assignment results:" : undefined,
    ...priorAssignments,
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function launchRefForAssignments(ref: SubagentRunHandle, assignments: TaskAssignmentRecord[]): SubagentRunHandle {
  const entries = assignments.map((assignment) => {
    const existing = ref.assignments.find((entry) => entry.assignmentId === assignment.id && entry.runId === ref.runId);
    return existing ?? { assignmentId: assignment.id, runId: ref.runId, ...(ref.resultPath ? { resultPath: ref.resultPath } : {}) };
  });
  return { ...ref, assignments: entries };
}

export class TaskedSubagentsController {
  private state: TaskedSubagentsState = createEmptyState();
  private readonly lock = createStateLock();
  private readonly runtime: SubagentRuntime<RunnerRuntimeContext>;
  private readonly defaultAgent: string;
  private readonly pi: ExtensionAPI;
  private readonly persistence: ControllerPersistence;
  private readonly objectStore: DurableObjectStore;
  private readonly dataRoot: string;
  private readonly staleWarningMs: number;
  private readonly staleAttentionMs: number;
  /** Immutable terminal archives visible to the next checkpoint. */
  private archiveRefs: ArchiveRef[] = [];
  private taskRunCounter = 0;
  private lastContext: ExtensionContext | undefined;
  private lastDispatchWork: Promise<void> = Promise.resolve();
  private readonly scheduledDispatches = new Map<string, Promise<void>>();
  private readonly runProgressSignatures = new Map<string, string>();
  /** Ephemeral polling hint used only to present an ambiguous failed wait. */
  private readonly terminalProgressAssignmentIds = new Set<string>();
  private readonly liveRunIds = new Map<string, number>();
  private readonly launchingRuns = new Map<string, string[]>();
  private readonly cancellationRequestedRunIds = new Set<string>();
  private readonly signalSuppressionCounts = new Map<string, number>();
  /** Task runs the settling turn already acked/resolved/continued; skipped by the next reminder. */
  private readonly attentionActionedTaskRunIds = new Set<string>();
  private clearAllInProgress = false;
  private stateEpoch = 0;
  private dispatchRunCounter = 0;

  constructor(pi: ExtensionAPI, options?: TaskedSubagentsControllerOptions) {
    this.pi = pi;
    this.runtime = options?.runtime ?? options?.launcher ?? DEFAULT_OPTIONS.runtime;
    this.defaultAgent = options?.defaultAgent ?? DEFAULT_OPTIONS.defaultAgent;
    this.dataRoot = resolveStorageRoot({ dataRoot: options?.dataRoot });
    this.objectStore = options?.objectStore ?? new DurableObjectStore(this.dataRoot);
    this.staleWarningMs = options?.staleWarningMs ?? STALE_ASSIGNMENT_WARNING_MS;
    this.staleAttentionMs = options?.staleAttentionMs ?? STALE_ASSIGNMENT_ATTENTION_MS;
    this.persistence = options?.persistence ?? new PersistenceCoordinator(
      this.objectStore,
      { append: (pointer) => this.pi.appendEntry(ENTRY_TYPE_STATE, pointer) },
      { dataRoot: this.dataRoot },
    );
  }

  getState(): TaskedSubagentsState {
    return cloneState(this.state);
  }

  /** Fence stale asynchronous work without discarding the last valid restore. */
  fenceRestore(): number {
    this.stateEpoch += 1;
    this.persistence.invalidate(this.stateEpoch);
    return this.stateEpoch;
  }

  /** Install an asynchronous restore only when no newer lifecycle has fenced it. */
  installRestoredState(state: TaskedSubagentsState, archiveRefs: readonly ArchiveRef[] = [], expectedEpoch: number): boolean {
    if (this.stateEpoch !== expectedEpoch) return false;
    this.restoreState(state, archiveRefs);
    return true;
  }

  restoreState(state: TaskedSubagentsState, archiveRefs: readonly ArchiveRef[] = []): void {
    const completedHistory = state.completedHistory === undefined ? undefined : structuredClone(state.completedHistory);
    this.state = ensureState(state);
    if (completedHistory?.length) {
      this.state.completedHistory = completedHistory;
      if (state.currentTaskRunId && completedHistory.some((summary) => summary.taskRunId === state.currentTaskRunId)) {
        this.state.currentTaskRunId = state.currentTaskRunId;
      }
    }
    this.taskRunCounter = Math.max(this.taskRunCounter, maxTaskRunCounter(this.state.taskRuns));
    this.runProgressSignatures.clear();
    this.terminalProgressAssignmentIds.clear();
    this.liveRunIds.clear();
    this.launchingRuns.clear();
    this.cancellationRequestedRunIds.clear();
    this.signalSuppressionCounts.clear();
    // A restart re-arms one triggered reminder for any stale attention run.
    for (const taskRun of this.state.taskRuns) {
      if (taskRun.attentionNagTriggered) taskRun.attentionNagTriggered = undefined;
    }
    this.attentionActionedTaskRunIds.clear();
    this.archiveRefs = [...structuredClone(archiveRefs)];
    this.clearAllInProgress = false;
    this.scheduledDispatches.clear();
    this.lastDispatchWork = Promise.resolve();
    this.fenceRestore();
    this.dispatchRunCounter = Math.max(this.dispatchRunCounter, maxDispatchRunCounter(this.state.taskRuns));
  }

  reconcileRestoredRuns(ctx?: ExtensionContext): void {
    if (ctx) this.lastContext = ctx;
    const checkpointContext = this.checkpointContext(ctx);
    const expectedEpoch = this.stateEpoch;
    const runtimeCtx = this.runtimeContext(ctx ?? this.lastContext);
    const reconciledRunIds = new Set<string>();
    const watchersByTaskRun = new Map<string, Array<Promise<void>>>();
    for (const taskRun of this.state.taskRuns) {
      for (const assignment of taskRun.assignments) {
        if (isSupersededAssignment(assignment)) continue;
        if (assignment.status !== "queued" && assignment.status !== "running") continue;
        const handle = assignment.launchRef;
        if (!handle?.runId || !handle.asyncId || !Array.isArray(handle.assignments) || handle.assignments.length === 0) continue;
        if (!assignment.runId || assignment.runId !== handle.runId) continue;
        if (this.liveRunIds.has(handle.runId) || reconciledRunIds.has(handle.runId)) continue;
        reconciledRunIds.add(handle.runId);
        const watcher = this.watchRestoredRun(taskRun.id, handle, expectedEpoch, runtimeCtx, ctx ?? this.lastContext, checkpointContext);
        const grouped = watchersByTaskRun.get(taskRun.id) ?? [];
        grouped.push(watcher);
        watchersByTaskRun.set(taskRun.id, grouped);
      }
    }
    if (watchersByTaskRun.size === 0) return;
    const allWatchers: Array<Promise<void>> = [];
    for (const [taskRunId, watchers] of watchersByTaskRun) {
      this.registerReconcileWork(taskRunId, watchers);
      allWatchers.push(...watchers);
    }
    this.lastDispatchWork = Promise.all([this.lastDispatchWork.catch(() => undefined), ...allWatchers]).then(() => undefined);
  }

  private registerReconcileWork(taskRunId: string, watchers: Array<Promise<void>>): void {
    const previous = this.scheduledDispatches.get(taskRunId);
    const work = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => Promise.all(watchers))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(`[${PACKAGE_NAME}] reconcile failed:`, error);
      });
    this.scheduledDispatches.set(taskRunId, work);
    void work.finally(() => {
      if (this.scheduledDispatches.get(taskRunId) === work) this.scheduledDispatches.delete(taskRunId);
    });
  }

  async awaitLastWork(): Promise<void> {
    await this.lastDispatchWork;
  }

  async attachTarget(targetId?: string, ctx?: ExtensionContext): Promise<AttachResult> {
    if (ctx) this.lastContext = ctx;
    const requestedTargetId = normalizeTargetId(targetId);
    const taskRunId = await this.lock.withLock(() => this.resolveTaskRunIdForTarget(requestedTargetId));
    if (requestedTargetId && !taskRunId) {
      return {
        attached: false,
        targetId: requestedTargetId,
        report: `Attach target not found: ${requestedTargetId}.`,
      };
    }
    const work = taskRunId ? this.scheduledDispatches.get(taskRunId) : this.lastDispatchWork;
    if (work) await work;
    const finalTargetId = requestedTargetId ?? taskRunId;
    return {
      attached: Boolean(taskRunId),
      targetId: finalTargetId,
      taskRunId,
      report: formatAttachReport(this.getState(), finalTargetId),
    };
  }

  /** Explicit freeform routing creates a real one-group/one-task TaskRun. */
  async handleUserAsk(text: string, ctx?: ExtensionContext): Promise<void> {
    const request = text.trim();
    if (!request) return;
    await this.setTasks({
      title: shortTitle(request, 80),
      request,
      context: request,
      groups: [{ id: "main", title: "Main" }],
      tasks: [{ id: "task", group: "main", text: request, criteria: ["The requested task is completed with concrete evidence."] }],
    }, ctx);
  }

  async setTasks(input: SetTasksInput, ctx?: ExtensionContext): Promise<SetTasksResult> {
    if (ctx) this.lastContext = ctx;
    const checkpointContext = this.checkpointContext(ctx);
    const result = await this.lock.withLock(async () => {
      if (this.clearAllInProgress) return { accepted: false, errors: ["Clear all is in progress"], dispatchScheduled: false } satisfies SetTasksResult;
      const errors = validateTaskRunInput(input);
      if (errors.length > 0) return { accepted: false, errors, dispatchScheduled: false } satisfies SetTasksResult;

      const taskRunId = normalizeTargetId(input.taskRunId) ?? this.nextTaskRunId();
      const normalized = normalizeTaskRunInput(input, { taskRunId });
      if (!normalized.taskRun) return { accepted: false, errors: normalized.errors, dispatchScheduled: false } satisfies SetTasksResult;

      const candidate = cloneState(this.state);
      const candidateIndex = candidate.taskRuns.findIndex((taskRun) => taskRun.id === normalized.taskRun!.id);
      if (candidateIndex >= 0) candidate.taskRuns[candidateIndex] = normalized.taskRun;
      else candidate.taskRuns.push(normalized.taskRun);
      candidate.currentTaskRunId = normalized.taskRun.id;
      candidate.updatedAt = normalized.taskRun.updatedAt;
      const projectionError = this.preflightCheckpoint(candidate);
      if (projectionError) return { accepted: false, errors: [projectionError], dispatchScheduled: false } satisfies SetTasksResult;

      // Replacing a TaskRun invalidates its prior in-flight work. Appending
      // an unrelated TaskRun is non-destructive and must not fence it.
      if (candidateIndex >= 0) this.stateEpoch += 1;
      // The preflight candidate is the complete validated transition, so
      // install it rather than duplicating the live mutation.
      this.state = candidate;
      this.taskRunCounter = Math.max(this.taskRunCounter, maxTaskRunCounter(this.state.taskRuns));
      await this.checkpointWithOptionalSignalSuppression(checkpointContext, normalized.taskRun.id, input.wait);
      this.updateUI(ctx ?? this.lastContext);
      return { accepted: true, taskRunId: normalized.taskRun.id, errors: [], dispatchScheduled: true } satisfies SetTasksResult;
    });

    if (result.accepted && result.taskRunId) {
      const work = this.scheduleDispatch(result.taskRunId, ctx, { emitTerminalSignal: !input.wait });
      if (input.wait) {
        try {
          await work;
        } finally {
          this.releaseTaskRunSignal(result.taskRunId);
        }
      }
    }
    return result;
  }

  async editTask(input: EditTaskInput, ctx?: ExtensionContext): Promise<EditTaskResult> {
    if (ctx) this.lastContext = ctx;
    const checkpointContext = this.checkpointContext(ctx);
    const result = await this.lock.withLock(() => this.editTaskMutable(input, ctx, checkpointContext));
    if (result.edited && result.dispatchScheduled && result.taskRunId) {
      const work = this.scheduleDispatch(result.taskRunId, ctx, { emitTerminalSignal: !input.wait });
      if (input.wait) {
        try {
          await work;
        } finally {
          this.releaseTaskRunSignal(result.taskRunId);
        }
      }
    }
    return result;
  }

  async patchTaskRun(input: PatchTaskRunInput, ctx?: ExtensionContext): Promise<PatchTaskRunResult> {
    if (ctx) this.lastContext = ctx;
    const checkpointContext = this.checkpointContext(ctx);
    const result = await this.lock.withLock(() => this.patchTaskRunMutable(input, ctx, checkpointContext));
    if (result.patched && result.dispatchScheduled && result.taskRunId) {
      const work = this.scheduleDispatch(result.taskRunId, ctx, { emitTerminalSignal: !input.wait });
      if (input.wait) {
        try {
          await work;
        } finally {
          this.releaseTaskRunSignal(result.taskRunId);
        }
      }
    }
    return result;
  }

  async editGroup(input: EditGroupInput, ctx?: ExtensionContext): Promise<EditGroupResult> {
    if (ctx) this.lastContext = ctx;
    const checkpointContext = this.checkpointContext(ctx);
    const result = await this.lock.withLock(() => this.editGroupMutable(input, ctx, checkpointContext));
    if (result.edited && result.dispatchScheduled && result.taskRunId) {
      const work = this.scheduleDispatch(result.taskRunId, ctx, { emitTerminalSignal: !input.wait });
      if (input.wait) {
        try {
          await work;
        } finally {
          this.releaseTaskRunSignal(result.taskRunId);
        }
      }
    }
    return result;
  }

  async dispatchReady(options: DispatchOptions = {}): Promise<DispatchResult> {
    if (options.ctx) this.lastContext = options.ctx;
    const checkpointContext = this.checkpointContext(options.ctx);
    const aggregate: DispatchResult = { launched: 0, skipped: 0, errors: [], hasBlockingIssue: false };
    const runtimeCtx = this.runtimeContext(options.ctx);
    const dispatchEpoch = this.stateEpoch;

    while (true) {
      const launch = await this.lock.withLock(async () => {
        if (this.clearAllInProgress || this.stateEpoch !== dispatchEpoch) return undefined;
        const taskRun = this.resolveTaskRunMutable(options.taskRunId);
        if (!taskRun) return undefined;
        this.state.currentTaskRunId = taskRun.id;
        const scheduled = createReadyAssignments(taskRun, {
          defaultAgent: options.defaultAgent ?? this.defaultAgent,
          defaultCwd: options.defaultCwd ?? runtimeCtx.cwd,
        });
        aggregate.hasBlockingIssue ||= scheduled.hasBlockingIssue;
        if (scheduled.assignments.length === 0) {
          deriveTaskRunStatus(taskRun);
          await this.checkpointState(checkpointContext);
          this.updateUI(options.ctx ?? this.lastContext);
          return undefined;
        }
        // Assignment creation is structural: it must be durable before a
        // child can observe or depend on the queued work.
        await this.checkpointState(checkpointContext);
        const runId = this.nextDispatchRunId(taskRun.id);
        this.launchingRuns.set(runId, scheduled.assignments.map((assignment) => assignment.id));
        return { taskRunId: taskRun.id, runId, title: taskRun.title, maxConcurrency: taskRun.maxConcurrency, assignments: scheduled.assignments };
      });

      if (!launch) return aggregate;

      let ref: SubagentRunHandle | undefined;
      let preserveLiveRunForReconciliation = false;
      try {
        const taskRun = this.state.taskRuns.find((candidate) => candidate.id === launch.taskRunId);
        if (!taskRun) return aggregate;
        if (this.cancellationRequestedRunIds.delete(launch.runId)) return aggregate;
        const launchedRef = launchRefForAssignments(await this.runtime.launchTaskGraph({
          runId: launch.runId,
          title: `TaskRun ${taskRun.id}: ${taskRun.title}`,
          taskSummary: taskRun.title,
          tasks: toLaunchTaskEntries(launch.assignments, taskRun),
          maxConcurrency: options.maxConcurrency ?? launch.maxConcurrency,
          cwd: options.defaultCwd ?? runtimeCtx.cwd,
        }, runtimeCtx), launch.assignments);
        ref = launchedRef;
        if (this.cancellationRequestedRunIds.delete(launchedRef.runId)) {
          const cancelled = await this.runtime.cancelRun(launchedRef, runtimeCtx);
          if (!cancelled) throw new Error(`Could not cancel launching subagent run ${launchedRef.runId}`);
          return aggregate;
        }
        this.liveRunIds.set(launchedRef.runId, dispatchEpoch);
        if (this.stateEpoch !== dispatchEpoch) {
          await this.runtime.cancelRun(launchedRef, runtimeCtx).catch((cancelError: unknown) => {
            console.error(`[${PACKAGE_NAME}] failed to cancel stale dispatch:`, cancelError);
          });
          await this.rollbackUncommittedLaunch(launch.taskRunId, launch.assignments, options.ctx ?? this.lastContext, checkpointContext);
          return aggregate;
        }

        let failedLaunchCommit: Array<{ assignmentId: string; status: TaskAssignmentRecord["status"]; runId: string | undefined; launchRef: SubagentRunHandle | undefined; updatedAt: number }> | undefined;
        const commit = await this.lock.withLock(async () => {
          if (this.cancellationRequestedRunIds.delete(launchedRef.runId)) return "cancelled" as const;
          if (this.stateEpoch !== dispatchEpoch) return "stale" as const;
          const current = this.state.taskRuns.find((candidate) => candidate.id === launch.taskRunId);
          if (!current) return "stale" as const;
          // Keep immutable compensation data. The live assignments can be
          // replaced while cancellation is in flight after a failed checkpoint.
          const previous = launch.assignments.map((assignment) => {
            const stored = current.assignments.find((candidate) => candidate.id === assignment.id);
            return stored ? {
              assignmentId: stored.id,
              status: stored.status,
              runId: stored.runId,
              launchRef: stored.launchRef ? structuredClone(stored.launchRef) : undefined,
              updatedAt: stored.updatedAt,
            } : undefined;
          }).filter((entry): entry is { assignmentId: string; status: TaskAssignmentRecord["status"]; runId: string | undefined; launchRef: SubagentRunHandle | undefined; updatedAt: number } => Boolean(entry));
          for (const entry of previous) {
            const stored = current.assignments.find((candidate) => candidate.id === entry.assignmentId);
            if (!stored) continue;
            stored.status = "running";
            stored.runId = launchedRef.runId;
            stored.launchRef = launchedRef;
            stored.updatedAt = Date.now();
          }
          deriveTaskRunStatus(current);
          try {
            await this.checkpointState(checkpointContext);
          } catch {
            // The child is live. Keep its handle and running status in memory
            // until cancellation succeeds, so a failed cancellation remains
            // reconcilable instead of being falsely represented as queued.
            failedLaunchCommit = previous;
            this.updateUI(options.ctx ?? this.lastContext);
            return "persistence-failed" as const;
          }
          this.updateUI(options.ctx ?? this.lastContext);
          return "committed" as const;
        });
        if (commit !== "committed") {
          const cancelled = await this.runtime.cancelRun(launchedRef, runtimeCtx).catch((cancelError: unknown) => {
            console.error(`[${PACKAGE_NAME}] failed to cancel ${commit} dispatch:`, cancelError);
            return false;
          });
          if (commit === "cancelled" && !cancelled) throw new Error(`Could not cancel launching subagent run ${launchedRef.runId}`);
          if (commit === "stale") await this.rollbackUncommittedLaunch(launch.taskRunId, launch.assignments, options.ctx ?? this.lastContext, checkpointContext);
          if (commit === "persistence-failed") {
            if (!cancelled) {
              preserveLiveRunForReconciliation = true;
              aggregate.errors.push(`Could not cancel spawned subagent run ${launchedRef.runId} after launch-handle durability failed; launch remains reconcilable`);
              aggregate.hasBlockingIssue = true;
              return aggregate;
            }
            // Only a confirmed child cancellation permits compensation back to
            // queued state. A failed checkpoint remains dirty for retry.
            try {
              await this.lock.withLock(async () => {
                const current = this.state.taskRuns.find((candidate) => candidate.id === launch.taskRunId);
                if (!current || this.stateEpoch !== dispatchEpoch) return;
                for (const entry of failedLaunchCommit ?? []) {
                  // Re-resolve by ID under this lock. Never mutate the stale
                  // object captured before an intervening state transition.
                  const stored = current.assignments.find((candidate) => candidate.id === entry.assignmentId);
                  if (!stored || stored.runId !== launchedRef.runId) continue;
                  stored.status = entry.status;
                  stored.runId = entry.runId;
                  stored.launchRef = entry.launchRef ? structuredClone(entry.launchRef) : undefined;
                  stored.updatedAt = entry.updatedAt;
                }
                deriveTaskRunStatus(current);
                await this.checkpointState(checkpointContext);
                this.updateUI(options.ctx ?? this.lastContext);
              });
            } catch (error) {
              aggregate.errors.push(error instanceof Error ? error.message : String(error));
              aggregate.hasBlockingIssue = true;
              return aggregate;
            }
            aggregate.errors.push("Launch handle could not be made durable; spawned run was cancelled");
            aggregate.hasBlockingIssue = true;
            return aggregate;
          }
          return aggregate;
        }
        aggregate.launched += launch.assignments.length;

        const status = await this.waitForRunOutcome(launchedRef, dispatchEpoch, runtimeCtx, launch.taskRunId, options.ctx ?? this.lastContext);
        if (this.stateEpoch !== dispatchEpoch) return aggregate;
        const raw = await this.runtime.getRunResult(launchedRef);
        if (this.stateEpoch !== dispatchEpoch) return aggregate;
        await this.applyRunOutcome(
          launch.taskRunId,
          launchedRef.runId,
          status,
          raw,
          dispatchEpoch,
          options.ctx ?? this.lastContext,
          checkpointContext,
          options.emitTerminalSignal !== false,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        aggregate.errors.push(message);
        aggregate.hasBlockingIssue = true;
        // applyRunOutcome mutates the terminal snapshot before its archive and
        // checkpoint durability boundary. A failure there is retryable dirty
        // persistence, not a second runner failure.
        const terminalOutcomeApplied = this.stateEpoch === dispatchEpoch && this.state.taskRuns
          .find((candidate) => candidate.id === launch.taskRunId)?.assignments
          .filter((assignment) => launch.assignments.some((launched) => launched.id === assignment.id))
          .every((assignment) => finalAssignmentStatus(assignment.status)) === true;
        if (terminalOutcomeApplied) continue;
        if (this.stateEpoch !== dispatchEpoch) await this.rollbackUncommittedLaunch(launch.taskRunId, launch.assignments, options.ctx ?? this.lastContext, checkpointContext);
        let failureSignal: TaskRunRecord | undefined;
        if (this.stateEpoch === dispatchEpoch) await this.lock.withLock(async () => {
          if (this.stateEpoch !== dispatchEpoch) return;
          const taskRun = this.state.taskRuns.find((candidate) => candidate.id === launch.taskRunId);
          if (!taskRun) return;
          const timestamp = Date.now();
          for (const assignment of launch.assignments) {
            const stored = taskRun.assignments.find((candidate) => candidate.id === assignment.id);
            if (!stored) continue;
            if (ref && stored.runId !== ref.runId) continue;
            if ((stored.status === "completed" && !stored.result) || this.terminalProgressAssignmentIds.has(stored.id)) {
              stored.status = "attention";
              stored.updatedAt = timestamp;
              stored.completedAt = undefined;
              continue;
            }
            if (stored.status !== "queued" && stored.status !== "running") continue;
            stored.status = "failed";
            stored.updatedAt = timestamp;
            stored.completedAt = timestamp;
          }
          deriveTaskRunStatus(taskRun);
          failureSignal = cloneState({ version: 4, taskRuns: [taskRun], currentTaskRunId: taskRun.id, updatedAt: taskRun.updatedAt }).taskRuns[0];
          await this.checkpointState(checkpointContext);
          this.updateUI(options.ctx ?? this.lastContext);
        });
        const failureIsTerminal = failureSignal?.status !== "running" && failureSignal?.status !== "pending";
        if (failureSignal && failureIsTerminal) {
          // The snapshot is populated before the awaited checkpoint and is
          // emitted only after that durable boundary succeeds.
          this.handleTerminalSignal(
            failureSignal,
            ref?.runId ?? launch.runId,
            "failed",
            options.emitTerminalSignal !== false,
            launch.assignments.map((assignment) => assignment.id),
          );
        }
      } finally {
        this.launchingRuns.delete(launch.runId);
        this.cancellationRequestedRunIds.delete(launch.runId);
        if (ref && !preserveLiveRunForReconciliation) this.releaseLiveRun(ref.runId, dispatchEpoch);
      }
      if (this.stateEpoch !== dispatchEpoch) return aggregate;
      const shouldContinue = this.state.taskRuns
        .find((candidate) => candidate.id === launch.taskRunId)
        ?.tasks.some((task) => task.status === "ready");
      if (!shouldContinue) return aggregate;
    }
  }

  private async watchRestoredRun(
    taskRunId: string,
    handle: SubagentRunHandle,
    expectedEpoch: number,
    runtimeCtx: RunnerRuntimeContext,
    ctx: ExtensionContext | undefined,
    checkpointContext: CheckpointContext,
  ): Promise<void> {
    if (this.stateEpoch !== expectedEpoch) return;
    this.liveRunIds.set(handle.runId, expectedEpoch);
    try {
      const status = await this.waitForRunOutcome(handle, expectedEpoch, runtimeCtx, taskRunId, ctx);
      if (this.stateEpoch !== expectedEpoch) return;
      const raw = await this.runtime.getRunResult(handle);
      if (this.stateEpoch !== expectedEpoch) return;
      await this.applyRunOutcome(taskRunId, handle.runId, status, raw, expectedEpoch, ctx, checkpointContext);
    } catch (error) {
      console.error(`[${PACKAGE_NAME}] failed to reconcile restored run ${handle.runId}:`, error);
    } finally {
      this.releaseLiveRun(handle.runId, expectedEpoch);
    }
  }

  private releaseLiveRun(runId: string, ownerEpoch: number): void {
    if (this.liveRunIds.get(runId) === ownerEpoch) this.liveRunIds.delete(runId);
  }

  private async waitForRunOutcome(
    handle: SubagentRunHandle,
    expectedEpoch: number,
    runtimeCtx: RunnerRuntimeContext,
    taskRunId: string,
    ctx: ExtensionContext | undefined,
  ): Promise<RunStatus> {
    while (true) {
      const aliveBeforeWait = this.runtime.isRunAlive ? await this.runtime.isRunAlive(handle) : undefined;
      const status = finalWaitStatus(await this.runtime.waitForRunSignal(handle, {
        ctx: runtimeCtx,
        onUpdate: (snapshot) => this.applyRunProgressUpdate(taskRunId, snapshot, expectedEpoch, ctx),
        ...(aliveBeforeWait === false ? { timeoutMs: DEAD_RUN_RESULT_GRACE_MS } : {}),
      }));
      if (this.stateEpoch !== expectedEpoch) return status;
      if (status !== "attention") return status;
      if (!this.runtime.isRunAlive) return status;
      if (!(await this.runtime.isRunAlive(handle))) return status;
    }
  }

  async continueTarget(targetId: string, prompt: string, ctx?: ExtensionContext): Promise<boolean> {
    const result = await this.readyTargetForDispatch(targetId, (_taskRun, _task) => prompt.trim(), {
      ctx,
      directTargetsMustBeRecoverable: false,
      markAttentionActioned: true,
    });
    if (!result) return false;
    this.scheduleDispatch(result, ctx);
    return true;
  }

  async resolveTarget(targetId: string, prompt: string, ctx?: ExtensionContext): Promise<boolean> {
    const result = await this.readyTargetForDispatch(
      targetId,
      (taskRun, task) => buildResolutionPrompt(taskRun, task, prompt),
      { ctx, directTargetsMustBeRecoverable: true, markAttentionActioned: true },
    );
    if (!result) return false;
    this.scheduleDispatch(result, ctx);
    return true;
  }

  async ackTarget(targetId: string, reason: string, ctx?: ExtensionContext): Promise<AckResult> {
    if (ctx) this.lastContext = ctx;
    const checkpointContext = this.checkpointContext(ctx);
    return this.lock.withLock(() => this.ackTargetMutable(targetId, reason, ctx, checkpointContext));
  }

  async stopRun(assignmentId: string): Promise<boolean> {
    const checkpointContext = this.checkpointContext();
    const target = this.resolveControllableHandleForAssignment(assignmentId, "stop");
    if (!target) return false;
    const ok = await this.runtime.stopRun(target.handle, this.runtimeContext(this.lastContext));
    if (!ok) return false;
    await this.markRunStatus(target.handle.runId, "paused", checkpointContext);
    return true;
  }

  async cancelRun(assignmentId: string): Promise<boolean> {
    const checkpointContext = this.checkpointContext();
    const target = this.resolveControllableHandleForAssignment(assignmentId, "cancel");
    if (!target) return false;
    if (!target.live) {
      await this.markRunStatus(target.handle.runId, "cancelled", checkpointContext);
      return true;
    }
    const ok = await this.runtime.cancelRun(target.handle, this.runtimeContext(this.lastContext));
    if (!ok) return false;
    await this.markRunStatus(target.handle.runId, "cancelled", checkpointContext);
    return true;
  }

  async cancelActiveRuns(): Promise<number> {
    const checkpointContext = this.checkpointContext();
    const { assignmentIds, launchingRunIds } = await this.lock.withLock(async () => {
      const assignmentIds: string[] = [];
      const runIds = new Set<string>();
      for (const taskRun of this.state.taskRuns) {
        for (const assignment of taskRun.assignments) {
          if ((assignment.status !== "queued" && assignment.status !== "running") || !assignment.runId) continue;
          if (!this.liveRunIds.has(assignment.runId) || runIds.has(assignment.runId)) continue;
          if (!this.resolveHandleForAssignment(assignment.id)) continue;
          runIds.add(assignment.runId);
          assignmentIds.push(assignment.id);
        }
      }

      const launchingRunIds = [...this.launchingRuns.keys()];
      if (launchingRunIds.length > 0) {
        const launchingAssignmentIds = new Set([...this.launchingRuns.values()].flat());
        const timestamp = Date.now();
        for (const taskRun of this.state.taskRuns) {
          let changed = false;
          for (const assignment of taskRun.assignments) {
            if (!launchingAssignmentIds.has(assignment.id) || assignment.status !== "queued") continue;
            assignment.status = "cancelled";
            assignment.updatedAt = timestamp;
            assignment.completedAt = timestamp;
            changed = true;
          }
          if (changed) deriveTaskRunStatus(taskRun, timestamp);
        }
        for (const runId of launchingRunIds) this.cancellationRequestedRunIds.add(runId);
        await this.checkpointState(checkpointContext);
        this.updateUI(this.lastContext);
      }
      return { assignmentIds, launchingRunIds };
    });

    let cancelled = launchingRunIds.length;
    const errors: unknown[] = [];
    for (const assignmentId of assignmentIds) {
      try {
        if (await this.cancelRun(assignmentId)) cancelled += 1;
        else errors.push(new Error(`Could not cancel active assignment ${assignmentId}`));
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      const messages = errors.map((error) => error instanceof Error ? error.message : String(error));
      throw new AggregateError(errors, `Failed to cancel ${errors.length} active subagent run${errors.length === 1 ? "" : "s"}: ${messages.join("; ")}`);
    }
    return cancelled;
  }

  /**
   * Resolve one immutable terminal archive, then read only its authoritative
   * result file. A branch-local checkpoint reference wins over directory
   * discovery; multiple unreferenced branch variants require an archive ID.
   */
  async getRunResult(assignmentId: string, requestedArchiveId?: string): Promise<string | undefined> {
    const sessionId = this.checkpointContext().sessionId;
    if (!sessionId) return "Result is unavailable: no active session.";
    const selected = this.archiveRefs.filter((ref) => ref.assignmentId === assignmentId);
    let archiveId = requestedArchiveId;
    if (!archiveId && selected.length === 1) archiveId = selected[0].archiveId;

    let archive: AssignmentArchiveV1 | undefined;
    if (archiveId) {
      // An explicit archive ID must be branch-selected or linked in this
      // session's hashed assignment directory; a global object digest alone
      // is not a cross-session capability.
      if (!selected.some((ref) => ref.archiveId === archiveId)) {
        const linked = await this.objectStore.listAssignmentArchives<AssignmentArchiveV1>(sessionId, assignmentId);
        if (!linked.some((match) => match.archiveId === archiveId)) {
          return "Result is unavailable: archive ID is not linked to this assignment.";
        }
      }
      try {
        archive = await this.objectStore.get<AssignmentArchiveV1>(archiveId, "assignment", 256 * 1024);
      } catch {
        return "Result is unavailable: the immutable assignment archive could not be read.";
      }
      if (archive.assignmentId !== assignmentId) return "Result is unavailable: archive ID does not match the assignment.";
    } else {
      const matches = await this.objectStore.listAssignmentArchives<AssignmentArchiveV1>(sessionId, assignmentId);
      if (matches.length === 0) return undefined;
      if (matches.length > 1) {
        return [
          `Ambiguous result for ${assignmentId}; specify an archive ID.`,
          ...matches.map((match) => `  ${match.archiveId} · ${match.archive.runId}`),
        ].join("\n");
      }
      archive = matches[0].archive;
    }

    if (!archive.resultId) {
      return archive.resultUnavailableReason === "missing-legacy-result"
        ? "Result is unavailable: the legacy result file is missing."
        : "Result is unavailable: this assignment has no durable result identity.";
    }
    try {
      return await readFile(resultFilePath(sessionStoragePaths(this.dataRoot, sessionId), archive.resultId), "utf8");
    } catch {
      return "Result is unavailable: the durable result file is missing.";
    }
  }

  async clear(scope: "completed" | "all" = "completed", targetId?: string): Promise<number> {
    const checkpointContext = this.checkpointContext();
    const normalizedTargetId = normalizeTargetId(targetId);
    const clearEverything = scope === "all" && !normalizedTargetId;
    if (clearEverything) {
      const started = await this.lock.withLock(() => {
        if (this.clearAllInProgress) return false;
        this.clearAllInProgress = true;
        return true;
      });
      if (!started) return 0;

      try {
        await this.cancelActiveRuns();
        return await this.lock.withLock(async () => {
          const removed = this.state.taskRuns.length;
          this.stateEpoch += 1;
          this.state = createEmptyState();
          this.archiveRefs = [];
          this.runProgressSignatures.clear();
          this.liveRunIds.clear();
          this.signalSuppressionCounts.clear();
          this.attentionActionedTaskRunIds.clear();
          this.scheduledDispatches.clear();
          this.lastDispatchWork = Promise.resolve();
          this.clearAllInProgress = false;
          await this.checkpointState({ ...checkpointContext, archiveRefs: [] });
          this.updateUI(this.lastContext);
          return removed;
        });
      } catch (error) {
        await this.lock.withLock(() => {
          this.clearAllInProgress = false;
        });
        throw error;
      }
    }

    return this.lock.withLock(async () => {
      const before = this.state.taskRuns.length + (this.state.completedHistory?.length ?? 0);
      if (normalizedTargetId) {
        const taskRunId = this.resolveTaskRunIdForTarget(normalizedTargetId) ?? this.resolveCompletedHistoryTaskRunId(normalizedTargetId);
        const target = taskRunId ? this.state.taskRuns.find((taskRun) => taskRun.id === taskRunId) : undefined;
        const active = target?.assignments.some((assignment) => assignment.status === "queued" || assignment.status === "running");
        // A target resolving to active state is protected, including any
        // colliding completed-history identifier. Otherwise remove the
        // matching live terminal run and/or compact completed summary.
        if (!active && taskRunId) {
          this.state.taskRuns = this.state.taskRuns.filter((taskRun) => taskRun.id !== taskRunId);
          this.state.completedHistory = this.state.completedHistory?.filter((summary) => summary.taskRunId !== taskRunId);
          this.archiveRefs = this.archiveRefs.filter((ref) => ref.taskRunId !== taskRunId);
        }
      } else {
        const removedTaskRunIds = new Set(this.state.taskRuns
          .filter((taskRun) => taskRun.status === "completed" || taskRun.status === "cancelled")
          .map((taskRun) => taskRun.id));
        for (const summary of this.state.completedHistory ?? []) removedTaskRunIds.add(summary.taskRunId);
        this.state.taskRuns = this.state.taskRuns.filter((taskRun) => !removedTaskRunIds.has(taskRun.id));
        this.state.completedHistory = [];
        this.archiveRefs = this.archiveRefs.filter((ref) => !removedTaskRunIds.has(ref.taskRunId));
      }

      if (this.state.currentTaskRunId && !this.state.taskRuns.some((taskRun) => taskRun.id === this.state.currentTaskRunId)) {
        this.state.currentTaskRunId = this.state.taskRuns.at(-1)?.id;
      }
      this.state.updatedAt = Date.now();
      const removed = before - this.state.taskRuns.length - (this.state.completedHistory?.length ?? 0);
      await this.checkpointState({ ...checkpointContext, archiveRefs: structuredClone(this.archiveRefs) });
      this.updateUI(this.lastContext);
      return removed;
    });
  }

  /** Reject a candidate before exposing any structural mutation in memory. */
  private preflightCheckpoint(candidate: TaskedSubagentsState): string | undefined {
    const projection = buildCheckpointProjection(candidate, []);
    return projection.ok ? undefined : projection.error.message;
  }

  /** Persist a bounded v5 pointer. Callers must await this at durable boundaries. */
  private async checkpointState(context: CheckpointContext): Promise<void> {
    if (!context.sessionId) throw new PersistenceError("Checkpoint context has no active session");
    const result = await this.persistence.checkpoint(cloneState(this.state), context);
    if (!result.committed) throw new PersistenceError(result.error.message);
  }

  /** Keep wait-mode suppression only after its structural checkpoint succeeds. */
  private async checkpointWithOptionalSignalSuppression(
    context: CheckpointContext,
    taskRunId: string,
    suppressSignal?: boolean,
  ): Promise<void> {
    if (suppressSignal) this.suppressTaskRunSignal(taskRunId);
    let checkpointed = false;
    try {
      await this.checkpointState(context);
      checkpointed = true;
    } finally {
      if (suppressSignal && !checkpointed) this.releaseTaskRunSignal(taskRunId);
    }
  }

  async flushPersistence(ctx?: ExtensionContext): Promise<void> {
    if (ctx) this.lastContext = ctx;
    const context = this.checkpointContext(ctx);
    if (!context.sessionId) throw new PersistenceError("Checkpoint context has no active session");
    await this.persistence.flush(context);
  }

  private checkpointContext(ctx?: ExtensionContext): CheckpointContext {
    // Background controls and shutdown commonly have no per-call context.
    // Keep their checkpoints tied to the last live Pi session rather than
    // silently placing them in the package fallback session.
    const liveContext = ctx ?? this.lastContext;
    const sessionManager = liveContext?.sessionManager;
    // A controller used without any extension context retains its isolated
    // package fallback for non-interactive callers. Once a context is known,
    // however, a missing session must fail closed at the coordinator boundary.
    const sessionId = sessionManager?.getSessionId() ?? (liveContext ? "" : PACKAGE_NAME);
    const entries = sessionManager?.getEntries() ?? [];
    const visiblePointers: StatePointerV5[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const candidate = entry as { customType?: unknown; data?: unknown };
      if (candidate.customType !== ENTRY_TYPE_STATE || !this.isStatePointer(candidate.data)) continue;
      visiblePointers.push(structuredClone(candidate.data));
    }
    return {
      sessionId,
      visiblePointers,
      ...(this.archiveRefs.length > 0 ? { archiveRefs: structuredClone(this.archiveRefs) } : {}),
    };
  }

  private isStatePointer(value: unknown): value is StatePointerV5 {
    if (typeof value !== "object" || value === null) return false;
    const pointer = value as Partial<StatePointerV5>;
    return pointer.version === 5 && typeof pointer.checkpointId === "string" && /^[a-f0-9]{64}$/u.test(pointer.checkpointId) &&
      Number.isSafeInteger(pointer.sequence) && typeof pointer.writtenAt === "number";
  }

  updateUI(ctx: ExtensionContext | undefined): void {
    if (ctx) this.lastContext = ctx;
    const uiCtx = ctx ?? this.lastContext;
    if (!uiCtx) return;
    try {
      const statusText = buildFooterStatus(this.state, uiCtx.ui.theme);
      uiCtx.ui.setStatus(COMMAND_NAME, statusText);
      const widgetLines = buildWidgetLines(this.state, DEFAULT_WIDGET_LINES, uiCtx.ui.theme);
      if (widgetLines.length === 0) {
        uiCtx.ui.setWidget(COMMAND_NAME, undefined, { placement: "aboveEditor" });
      } else if (uiCtx.mode === "tui") {
        const widgetContent = createWidgetContent(this.state, DEFAULT_WIDGET_LINES);
        if (widgetContent) uiCtx.ui.setWidget(COMMAND_NAME, widgetContent, { placement: "aboveEditor" });
        else uiCtx.ui.setWidget(COMMAND_NAME, undefined, { placement: "aboveEditor" });
      } else {
        uiCtx.ui.setWidget(COMMAND_NAME, widgetLines, { placement: "aboveEditor" });
      }
      (uiCtx.ui as typeof uiCtx.ui & { requestRender?: () => void }).requestRender?.();
    } catch (error) {
      console.error(`[${PACKAGE_NAME}] failed to update UI:`, error);
    }
  }

  private nextDispatchRunId(taskRunId: string): string {
    this.dispatchRunCounter += 1;
    return `${taskRunId}-${Date.now()}-${this.dispatchRunCounter}`;
  }

  private nextTaskRunId(): string {
    let counter = this.taskRunCounter;
    let candidate: string;
    do {
      counter += 1;
      candidate = `task-run-${counter}`;
    } while (this.state.taskRuns.some((taskRun) => taskRun.id === candidate));
    return candidate;
  }

  private async patchTaskRunMutable(input: PatchTaskRunInput, ctx: ExtensionContext | undefined, checkpointContext: CheckpointContext): Promise<PatchTaskRunResult> {
    if (this.clearAllInProgress) return { patched: false, errors: ["Clear all is in progress"], dispatchScheduled: false };
    const taskRun = this.resolveTaskRunMutable(input.taskRunId);
    if (!taskRun) return { patched: false, errors: [input.taskRunId ? `TaskRun ${input.taskRunId} not found` : "No current TaskRun"], dispatchScheduled: false };
    const timestamp = Date.now();
    const candidate = cloneState(this.state);
    const candidateTaskRun = candidate.taskRuns.find((item) => item.id === taskRun.id);
    if (!candidateTaskRun) return { patched: false, taskRunId: taskRun.id, errors: ["TaskRun disappeared before patching"], dispatchScheduled: false };
    const result = applyTaskRunPatchMutable(candidateTaskRun, input, timestamp);
    if (!result.patched) return { patched: false, taskRunId: taskRun.id, errors: result.errors, dispatchScheduled: false };
    candidate.currentTaskRunId = taskRun.id;
    const projectionError = this.preflightCheckpoint(candidate);
    if (projectionError) return { patched: false, taskRunId: taskRun.id, errors: [projectionError], dispatchScheduled: false };
    // The validated candidate is the exact state transition to install.
    this.state = candidate;
    await this.checkpointWithOptionalSignalSuppression(checkpointContext, taskRun.id, input.wait && result.dispatchScheduled);
    this.updateUI(ctx ?? this.lastContext);
    return { patched: true, taskRunId: taskRun.id, errors: [], dispatchScheduled: result.dispatchScheduled };
  }

  private async editTaskMutable(input: EditTaskInput, ctx: ExtensionContext | undefined, checkpointContext: CheckpointContext): Promise<EditTaskResult> {
    if (this.clearAllInProgress) return { edited: false, errors: ["Clear all is in progress"], dispatchScheduled: false };
    const taskRun = this.resolveTaskRunMutable(input.taskRunId);
    if (!taskRun) return { edited: false, errors: [input.taskRunId ? `TaskRun ${input.taskRunId} not found` : "No current TaskRun"], dispatchScheduled: false };
    const requestedTargetId = normalizeTargetId(input.targetId);
    if (!requestedTargetId) return { edited: false, taskRunId: taskRun.id, errors: ["Task targetId is required"], dispatchScheduled: false };
    const assignmentTarget = taskRun.assignments.find((assignment) => assignment.id === requestedTargetId);
    const targetId = assignmentTarget?.taskId ?? requestedTargetId;
    const taskIndex = taskRun.tasks.findIndex((candidate) => candidate.id === targetId);
    if (taskIndex < 0) return { edited: false, taskRunId: taskRun.id, errors: [`Task ${requestedTargetId} not found`], dispatchScheduled: false };

    const candidate = taskRunToInput(taskRun);
    candidate.tasks[taskIndex] = { ...candidate.tasks[taskIndex], ...input.task, id: candidate.tasks[taskIndex].id };
    const validationErrors = validateTaskRunInput(candidate);
    if (validationErrors.length > 0) return { edited: false, taskRunId: taskRun.id, taskId: targetId, errors: validationErrors, dispatchScheduled: false };

    const timestamp = Date.now();
    const normalized = normalizeTaskRunInput(candidate, { taskRunId: taskRun.id, now: timestamp });
    if (!normalized.taskRun) return { edited: false, taskRunId: taskRun.id, taskId: targetId, errors: normalized.errors, dispatchScheduled: false };

    const candidateState = cloneState(this.state);
    const candidateTaskRun = candidateState.taskRuns.find((item) => item.id === taskRun.id)!;
    const candidateOldTask = candidateTaskRun.tasks[taskIndex];
    const candidateNextTask = structuredClone(normalized.taskRun.tasks[taskIndex]);
    candidateNextTask.status = "ready";
    candidateNextTask.assignmentIds = [];
    candidateNextTask.completedAt = undefined;
    candidateNextTask.createdAt = candidateOldTask.createdAt;
    candidateNextTask.updatedAt = timestamp;
    candidateTaskRun.tasks[taskIndex] = candidateNextTask;
    const candidateAssignmentIds = new Set(candidateOldTask.assignmentIds);
    candidateTaskRun.assignments = candidateTaskRun.assignments.filter((assignment) => assignment.taskId !== candidateOldTask.id && !candidateAssignmentIds.has(assignment.id));
    candidateTaskRun.artifacts = candidateTaskRun.artifacts.filter((artifact) => artifact.taskId !== candidateOldTask.id && !candidateAssignmentIds.has(artifact.assignmentId));
    const candidateGroup = candidateNextTask.groupId ? candidateTaskRun.groups.find((item) => item.id === candidateNextTask.groupId) : undefined;
    if (candidateGroup) {
      candidateGroup.status = "ready";
      candidateGroup.completedAt = undefined;
      candidateGroup.updatedAt = timestamp;
    }
    candidateTaskRun.status = "running";
    candidateTaskRun.completedAt = undefined;
    candidateTaskRun.updatedAt = timestamp;
    deriveTaskRunStatus(candidateTaskRun, timestamp);
    candidateState.currentTaskRunId = candidateTaskRun.id;
    const projectionError = this.preflightCheckpoint(candidateState);
    if (projectionError) return { edited: false, taskRunId: taskRun.id, taskId: targetId, errors: [projectionError], dispatchScheduled: false };

    this.stateEpoch += 1;
    const oldTask = taskRun.tasks[taskIndex];
    const nextTask = normalized.taskRun.tasks[taskIndex];
    nextTask.status = "ready";
    nextTask.assignmentIds = [];
    nextTask.completedAt = undefined;
    nextTask.createdAt = oldTask.createdAt;
    nextTask.updatedAt = timestamp;
    taskRun.tasks[taskIndex] = nextTask;
    const assignmentIds = new Set(oldTask.assignmentIds);
    taskRun.assignments = taskRun.assignments.filter((assignment) => assignment.taskId !== oldTask.id && !assignmentIds.has(assignment.id));
    taskRun.artifacts = taskRun.artifacts.filter((artifact) => artifact.taskId !== oldTask.id && !assignmentIds.has(artifact.assignmentId));
    const group = nextTask.groupId ? taskRun.groups.find((candidateGroup) => candidateGroup.id === nextTask.groupId) : undefined;
    if (group) {
      group.status = "ready";
      group.completedAt = undefined;
      group.updatedAt = timestamp;
    }
    taskRun.status = "running";
    taskRun.completedAt = undefined;
    taskRun.updatedAt = timestamp;
    deriveTaskRunStatus(taskRun, timestamp);
    this.state.currentTaskRunId = taskRun.id;
    await this.checkpointWithOptionalSignalSuppression(checkpointContext, taskRun.id, input.wait);
    this.updateUI(ctx ?? this.lastContext);
    return { edited: true, taskRunId: taskRun.id, taskId: nextTask.id, errors: [], dispatchScheduled: true };
  }

  private async editGroupMutable(input: EditGroupInput, ctx: ExtensionContext | undefined, checkpointContext: CheckpointContext): Promise<EditGroupResult> {
    if (this.clearAllInProgress) return { edited: false, errors: ["Clear all is in progress"], dispatchScheduled: false };
    const taskRun = this.resolveTaskRunMutable(input.taskRunId);
    if (!taskRun) return { edited: false, errors: [input.taskRunId ? `TaskRun ${input.taskRunId} not found` : "No current TaskRun"], dispatchScheduled: false };
    const targetId = normalizeTargetId(input.targetId);
    if (!targetId) return { edited: false, taskRunId: taskRun.id, errors: ["Group targetId is required"], dispatchScheduled: false };
    const groupIndex = taskRun.groups.findIndex((candidate) => candidate.id === targetId);
    if (groupIndex < 0) return { edited: false, taskRunId: taskRun.id, errors: [`Group ${targetId} not found`], dispatchScheduled: false };

    const candidate = taskRunToInput(taskRun);
    candidate.groups ??= [];
    candidate.groups[groupIndex] = { ...candidate.groups[groupIndex], ...input.group, id: candidate.groups[groupIndex].id };
    const validationErrors = validateTaskRunInput(candidate);
    if (validationErrors.length > 0) return { edited: false, taskRunId: taskRun.id, groupId: targetId, errors: validationErrors, dispatchScheduled: false };

    const timestamp = Date.now();
    const normalized = normalizeTaskRunInput(candidate, { taskRunId: taskRun.id, now: timestamp });
    if (!normalized.taskRun) return { edited: false, taskRunId: taskRun.id, groupId: targetId, errors: normalized.errors, dispatchScheduled: false };

    const candidateState = cloneState(this.state);
    const candidateTaskRun = candidateState.taskRuns.find((item) => item.id === taskRun.id)!;
    const candidateOldGroup = candidateTaskRun.groups[groupIndex];
    const candidateNextGroup = structuredClone(normalized.taskRun.groups[groupIndex]);
    candidateNextGroup.status = "ready";
    candidateNextGroup.completedAt = undefined;
    candidateNextGroup.createdAt = candidateOldGroup.createdAt;
    candidateNextGroup.updatedAt = timestamp;
    candidateTaskRun.groups[groupIndex] = candidateNextGroup;
    candidateTaskRun.status = "running";
    candidateTaskRun.completedAt = undefined;
    candidateTaskRun.updatedAt = timestamp;
    deriveTaskRunStatus(candidateTaskRun, timestamp);
    candidateState.currentTaskRunId = candidateTaskRun.id;
    const projectionError = this.preflightCheckpoint(candidateState);
    if (projectionError) return { edited: false, taskRunId: taskRun.id, groupId: targetId, errors: [projectionError], dispatchScheduled: false };

    this.stateEpoch += 1;
    const oldGroup = taskRun.groups[groupIndex];
    const nextGroup = normalized.taskRun.groups[groupIndex];
    nextGroup.status = "ready";
    nextGroup.completedAt = undefined;
    nextGroup.createdAt = oldGroup.createdAt;
    nextGroup.updatedAt = timestamp;
    taskRun.groups[groupIndex] = nextGroup;
    taskRun.status = "running";
    taskRun.completedAt = undefined;
    taskRun.updatedAt = timestamp;
    deriveTaskRunStatus(taskRun, timestamp);
    this.state.currentTaskRunId = taskRun.id;
    await this.checkpointWithOptionalSignalSuppression(checkpointContext, taskRun.id, input.wait);
    this.updateUI(ctx ?? this.lastContext);
    return { edited: true, taskRunId: taskRun.id, groupId: nextGroup.id, errors: [], dispatchScheduled: true };
  }

  private tasksForTarget(target: MutableTarget, options: { directTargetsMustBeRecoverable: boolean }): TaskRecord[] {
    const directTasks = target.kind === "task" || target.kind === "assignment"
      ? [target.task]
      : target.kind === "group"
        ? target.taskRun.tasks.filter((task) => task.groupId === target.group.id)
        : target.taskRun.tasks;

    if (target.kind === "task" || target.kind === "assignment") {
      return options.directTargetsMustBeRecoverable
        ? directTasks.filter((task) => recoverableTaskStatus(task.status))
        : directTasks;
    }

    return directTasks.filter((task) => recoverableTaskStatus(task.status));
  }

  private readyTargetForDispatch(
    targetId: string,
    continuationForTask: (taskRun: TaskRunRecord, task: TaskRecord) => string,
    options: { ctx?: ExtensionContext; directTargetsMustBeRecoverable: boolean; markAttentionActioned?: boolean },
  ): Promise<string | undefined> {
    const ctx = options.ctx;
    if (ctx) this.lastContext = ctx;
    const checkpointContext = this.checkpointContext(ctx);
    return this.lock.withLock(async () => {
      if (this.clearAllInProgress) return undefined;
      const target = this.resolveTargetMutable(targetId);
      if (!target) return undefined;
      const tasks = this.tasksForTarget(target, { directTargetsMustBeRecoverable: options.directTargetsMustBeRecoverable });
      if (tasks.length === 0) return undefined;
      const timestamp = Date.now();
      const taskIds = new Set(tasks.map((task) => task.id));
      const continuations = new Map(tasks.map((task) => [task.id, continuationForTask(target.taskRun, task).trim()]));
      const candidateState = cloneState(this.state);
      const candidateTaskRun = candidateState.taskRuns.find((item) => item.id === target.taskRun.id)!;
      for (const task of candidateTaskRun.tasks) {
        if (!taskIds.has(task.id)) continue;
        task.status = "ready";
        task.continuation = continuations.get(task.id) ?? "";
        task.completedAt = undefined;
        task.updatedAt = timestamp;
      }
      for (const group of candidateTaskRun.groups) {
        if (!candidateTaskRun.tasks.some((task) => task.groupId === group.id && taskIds.has(task.id))) continue;
        group.status = "ready";
        group.completedAt = undefined;
        group.updatedAt = timestamp;
      }
      candidateTaskRun.status = "running";
      candidateTaskRun.completedAt = undefined;
      candidateTaskRun.updatedAt = timestamp;
      deriveTaskRunStatus(candidateTaskRun, timestamp);
      candidateState.currentTaskRunId = candidateTaskRun.id;
      if (this.preflightCheckpoint(candidateState)) return undefined;

      for (const task of tasks) {
        task.status = "ready";
        task.continuation = continuations.get(task.id) ?? "";
        task.completedAt = undefined;
        task.updatedAt = timestamp;
      }
      for (const group of target.taskRun.groups) {
        if (target.taskRun.tasks.some((task) => task.groupId === group.id && taskIds.has(task.id))) {
          group.status = "ready";
          group.completedAt = undefined;
          group.updatedAt = timestamp;
        }
      }
      target.taskRun.status = "running";
      target.taskRun.completedAt = undefined;
      target.taskRun.updatedAt = timestamp;
      deriveTaskRunStatus(target.taskRun, timestamp);
      this.state.currentTaskRunId = target.taskRun.id;
      await this.checkpointState(checkpointContext);
      if (options.markAttentionActioned) this.attentionActionedTaskRunIds.add(target.taskRun.id);
      this.updateUI(ctx ?? this.lastContext);
      return target.taskRun.id;
    });
  }

  private ackAffectedTasks(target: MutableTarget): TaskRecord[] {
    switch (target.kind) {
      case "taskRun": return target.taskRun.tasks;
      case "group": return target.taskRun.tasks.filter((task) => task.groupId === target.group.id);
      case "task":
      case "assignment": return [target.task];
    }
  }

  private applyAckCascade(taskRun: TaskRunRecord, affectedTaskIds: ReadonlySet<string>, reason: string, timestamp: number): void {
    for (const assignment of taskRun.assignments) {
      if (isSupersededAssignment(assignment) || !affectedTaskIds.has(assignment.taskId)) continue;
      if (ackEligibleStatus(assignment.status)) {
        assignment.status = "completed";
        assignment.resolvedExternally = { reason, at: timestamp };
        assignment.completedAt = timestamp;
        assignment.updatedAt = timestamp;
      } else if (assignment.status === "queued") {
        // Launched but never produced a result; do not claim work that did not run.
        assignment.status = "skipped";
        assignment.completedAt = timestamp;
        assignment.updatedAt = timestamp;
      }
    }
    for (const task of taskRun.tasks) {
      if (!affectedTaskIds.has(task.id)) continue;
      if (ackEligibleStatus(task.status)) {
        for (const criterion of task.criteria) criterion.satisfied = true;
        task.status = "completed";
        task.resolvedExternally = { reason, at: timestamp };
        task.completedAt = timestamp;
        task.updatedAt = timestamp;
      } else if (task.status === "pending" || task.status === "ready") {
        task.status = "cancelled";
        task.completedAt = timestamp;
        task.updatedAt = timestamp;
      }
    }
  }

  private async ackTargetMutable(targetId: string, reason: string, ctx: ExtensionContext | undefined, checkpointContext: CheckpointContext): Promise<AckResult> {
    if (this.clearAllInProgress) return { acked: false, error: "Clear all is in progress" };
    const normalized = normalizeTargetId(targetId);
    if (!normalized) return { acked: false, error: "ack requires a targetId" };
    const trimmedReason = reason.trim();
    if (!trimmedReason) return { acked: false, error: "ack requires a non-empty reason" };
    const target = this.resolveTargetMutable(normalized);
    if (!target) return { acked: false, error: `Ack target not found: ${normalized}` };

    const taskRun = target.taskRun;
    const affectedTaskIds = new Set(this.ackAffectedTasks(target).map((task) => task.id));
    const affectedAssignments = taskRun.assignments.filter((assignment) => affectedTaskIds.has(assignment.taskId) && !isSupersededAssignment(assignment));
    const affectedTasks = taskRun.tasks.filter((task) => affectedTaskIds.has(task.id));

    if (affectedAssignments.some((assignment) => assignment.status === "running")) {
      return { acked: false, taskRunId: taskRun.id, error: `Ack target ${normalized} has running assignments; stop or await them first.` };
    }
    const anyEligible = affectedTasks.some((task) => ackEligibleStatus(task.status)) || affectedAssignments.some((assignment) => ackEligibleStatus(assignment.status));
    if (!anyEligible) {
      return { acked: false, taskRunId: taskRun.id, error: `Ack target ${normalized} has nothing in attention, blocked, paused, or failed to acknowledge.` };
    }

    const timestamp = Date.now();
    const candidate = cloneState(this.state);
    const candidateTaskRun = candidate.taskRuns.find((item) => item.id === taskRun.id)!;
    this.applyAckCascade(candidateTaskRun, affectedTaskIds, trimmedReason, timestamp);
    deriveTaskRunStatus(candidateTaskRun, timestamp);
    candidate.currentTaskRunId = candidateTaskRun.id;
    candidate.updatedAt = timestamp;
    const projectionError = this.preflightCheckpoint(candidate);
    if (projectionError) return { acked: false, taskRunId: taskRun.id, error: projectionError };

    this.state = candidate;
    this.attentionActionedTaskRunIds.add(taskRun.id);
    await this.checkpointState(checkpointContext);
    this.updateUI(ctx ?? this.lastContext);
    return { acked: true, taskRunId: taskRun.id };
  }

  /** True once a run's terminal alert is stale: attention/failed with no active assignment. */
  private taskRunAwaitingAck(taskRun: TaskRunRecord): boolean {
    if (taskRun.status !== "attention" && taskRun.status !== "failed") return false;
    return !taskRun.assignments.some((assignment) => !isSupersededAssignment(assignment) && (assignment.status === "queued" || assignment.status === "running"));
  }

  /** Re-arm every run's end-of-turn reminder; a new user prompt starts a fresh segment. */
  async rearmAttentionReminders(): Promise<void> {
    await this.lock.withLock(() => {
      for (const taskRun of this.state.taskRuns) {
        if (taskRun.attentionNagTriggered) taskRun.attentionNagTriggered = undefined;
      }
      this.attentionActionedTaskRunIds.clear();
    });
  }

  async remindPendingAttention(ctx?: ExtensionContext): Promise<void> {
    if (ctx) this.lastContext = ctx;
    const checkpointContext = this.checkpointContext(ctx);
    const reminder = await this.lock.withLock(async () => {
      if (this.clearAllInProgress) return undefined;
      const pending = this.state.taskRuns.filter((taskRun) => this.taskRunAwaitingAck(taskRun) && !this.attentionActionedTaskRunIds.has(taskRun.id));
      this.attentionActionedTaskRunIds.clear();
      if (pending.length === 0) return undefined;
      const armed = pending.filter((taskRun) => taskRun.attentionNagTriggered !== true);
      if (armed.length === 0) return undefined;
      const timestamp = Date.now();
      for (const taskRun of armed) {
        taskRun.attentionNagTriggered = true;
        taskRun.updatedAt = timestamp;
      }
      this.state.updatedAt = timestamp;
      await this.checkpointState(checkpointContext);
      return armed.map((taskRun) => cloneState({ version: 4, taskRuns: [taskRun], currentTaskRunId: taskRun.id, updatedAt: taskRun.updatedAt }).taskRuns[0]);
    });
    if (reminder) this.emitAttentionReminder(reminder);
  }

  private emitAttentionReminder(taskRuns: TaskRunRecord[]): void {
    const targetIds: string[] = [];
    const lines = [`[tasked-subagents] attention reminder: ${taskRuns.length} task run${taskRuns.length === 1 ? "" : "s"} still need acknowledgement.`];
    for (const taskRun of taskRuns) {
      targetIds.push(taskRun.id);
      lines.push(`- ${taskRun.id} · ${taskRun.title} (${statusLabel(taskRun.status)})`);
      for (const task of taskRun.tasks) {
        if (task.status === "attention" || task.status === "failed" || task.status === "blocked") {
          lines.push(`    ${task.id} · ${statusLabel(task.status)} · ${shortTitle(task.text, 80)}`);
        }
      }
    }
    lines.push("Acknowledge each fixed finding with tasked_subagents ack targetId=<id> reason=<why>, or resolve targetId=<id> prompt=<fix> to re-verify.");
    try {
      this.pi.sendMessage({
        customType: ENTRY_TYPE_ATTENTION_REMINDER,
        content: lines.join("\n"),
        display: false,
        details: { taskRunIds: targetIds, kind: "attention-reminder" },
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch {
      // best effort reminder; state remains source of truth
    }
  }

  private suppressTaskRunSignal(taskRunId: string): void {
    this.signalSuppressionCounts.set(taskRunId, (this.signalSuppressionCounts.get(taskRunId) ?? 0) + 1);
  }

  private releaseTaskRunSignal(taskRunId: string): void {
    const count = this.signalSuppressionCounts.get(taskRunId) ?? 0;
    if (count <= 1) this.signalSuppressionCounts.delete(taskRunId);
    else this.signalSuppressionCounts.set(taskRunId, count - 1);
  }

  private taskRunSignalSuppressed(taskRunId: string): boolean {
    return (this.signalSuppressionCounts.get(taskRunId) ?? 0) > 0;
  }

  private scheduleDispatch(
    taskRunId: string,
    ctx?: ExtensionContext,
    options: { emitTerminalSignal?: boolean } = {},
  ): Promise<void> {
    const previous = this.scheduledDispatches.get(taskRunId);
    const work = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.dispatchReady({ taskRunId, ctx, emitTerminalSignal: options.emitTerminalSignal }))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(`[${PACKAGE_NAME}] dispatch failed:`, error);
      });
    this.lastDispatchWork = work;
    this.scheduledDispatches.set(taskRunId, work);
    void work.finally(() => {
      if (this.scheduledDispatches.get(taskRunId) === work) this.scheduledDispatches.delete(taskRunId);
    });
    return work;
  }

  private async rollbackUncommittedLaunch(taskRunId: string, assignments: TaskAssignmentRecord[], ctx: ExtensionContext | undefined, checkpointContext: CheckpointContext): Promise<void> {
    const staleAssignments = new Set(assignments);
    await this.lock.withLock(async () => {
      const taskRun = this.state.taskRuns.find((candidate) => candidate.id === taskRunId);
      if (!taskRun) return;
      const removable = taskRun.assignments.filter((assignment) => staleAssignments.has(assignment) && assignment.status === "queued" && !assignment.runId && !assignment.launchRef);
      if (removable.length === 0) return;
      const removableObjects = new Set(removable);
      const timestamp = Date.now();
      taskRun.assignments = taskRun.assignments.filter((assignment) => !removableObjects.has(assignment));
      for (const task of taskRun.tasks) {
        const before = task.assignmentIds.length;
        task.assignmentIds = task.assignmentIds.filter((assignmentId) => taskRun.assignments.some((assignment) => assignment.id === assignmentId && assignment.taskId === task.id));
        if (task.assignmentIds.length !== before) {
          task.completedAt = undefined;
          task.updatedAt = timestamp;
        }
      }
      deriveTaskRunStatus(taskRun, timestamp);
      await this.checkpointState(checkpointContext);
      this.updateUI(ctx ?? this.lastContext);
    });
  }

  private async applyRunProgressUpdate(taskRunId: string, snapshot: RunProgressSnapshot, expectedEpoch: number | undefined, ctx?: ExtensionContext): Promise<void> {
    const signature = progressSignature(snapshot);
    const key = `${taskRunId}:${snapshot.runId}`;
    const staleSignals = await this.lock.withLock(async () => {
      if (expectedEpoch !== undefined && this.stateEpoch !== expectedEpoch) return [];
      const taskRun = this.state.taskRuns.find((candidate) => candidate.id === taskRunId);
      if (!taskRun) return [];
      // Staleness runs on every poll tick, before the progress dedup, so a
      // worker that has gone silent (identical snapshots) is still caught.
      const signals = await this.evaluateStaleAssignments(taskRun, snapshot, ctx);
      // Progress is display-only. Terminal assignment state comes only from
      // controls or the authoritative terminal runner result. The dedup still
      // skips redundant repaint work for an unchanged snapshot.
      if (this.runProgressSignatures.get(key) !== signature && applyAssignmentProgress(taskRun, snapshot)) {
        for (const step of snapshot.steps) {
          if (step.status === "completed" && step.id) this.terminalProgressAssignmentIds.add(step.id);
        }
        this.runProgressSignatures.set(key, signature);
        this.updateUI(ctx ?? this.lastContext);
      }
      return signals;
    });
    for (const signal of staleSignals) this.emitStaleSignal(signal);
  }

  /**
   * Detect running assignments whose last recorded action has aged past the
   * warning/attention thresholds and, symmetrically, recover ones that resumed.
   * Runs under the caller's state lock; returns the signals to emit afterwards.
   */
  private async evaluateStaleAssignments(
    taskRun: TaskRunRecord,
    snapshot: RunProgressSnapshot,
    ctx: ExtensionContext | undefined,
  ): Promise<StaleAssignmentSignal[]> {
    const now = Date.now();
    const warnEntries: StaleAssignmentEntry[] = [];
    const escalateEntries: StaleAssignmentEntry[] = [];
    let changed = false;
    for (const assignment of taskRun.assignments) {
      if (isSupersededAssignment(assignment)) continue;
      if (assignment.runId !== snapshot.runId) continue;
      // Monitor running assignments, plus ones this heartbeat escalated to
      // attention so they can still be recovered once the worker resumes.
      const monitored = assignment.status === "running"
        || (assignment.status === "attention" && assignment.staleEscalatedAt !== undefined);
      if (!monitored) continue;
      // A tool is genuinely executing; long-running commands must never be flagged.
      if (assignment.currentTool) continue;
      const idleMs = now - (assignment.lastActionAt ?? assignment.updatedAt);

      if (idleMs < this.staleWarningMs) {
        if (assignment.staleWarnedAt === undefined && assignment.staleEscalatedAt === undefined) continue;
        const wasEscalated = assignment.staleEscalatedAt !== undefined;
        assignment.staleWarnedAt = undefined;
        assignment.staleEscalatedAt = undefined;
        // Un-escalate only the status this heartbeat itself raised to attention.
        if (wasEscalated && assignment.status === "attention") assignment.status = "running";
        assignment.updatedAt = now;
        changed = true;
        continue;
      }

      if (assignment.staleWarnedAt === undefined) {
        assignment.staleWarnedAt = now;
        assignment.updatedAt = now;
        changed = true;
        warnEntries.push(staleEntry(assignment, idleMs));
      }
      if (idleMs >= this.staleAttentionMs && assignment.staleEscalatedAt === undefined) {
        assignment.staleEscalatedAt = now;
        assignment.status = "attention";
        assignment.updatedAt = now;
        changed = true;
        escalateEntries.push(staleEntry(assignment, idleMs));
      }
    }

    if (!changed) return [];
    deriveTaskRunStatus(taskRun, now);
    await this.checkpointState(this.checkpointContext(ctx));
    this.updateUI(ctx ?? this.lastContext);
    const signals: StaleAssignmentSignal[] = [];
    if (warnEntries.length > 0) signals.push({ taskRunId: taskRun.id, kind: "stale-assignment", entries: warnEntries });
    if (escalateEntries.length > 0) signals.push({ taskRunId: taskRun.id, kind: "stale-escalation", entries: escalateEntries });
    return signals;
  }

  private emitStaleSignal(signal: StaleAssignmentSignal): void {
    const header = signal.kind === "stale-escalation"
      ? "[tasked-subagents] stale assignment escalated to attention"
      : "[tasked-subagents] stale assignment detected";
    const lines = [header];
    for (const entry of signal.entries) {
      lines.push(
        `assignment: ${entry.assignmentId} (${entry.agent})`,
        `idle: ${formatCompactDuration(entry.idleMs)}`,
        `last event: ${entry.lastActionSummary?.trim() || "none"}`,
        "active tool: none",
        `action required: continue waiting, resolve targetId=${entry.assignmentId} prompt=<fix>, or ack/cancel targetId=${entry.assignmentId}`,
      );
    }
    try {
      this.pi.sendMessage({
        customType: ENTRY_TYPE_STALE_ASSIGNMENT,
        content: lines.join("\n"),
        display: false,
        details: { taskRunId: signal.taskRunId, assignmentIds: signal.entries.map((entry) => entry.assignmentId), kind: signal.kind },
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch {
      // best effort heartbeat; state remains source of truth
    }
  }

  private async archiveTerminalAssignments(
    taskRun: TaskRunRecord,
    assignments: readonly TaskAssignmentRecord[],
    sessionId: string,
  ): Promise<void> {
    for (const assignment of assignments) {
      if (!finalAssignmentStatus(assignment.status)) continue;
      const result = assignment.result;
      const resultId = assignment.launchRef?.resultId;
      const archive = projectAssignmentArchive({
        assignmentId: assignment.id,
        taskRunId: taskRun.id,
        ...(assignment.groupId === undefined ? {} : { groupId: assignment.groupId }),
        taskId: assignment.taskId,
        status: assignment.status,
        summary: result?.summary ?? "",
        criteriaEvidence: result?.criteriaEvidence ?? [],
        artifacts: result?.artifacts ?? taskRun.artifacts.filter((artifact) => artifact.assignmentId === assignment.id),
        followUps: result?.followUps ?? [],
        runId: assignment.runId ?? "unknown",
        ...(resultId === undefined
          ? { resultUnavailableReason: "missing-legacy-result" as const }
          : { resultId }),
        completedAt: assignment.completedAt ?? assignment.updatedAt,
      });
      const archiveId = await this.objectStore.put("assignment", archive, 256 * 1024);
      await this.objectStore.linkAssignmentArchive(sessionId, assignment.id, archiveId);
      if (!this.archiveRefs.some((ref) => ref.archiveId === archiveId)) {
        this.archiveRefs.push({
          assignmentId: assignment.id,
          assignmentIdHash: sha256Hex(assignment.id),
          archiveId,
          ...(resultId === undefined ? {} : { resultId }),
          taskRunId: taskRun.id,
          completedAt: archive.completedAt,
        });
      }
    }
  }

  private async applyRunOutcome(
    taskRunId: string,
    runId: string,
    status: RunStatus,
    raw: string | undefined,
    expectedEpoch: number | undefined,
    ctx: ExtensionContext | undefined,
    checkpointContext: CheckpointContext,
    emitTerminalSignal = true,
  ): Promise<void> {
    let taskRunForSignal: TaskRunRecord | undefined;
    await this.lock.withLock(async () => {
      if (expectedEpoch !== undefined && this.stateEpoch !== expectedEpoch) return;
      const taskRun = this.state.taskRuns.find((candidate) => candidate.id === taskRunId);
      if (!taskRun) return;
      const assignments = taskRun.assignments.filter((assignment) => assignment.runId === runId);
      const timestamp = Date.now();

      const reports = parseReportsFromRaw(raw);
      const handledAssignmentIds = new Set<string>();
      for (const { assignmentId, report } of reports) {
        const expectedAssignmentId = assignmentId ?? report.assignmentId;
        const assignment = assignments.find((candidate) => candidate.id === expectedAssignmentId);
        if (!assignment) continue;
        handledAssignmentIds.add(assignment.id);
        const applied = applySubagentTaskReport(taskRun, report, {
          now: timestamp,
          rawResultPath: assignment.launchRef?.resultPath,
          expectedAssignmentId: assignment.id,
        });
        if (applied.applied && report.taskRunPatch) {
          const patchResult = applyTaskRunPatchMutable(taskRun, report.taskRunPatch, timestamp);
          if (!patchResult.patched) {
            const task = taskRun.tasks.find((candidate) => candidate.id === assignment.taskId);
            assignment.status = "attention";
            assignment.updatedAt = timestamp;
            assignment.completedAt = undefined;
            if (task) {
              task.status = "attention";
              task.updatedAt = timestamp;
              task.completedAt = undefined;
            }
            assignment.result!.followUps.push(...patchResult.errors);
          }
        }
      }

      for (const assignment of assignments) {
        if (handledAssignmentIds.has(assignment.id)) continue;
        const nextStatus = statusForUnhandledAssignment(assignment, status);
        if (!nextStatus) continue;
        assignment.status = nextStatus;
        assignment.updatedAt = timestamp;
        if (finalAssignmentStatus(nextStatus)) assignment.completedAt = timestamp;
        else assignment.completedAt = undefined;
      }
      deriveTaskRunStatus(taskRun, timestamp);
      for (const assignment of assignments) this.terminalProgressAssignmentIds.delete(assignment.id);

      // Archives are written and linked before the checkpoint can reference
      // them. This ordering leaves an orphan on a later checkpoint failure,
      // never a pointer to a missing terminal archive.
      await this.archiveTerminalAssignments(taskRun, assignments, checkpointContext.sessionId);
      taskRunForSignal = cloneState({ version: 4, taskRuns: [taskRun], currentTaskRunId: taskRun.id, updatedAt: taskRun.updatedAt }).taskRuns[0];
      await this.checkpointState({
        ...checkpointContext,
        ...(this.archiveRefs.length > 0 ? { archiveRefs: structuredClone(this.archiveRefs) } : {}),
      });
      this.updateUI(ctx ?? this.lastContext);
    });
    const taskRunIsTerminal = taskRunForSignal?.status !== "running" && taskRunForSignal?.status !== "pending";
    if (taskRunForSignal && taskRunIsTerminal && terminalStatus(status) && (expectedEpoch === undefined || this.stateEpoch === expectedEpoch)) {
      this.handleTerminalSignal(taskRunForSignal, runId, status, emitTerminalSignal);
    }
  }

  private handleTerminalSignal(
    taskRun: TaskRunRecord,
    runId: string,
    status: RunStatus,
    enabled: boolean,
    assignmentIds?: readonly string[],
  ): void {
    const suppressed = this.taskRunSignalSuppressed(taskRun.id);
    // A wait-mode token represents one terminal handling, even when signals
    // are disabled. This keeps suppression exact-once across background waves.
    if (suppressed) this.releaseTaskRunSignal(taskRun.id);
    if (enabled && !suppressed) this.emitRunSignal(taskRun, runId, status, assignmentIds);
  }

  private async markRunStatus(runId: string, status: RunStatus, checkpointContext: CheckpointContext): Promise<void> {
    await this.lock.withLock(async () => {
      for (const taskRun of this.state.taskRuns) {
        const assignments = taskRun.assignments.filter((assignment) => assignment.runId === runId);
        if (assignments.length === 0) continue;
        for (const assignment of assignments) {
          const nextStatus = controlStatusForAssignment(assignment.status, status);
          if (!nextStatus) continue;
          assignment.status = nextStatus;
          assignment.updatedAt = Date.now();
          if (terminalStatus(status)) assignment.completedAt = Date.now();
        }
        deriveTaskRunStatus(taskRun);
      }
      for (const taskRun of this.state.taskRuns) {
        const terminalAssignments = taskRun.assignments.filter((assignment) => assignment.runId === runId && finalAssignmentStatus(assignment.status));
        if (terminalAssignments.length > 0) {
          // Use the same archive-before-checkpoint ordering as runner outcomes.
          await this.archiveTerminalAssignments(taskRun, terminalAssignments, checkpointContext.sessionId);
        }
      }
      await this.checkpointState({
        ...checkpointContext,
        ...(this.archiveRefs.length > 0 ? { archiveRefs: structuredClone(this.archiveRefs) } : {}),
      });
      this.updateUI(this.lastContext);
    });
  }

  private emitRunSignal(taskRun: TaskRunRecord, runId: string, status: RunStatus, expectedAssignmentIds?: readonly string[]): void {
    const label = taskRun.status === "cancelled" || status === "cancelled"
      ? "cancelled"
      : taskRun.status === "failed" || status === "failed"
        ? "failed"
        : taskRun.status === "attention"
          ? "attention"
          : "completed";
    const customType = label === "completed" ? ENTRY_TYPE_COMPLETION : label === "attention" ? ENTRY_TYPE_ATTENTION : ENTRY_TYPE_FAILURE;
    const assignments = expectedAssignmentIds
      ? taskRun.assignments.filter((assignment) => expectedAssignmentIds.includes(assignment.id))
      : taskRun.assignments.filter((assignment) => assignment.runId === runId);
    const assignmentIds = assignments.map((assignment) => assignment.id);
    const assignmentLines = assignments.map((assignment) => {
      const summary = assignment.result?.summary.replace(/\s+/gu, " ").trim();
      return `- ${statusLabel(assignment.status)} ${assignment.id}${summary ? ` · ${summary}` : ""}`;
    });
    const detailsHint = assignmentIds.length === 1
      ? `Use tasked_subagents result ${assignmentIds[0]} for details.`
      : assignmentIds.length > 1
        ? "Use tasked_subagents result <assignmentId> for details."
        : undefined;
    try {
      this.pi.sendMessage({
        customType,
        content: [
          `[tasked-subagents] ${label}: ${taskRun.id} · ${taskRun.title}`,
          assignmentLines.length > 0 ? "assignments:" : undefined,
          ...assignmentLines,
          `taskRun: ${taskRun.status}`,
          detailsHint,
        ].filter(Boolean).join("\n"),
        display: false,
        details: { taskRunId: taskRun.id, assignmentIds, status: label, routedCompletion: true },
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch {
      // best effort follow-up; state/result files remain source of truth
    }
  }

  private runtimeContext(ctx?: ExtensionContext): RunnerRuntimeContext {
    return {
      pi: this.pi,
      cwd: ctx?.cwd ?? process.cwd(),
      sessionId: ctx?.sessionManager.getSessionId() ?? PACKAGE_NAME,
      currentModelProvider: ctx?.model?.provider,
    };
  }

  private resolveTaskRunMutable(taskRunId?: string): TaskRunRecord | undefined {
    const target = normalizeTargetId(taskRunId) ?? this.state.currentTaskRunId;
    if (target) return this.state.taskRuns.find((taskRun) => taskRun.id === target);
    return this.state.taskRuns.at(-1);
  }

  private resolveTaskRunIdForTarget(targetId?: string): string | undefined {
    if (!targetId) return this.resolveTaskRunMutable()?.id;
    for (const taskRun of this.taskRunsForTargetResolution()) {
      if (taskRun.id === targetId) return taskRun.id;
      if (taskRun.groups.some((group) => group.id === targetId)) return taskRun.id;
      if (taskRun.tasks.some((task) => task.id === targetId)) return taskRun.id;
      if (taskRun.assignments.some((assignment) => assignment.id === targetId)) return taskRun.id;
    }
    return undefined;
  }

  private resolveCompletedHistoryTaskRunId(targetId: string): string | undefined {
    for (const summary of this.state.completedHistory ?? []) {
      if (summary.taskRunId === targetId) return summary.taskRunId;
      if (summary.archives.some((archive) => archive.groupId === targetId || archive.taskId === targetId || archive.assignmentId === targetId)) {
        return summary.taskRunId;
      }
    }
    return undefined;
  }

  private resolveHandleForAssignment(assignmentId: string): SubagentRunHandle | undefined {
    for (const taskRun of this.state.taskRuns) {
      const assignment = taskRun.assignments.find((candidate) => candidate.id === assignmentId);
      if (!assignment) continue;
      const launchRef = assignment.launchRef;
      if (!launchRef?.runId || !launchRef.asyncId || !Array.isArray(launchRef.assignments) || launchRef.assignments.length === 0) return undefined;
      if (!assignment.runId || assignment.runId !== launchRef.runId) return undefined;
      const ownsAssignment = launchRef.assignments.some((entry) => entry.assignmentId === assignment.id && entry.runId === launchRef.runId);
      if (!ownsAssignment) return undefined;
      return launchRef;
    }
    return undefined;
  }

  private resolveControllableHandleForAssignment(
    assignmentId: string,
    action: "stop" | "cancel",
  ): { handle: SubagentRunHandle; live: boolean } | undefined {
    const normalizedAssignmentId = normalizeTargetId(assignmentId);
    if (!normalizedAssignmentId) return undefined;
    for (const taskRun of this.state.taskRuns) {
      const assignment = taskRun.assignments.find((candidate) => candidate.id === normalizedAssignmentId);
      if (!assignment) continue;
      const storedLiveStatus = assignment.status === "queued" || assignment.status === "running";
      const live = storedLiveStatus && assignment.runId !== undefined && this.liveRunIds.has(assignment.runId);
      const cancellable = storedLiveStatus || assignment.status === "attention" || assignment.status === "blocked";
      if (action === "stop" ? !live : !cancellable) continue;
      const handle = this.resolveHandleForAssignment(normalizedAssignmentId);
      return handle ? { handle, live } : undefined;
    }
    return undefined;
  }

  private findTask(taskRun: TaskRunRecord, taskId: string): { group?: TaskGroupRecord; task: TaskRecord } | undefined {
    const task = taskRun.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return undefined;
    const group = task.groupId ? taskRun.groups.find((candidate) => candidate.id === task.groupId) : undefined;
    return { group, task };
  }

  private taskRunsForTargetResolution(): TaskRunRecord[] {
    const current = this.state.currentTaskRunId ? this.state.taskRuns.find((taskRun) => taskRun.id === this.state.currentTaskRunId) : undefined;
    return current ? [current, ...this.state.taskRuns.filter((taskRun) => taskRun.id !== current.id)] : this.state.taskRuns;
  }

  private resolveTargetMutable(targetId: string): MutableTarget | undefined {
    for (const taskRun of this.taskRunsForTargetResolution()) {
      if (taskRun.id === targetId) return { kind: "taskRun", taskRun };
      const group = taskRun.groups.find((candidate) => candidate.id === targetId);
      if (group) return { kind: "group", taskRun, group };
      const task = this.findTask(taskRun, targetId);
      if (task) return { kind: "task", taskRun, group: task.group, task: task.task };
      const assignment = taskRun.assignments.find((candidate) => candidate.id === targetId);
      if (assignment) {
        const assignmentTask = this.findTask(taskRun, assignment.taskId);
        if (assignmentTask) return { kind: "assignment", taskRun, assignment, group: assignmentTask.group, task: assignmentTask.task };
      }
    }
    return undefined;
  }
}
