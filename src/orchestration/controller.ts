// ──────────────────────────────────────────────
// Task-run controller for pi-tasked-subagents
// ──────────────────────────────────────────────

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  COMMAND_NAME,
  DEFAULT_WIDGET_LINES,
  ENTRY_TYPE_ATTENTION,
  ENTRY_TYPE_COMPLETION,
  ENTRY_TYPE_FAILURE,
  ENTRY_TYPE_STATE,
  PACKAGE_NAME,
} from "../defaults.js";
import type {
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
  TaskInput,
  TaskRecord,
  TaskRunRecord,
  TaskedSubagentsState,
} from "../types.js";
import { PiRunnerAdapter } from "../launcher/pi-runner-adapter.js";
import type { RunnerRuntimeContext } from "../launcher/interface.js";
import { cloneState, createEmptyState, createStateLock, ensureState } from "../state/store.js";
import { normalizeTaskRunInput, validateTaskRunInput } from "../state/task-run-validation.js";
import { statusLabel } from "../ui/messages.js";
import { buildFooterStatus } from "../ui/status.js";
import { buildWidgetLines, createWidgetContent } from "../ui/widget.js";
import { shortTitle } from "../utils/text.js";
import {
  applyAssignmentProgress,
  createReadyAssignments,
  deriveTaskRunStatus,
  toLaunchTaskEntries,
} from "./task-scheduler.js";
import { applySubagentTaskReport, parseTaskReport } from "./task-result-reducer.js";
import { formatAttachReport } from "./commands.js";

export type { AttachResult, EditGroupInput, EditGroupResult, EditTaskInput, EditTaskResult, PatchTaskRunInput, PatchTaskRunResult, SetTasksInput, SetTasksResult } from "../types.js";

export interface DispatchOptions {
  maxConcurrency?: number;
  defaultAgent?: string;
  defaultCwd?: string;
  ctx?: ExtensionContext;
  taskRunId?: string;
}

export interface DispatchResult {
  launched: number;
  skipped: number;
  errors: string[];
  hasBlockingIssue: boolean;
}

export interface TaskedSubagentsControllerOptions {
  runtime?: SubagentRuntime<RunnerRuntimeContext>;
  launcher?: SubagentRuntime<RunnerRuntimeContext>;
  defaultAgent?: string;
}

const DEFAULT_OPTIONS = {
  runtime: new PiRunnerAdapter(),
  defaultAgent: "delegate",
} satisfies { runtime: SubagentRuntime<RunnerRuntimeContext>; defaultAgent: string };

function terminalStatus(status: RunStatus): boolean {
  return status !== "queued" && status !== "running";
}

function finalWaitStatus(status: RunStatus): RunStatus {
  return terminalStatus(status) ? status : "attention";
}

function completedStatus(status: RunStatus): boolean {
  return status === "completed" || status === "skipped";
}

function finalAssignmentStatus(status: TaskAssignmentRecord["status"]): boolean {
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

function normalizeTargetId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function maxTaskRunCounter(taskRuns: TaskRunRecord[]): number {
  return taskRuns.reduce((max, taskRun) => {
    const match = /^task-run-(\d+)$/u.exec(taskRun.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
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

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value?.trim()));
}

function resultForAssignment(raw: string | undefined, assignmentId: string): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      results?: Array<{
        stepId?: string | number;
        rawOutput?: string;
        output?: string;
        summary?: string;
        error?: string;
      }>;
    };
    if (Array.isArray(parsed.results)) {
      const child = parsed.results.find((entry) => String(entry.stepId) === assignmentId);
      return child ? firstNonEmpty(child.rawOutput, child.output, child.summary, child.error) : undefined;
    }
  } catch {
    // Non-JSON raw output is the single-assignment result.
  }
  return raw;
}

type MutableTarget =
  | { kind: "taskRun"; taskRun: TaskRunRecord }
  | { kind: "group"; taskRun: TaskRunRecord; group: TaskGroupRecord }
  | { kind: "task"; taskRun: TaskRunRecord; group?: TaskGroupRecord; task: TaskRecord }
  | { kind: "assignment"; taskRun: TaskRunRecord; assignment: TaskAssignmentRecord; group?: TaskGroupRecord; task: TaskRecord };

function recoverableTaskStatus(status: string): boolean {
  return status === "attention" || status === "failed" || status === "blocked" || status === "cancelled";
}

function taskToInput(task: TaskRecord): TaskInput {
  return {
    id: task.id,
    group: task.groupId,
    text: task.text,
    criteria: task.criteria.map((criterion) => criterion.text),
    dependsOn: task.dependsOn,
    agentHint: task.agentHint,
    filesHint: task.filesHint,
    cwd: task.cwd,
    retries: task.retries,
    outputMode: task.outputMode,
    outputSchema: task.outputSchema,
    when: task.when,
  };
}

function groupToInput(group: TaskGroupRecord): NonNullable<SetTasksInput["groups"]>[number] {
  return {
    id: group.id,
    title: group.title,
    dependsOn: group.dependsOn,
    maxConcurrency: group.maxConcurrency,
    agentHint: group.agentHint,
    filesHint: group.filesHint,
  };
}

function taskRunToInput(taskRun: TaskRunRecord): SetTasksInput {
  return {
    taskRunId: taskRun.id,
    title: taskRun.title,
    request: taskRun.request,
    context: taskRun.context,
    groups: taskRun.groups.map(groupToInput),
    tasks: taskRun.tasks.map(taskToInput),
    maxConcurrency: taskRun.maxConcurrency,
  };
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
  private taskRunCounter = 0;
  private lastContext: ExtensionContext | undefined;
  private lastDispatchWork: Promise<void> = Promise.resolve();
  private readonly scheduledDispatches = new Map<string, Promise<void>>();
  private readonly runProgressSignatures = new Map<string, string>();
  private readonly liveRunIds = new Set<string>();
  private stateEpoch = 0;
  private dispatchRunCounter = 0;

  constructor(pi: ExtensionAPI, options?: TaskedSubagentsControllerOptions) {
    this.pi = pi;
    this.runtime = options?.runtime ?? options?.launcher ?? DEFAULT_OPTIONS.runtime;
    this.defaultAgent = options?.defaultAgent ?? DEFAULT_OPTIONS.defaultAgent;
  }

  getState(): TaskedSubagentsState {
    return cloneState(this.state);
  }

  restoreState(state: TaskedSubagentsState): void {
    this.state = ensureState(state);
    this.taskRunCounter = Math.max(this.taskRunCounter, maxTaskRunCounter(this.state.taskRuns));
    this.runProgressSignatures.clear();
    this.liveRunIds.clear();
    this.scheduledDispatches.clear();
    this.lastDispatchWork = Promise.resolve();
    this.stateEpoch += 1;
    this.dispatchRunCounter = 0;
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
    const result = await this.lock.withLock(() => {
      const errors = validateTaskRunInput(input);
      if (errors.length > 0) return { accepted: false, errors, dispatchScheduled: false } satisfies SetTasksResult;

      const taskRunId = normalizeTargetId(input.taskRunId) ?? this.nextTaskRunId();
      const normalized = normalizeTaskRunInput(input, { taskRunId });
      if (!normalized.taskRun) return { accepted: false, errors: normalized.errors, dispatchScheduled: false } satisfies SetTasksResult;

      this.stateEpoch += 1;
      const existingIndex = this.state.taskRuns.findIndex((candidate) => candidate.id === normalized.taskRun!.id);
      if (existingIndex >= 0) this.state.taskRuns[existingIndex] = normalized.taskRun;
      else this.state.taskRuns.push(normalized.taskRun);
      this.taskRunCounter = Math.max(this.taskRunCounter, maxTaskRunCounter(this.state.taskRuns));
      this.state.currentTaskRunId = normalized.taskRun.id;
      this.state.updatedAt = normalized.taskRun.updatedAt;
      this.persistState();
      this.updateUI(ctx ?? this.lastContext);
      return { accepted: true, taskRunId: normalized.taskRun.id, errors: [], dispatchScheduled: true } satisfies SetTasksResult;
    });

    if (result.accepted && result.taskRunId) {
      const work = this.scheduleDispatch(result.taskRunId, ctx);
      if (input.wait) await work;
    }
    return result;
  }

  async editTask(input: EditTaskInput, ctx?: ExtensionContext): Promise<EditTaskResult> {
    if (ctx) this.lastContext = ctx;
    const result = await this.lock.withLock(() => this.editTaskMutable(input, ctx));
    if (result.edited && result.dispatchScheduled && result.taskRunId) {
      const work = this.scheduleDispatch(result.taskRunId, ctx);
      if (input.wait) await work;
    }
    return result;
  }

  async patchTaskRun(input: PatchTaskRunInput, ctx?: ExtensionContext): Promise<PatchTaskRunResult> {
    if (ctx) this.lastContext = ctx;
    const result = await this.lock.withLock(() => this.patchTaskRunMutable(input, ctx));
    if (result.patched && result.dispatchScheduled && result.taskRunId) {
      const work = this.scheduleDispatch(result.taskRunId, ctx);
      if (input.wait) await work;
    }
    return result;
  }

  async editGroup(input: EditGroupInput, ctx?: ExtensionContext): Promise<EditGroupResult> {
    if (ctx) this.lastContext = ctx;
    const result = await this.lock.withLock(() => this.editGroupMutable(input, ctx));
    if (result.edited && result.dispatchScheduled && result.taskRunId) {
      const work = this.scheduleDispatch(result.taskRunId, ctx);
      if (input.wait) await work;
    }
    return result;
  }

  async dispatchReady(options: DispatchOptions = {}): Promise<DispatchResult> {
    if (options.ctx) this.lastContext = options.ctx;
    const aggregate: DispatchResult = { launched: 0, skipped: 0, errors: [], hasBlockingIssue: false };
    const runtimeCtx = this.runtimeContext(options.ctx);
    const dispatchEpoch = this.stateEpoch;

    while (true) {
      const launch = await this.lock.withLock(() => {
        if (this.stateEpoch !== dispatchEpoch) return undefined;
        const taskRun = this.resolveTaskRunMutable(options.taskRunId);
        if (!taskRun) return undefined;
        const scheduled = createReadyAssignments(taskRun, {
          defaultAgent: options.defaultAgent ?? this.defaultAgent,
          defaultCwd: options.defaultCwd ?? runtimeCtx.cwd,
        });
        aggregate.hasBlockingIssue ||= scheduled.hasBlockingIssue;
        if (scheduled.assignments.length === 0) {
          deriveTaskRunStatus(taskRun);
          this.persistState();
          this.updateUI(options.ctx ?? this.lastContext);
          return undefined;
        }
        const runId = this.nextDispatchRunId(taskRun.id);
        return { taskRunId: taskRun.id, runId, title: taskRun.title, maxConcurrency: taskRun.maxConcurrency, assignments: scheduled.assignments };
      });

      if (!launch) return aggregate;

      let ref: SubagentRunHandle | undefined;
      try {
        const taskRun = this.state.taskRuns.find((candidate) => candidate.id === launch.taskRunId);
        if (!taskRun) return aggregate;
        const launchedRef = launchRefForAssignments(await this.runtime.launchTaskGraph({
          runId: launch.runId,
          title: `TaskRun ${taskRun.id}: ${taskRun.title}`,
          taskSummary: taskRun.title,
          tasks: toLaunchTaskEntries(launch.assignments, taskRun),
          maxConcurrency: options.maxConcurrency ?? launch.maxConcurrency,
          cwd: options.defaultCwd ?? runtimeCtx.cwd,
        }, runtimeCtx), launch.assignments);
        ref = launchedRef;
        this.liveRunIds.add(launchedRef.runId);
        if (this.stateEpoch !== dispatchEpoch) {
          await this.runtime.cancelRun(launchedRef, runtimeCtx).catch((cancelError: unknown) => {
            console.error(`[${PACKAGE_NAME}] failed to cancel stale dispatch:`, cancelError);
          });
          await this.rollbackUncommittedLaunch(launch.taskRunId, launch.assignments, options.ctx ?? this.lastContext);
          return aggregate;
        }

        await this.lock.withLock(() => {
          if (this.stateEpoch !== dispatchEpoch) return;
          const current = this.state.taskRuns.find((candidate) => candidate.id === launch.taskRunId);
          if (!current) return;
          for (const assignment of launch.assignments) {
            const stored = current.assignments.find((candidate) => candidate.id === assignment.id);
            if (!stored) continue;
            stored.status = "running";
            stored.runId = launchedRef.runId;
            stored.launchRef = launchedRef;
            stored.updatedAt = Date.now();
          }
          deriveTaskRunStatus(current);
          this.persistState();
          this.updateUI(options.ctx ?? this.lastContext);
        });
        aggregate.launched += launch.assignments.length;

        const status = finalWaitStatus(await this.runtime.waitForRunSignal(launchedRef, {
          ctx: runtimeCtx,
          onUpdate: (snapshot) => this.applyRunProgressUpdate(launch.taskRunId, snapshot, dispatchEpoch, options.ctx ?? this.lastContext),
        }));
        if (this.stateEpoch !== dispatchEpoch) return aggregate;
        const raw = await this.runtime.getRunResult(launchedRef);
        if (this.stateEpoch !== dispatchEpoch) return aggregate;
        await this.applyRunOutcome(launch.taskRunId, launchedRef.runId, status, raw, dispatchEpoch, options.ctx ?? this.lastContext);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        aggregate.errors.push(message);
        aggregate.hasBlockingIssue = true;
        if (this.stateEpoch !== dispatchEpoch) await this.rollbackUncommittedLaunch(launch.taskRunId, launch.assignments, options.ctx ?? this.lastContext);
        if (this.stateEpoch === dispatchEpoch) await this.lock.withLock(() => {
          if (this.stateEpoch !== dispatchEpoch) return;
          const taskRun = this.state.taskRuns.find((candidate) => candidate.id === launch.taskRunId);
          if (!taskRun) return;
          const timestamp = Date.now();
          for (const assignment of launch.assignments) {
            const stored = taskRun.assignments.find((candidate) => candidate.id === assignment.id);
            if (!stored) continue;
            if (ref && stored.runId !== ref.runId) continue;
            if (stored.status === "completed" && !stored.result) {
              stored.status = "attention";
              stored.updatedAt = timestamp;
              continue;
            }
            if (stored.status !== "queued" && stored.status !== "running") continue;
            stored.status = "failed";
            stored.updatedAt = timestamp;
            stored.completedAt = timestamp;
          }
          deriveTaskRunStatus(taskRun);
          this.persistState();
          this.updateUI(options.ctx ?? this.lastContext);
        });
      } finally {
        if (ref) this.liveRunIds.delete(ref.runId);
      }
      if (this.stateEpoch !== dispatchEpoch) return aggregate;
      const shouldContinue = this.state.taskRuns
        .find((candidate) => candidate.id === launch.taskRunId)
        ?.tasks.some((task) => task.status === "ready");
      if (!shouldContinue) return aggregate;
    }
  }

  async continueTarget(targetId: string, prompt: string, ctx?: ExtensionContext): Promise<boolean> {
    const result = await this.readyTargetForDispatch(targetId, (_taskRun, _task) => prompt.trim(), { ctx, directTargetsMustBeRecoverable: false });
    if (!result) return false;
    this.scheduleDispatch(result, ctx);
    return true;
  }

  async resolveTarget(targetId: string, prompt: string, ctx?: ExtensionContext): Promise<boolean> {
    const result = await this.readyTargetForDispatch(
      targetId,
      (taskRun, task) => buildResolutionPrompt(taskRun, task, prompt),
      { ctx, directTargetsMustBeRecoverable: true },
    );
    if (!result) return false;
    this.scheduleDispatch(result, ctx);
    return true;
  }

  async stopRun(assignmentId: string): Promise<boolean> {
    const target = this.resolveControllableHandleForAssignment(assignmentId, "stop");
    if (!target) return false;
    const ok = await this.runtime.stopRun(target.handle, this.runtimeContext(this.lastContext));
    if (!ok) return false;
    await this.markRunStatus(target.handle.runId, "paused");
    return true;
  }

  async cancelRun(assignmentId: string): Promise<boolean> {
    const target = this.resolveControllableHandleForAssignment(assignmentId, "cancel");
    if (!target) return false;
    if (!target.live) {
      await this.markRunStatus(target.handle.runId, "cancelled");
      return true;
    }
    const ok = await this.runtime.cancelRun(target.handle, this.runtimeContext(this.lastContext));
    if (!ok) return false;
    await this.markRunStatus(target.handle.runId, "cancelled");
    return true;
  }

  async getRunResult(assignmentId: string): Promise<string | undefined> {
    const handle = this.resolveHandleForAssignment(assignmentId);
    if (!handle) return undefined;
    const raw = await this.runtime.getRunResult(handle);
    return resultForAssignment(raw, assignmentId);
  }

  clear(scope: "completed" | "all" = "completed"): Promise<number> {
    return this.lock.withLock(() => {
      const before = this.state.taskRuns.length;
      if (scope === "all") this.state = createEmptyState();
      else {
        this.state.taskRuns = this.state.taskRuns.filter((taskRun) => taskRun.status !== "completed" && taskRun.status !== "cancelled");
        if (this.state.currentTaskRunId && !this.state.taskRuns.some((taskRun) => taskRun.id === this.state.currentTaskRunId)) {
          this.state.currentTaskRunId = this.state.taskRuns.at(-1)?.id;
        }
        this.state.updatedAt = Date.now();
      }
      const removed = before - this.state.taskRuns.length;
      if (scope === "all") {
        this.stateEpoch += 1;
        this.runProgressSignatures.clear();
        this.liveRunIds.clear();
        this.scheduledDispatches.clear();
        this.lastDispatchWork = Promise.resolve();
      }
      this.persistState();
      this.updateUI(this.lastContext);
      return removed;
    });
  }

  persistState(): void {
    try {
      this.pi.appendEntry(ENTRY_TYPE_STATE, cloneState(this.state));
    } catch (error) {
      console.error(`[${PACKAGE_NAME}] failed to persist state:`, error);
    }
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
    this.taskRunCounter = counter;
    return candidate;
  }

  private patchTaskRunMutable(input: PatchTaskRunInput, ctx?: ExtensionContext): PatchTaskRunResult {
    const taskRun = this.resolveTaskRunMutable(input.taskRunId);
    if (!taskRun) return { patched: false, errors: [input.taskRunId ? `TaskRun ${input.taskRunId} not found` : "No current TaskRun"], dispatchScheduled: false };
    if ((!input.groups || input.groups.length === 0) && (!input.tasks || input.tasks.length === 0)) {
      return { patched: false, taskRunId: taskRun.id, errors: ["Patch requires groups or tasks"], dispatchScheduled: false };
    }

    const errors: string[] = [];
    const existingTaskIds = new Set(taskRun.tasks.map((task) => task.id));
    const newTaskIds = new Set<string>();
    for (const [index, task] of (input.tasks ?? []).entries()) {
      const taskId = normalizeTargetId(task.id);
      if (!taskId) {
        errors.push(`Patch task ${index + 1} id is required`);
        continue;
      }
      if (existingTaskIds.has(taskId)) errors.push(`Task ${taskId} already exists; use edit_task to modify existing tasks`);
      if (newTaskIds.has(taskId)) errors.push(`Duplicate patch task id: ${taskId}`);
      newTaskIds.add(taskId);
    }
    if (errors.length > 0) return { patched: false, taskRunId: taskRun.id, errors, dispatchScheduled: false };

    const candidate = taskRunToInput(taskRun);
    candidate.groups ??= [];
    for (const groupPatch of input.groups ?? []) {
      const groupId = normalizeTargetId(groupPatch.id);
      const existingIndex = groupId ? candidate.groups.findIndex((group) => group.id === groupId) : -1;
      if (existingIndex >= 0) candidate.groups[existingIndex] = { ...candidate.groups[existingIndex], ...groupPatch, id: candidate.groups[existingIndex].id };
      else candidate.groups.push(groupPatch);
    }
    candidate.tasks.push(...(input.tasks ?? []));

    const validationErrors = validateTaskRunInput(candidate);
    if (validationErrors.length > 0) return { patched: false, taskRunId: taskRun.id, errors: validationErrors, dispatchScheduled: false };

    const timestamp = Date.now();
    const normalized = normalizeTaskRunInput(candidate, { taskRunId: taskRun.id, now: timestamp });
    if (!normalized.taskRun) return { patched: false, taskRunId: taskRun.id, errors: normalized.errors, dispatchScheduled: false };

    const normalizedGroupsById = new Map(normalized.taskRun.groups.map((group) => [group.id, group]));
    for (const normalizedGroup of normalized.taskRun.groups) {
      const existing = taskRun.groups.find((group) => group.id === normalizedGroup.id);
      if (existing) {
        existing.title = normalizedGroup.title;
        existing.dependsOn = normalizedGroup.dependsOn;
        existing.maxConcurrency = normalizedGroup.maxConcurrency;
        existing.agentHint = normalizedGroup.agentHint;
        existing.filesHint = normalizedGroup.filesHint;
        existing.updatedAt = timestamp;
      } else taskRun.groups.push(normalizedGroup);
    }
    taskRun.groups = taskRun.groups.filter((group) => normalizedGroupsById.has(group.id));

    for (const normalizedTask of normalized.taskRun.tasks) {
      if (!newTaskIds.has(normalizedTask.id)) continue;
      taskRun.tasks.push(normalizedTask);
    }

    if (newTaskIds.size > 0) {
      taskRun.status = "running";
      taskRun.completedAt = undefined;
    }
    taskRun.updatedAt = timestamp;
    deriveTaskRunStatus(taskRun, timestamp);
    this.persistState();
    this.updateUI(ctx ?? this.lastContext);
    return { patched: true, taskRunId: taskRun.id, errors: [], dispatchScheduled: newTaskIds.size > 0 };
  }

  private editTaskMutable(input: EditTaskInput, ctx?: ExtensionContext): EditTaskResult {
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
    this.persistState();
    this.updateUI(ctx ?? this.lastContext);
    return { edited: true, taskRunId: taskRun.id, taskId: nextTask.id, errors: [], dispatchScheduled: true };
  }

  private editGroupMutable(input: EditGroupInput, ctx?: ExtensionContext): EditGroupResult {
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
    this.persistState();
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
    options: { ctx?: ExtensionContext; directTargetsMustBeRecoverable: boolean },
  ): Promise<string | undefined> {
    const ctx = options.ctx;
    if (ctx) this.lastContext = ctx;
    return this.lock.withLock(() => {
      const target = this.resolveTargetMutable(targetId);
      if (!target) return undefined;
      const tasks = this.tasksForTarget(target, { directTargetsMustBeRecoverable: options.directTargetsMustBeRecoverable });
      if (tasks.length === 0) return undefined;
      const timestamp = Date.now();
      const taskIds = new Set(tasks.map((task) => task.id));
      for (const task of tasks) {
        task.status = "ready";
        task.continuation = continuationForTask(target.taskRun, task).trim();
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
      this.persistState();
      this.updateUI(ctx ?? this.lastContext);
      return target.taskRun.id;
    });
  }

  private scheduleDispatch(taskRunId: string, ctx?: ExtensionContext): Promise<void> {
    const previous = this.scheduledDispatches.get(taskRunId);
    const work = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.dispatchReady({ taskRunId, ctx }))
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

  private async rollbackUncommittedLaunch(taskRunId: string, assignments: TaskAssignmentRecord[], ctx?: ExtensionContext): Promise<void> {
    const staleAssignments = new Set(assignments);
    await this.lock.withLock(() => {
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
      this.persistState();
      this.updateUI(ctx ?? this.lastContext);
    });
  }

  private async applyRunProgressUpdate(taskRunId: string, snapshot: RunProgressSnapshot, expectedEpoch: number | undefined, ctx?: ExtensionContext): Promise<void> {
    const signature = progressSignature(snapshot);
    const key = `${taskRunId}:${snapshot.runId}`;
    if (this.runProgressSignatures.get(key) === signature) return;
    await this.lock.withLock(() => {
      if (expectedEpoch !== undefined && this.stateEpoch !== expectedEpoch) return;
      const taskRun = this.state.taskRuns.find((candidate) => candidate.id === taskRunId);
      if (!taskRun) return;
      if (!applyAssignmentProgress(taskRun, snapshot)) return;
      this.runProgressSignatures.set(key, signature);
      this.persistState();
      this.updateUI(ctx ?? this.lastContext);
    });
  }

  private async applyRunOutcome(taskRunId: string, runId: string, status: RunStatus, raw: string | undefined, expectedEpoch: number | undefined, ctx?: ExtensionContext): Promise<void> {
    let taskRunForSignal: TaskRunRecord | undefined;
    await this.lock.withLock(() => {
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
        applySubagentTaskReport(taskRun, report, {
          now: timestamp,
          rawResultPath: assignment.launchRef?.resultPath,
          expectedAssignmentId: assignment.id,
        });
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

      taskRunForSignal = cloneState({ version: 4, taskRuns: [taskRun], currentTaskRunId: taskRun.id, updatedAt: taskRun.updatedAt }).taskRuns[0];
      this.persistState();
      this.updateUI(ctx ?? this.lastContext);
    });
    if (taskRunForSignal && terminalStatus(status) && (expectedEpoch === undefined || this.stateEpoch === expectedEpoch)) this.emitRunSignal(taskRunForSignal, runId, status);
  }

  private async markRunStatus(runId: string, status: RunStatus): Promise<void> {
    await this.lock.withLock(() => {
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
      this.persistState();
      this.updateUI(this.lastContext);
    });
  }

  private emitRunSignal(taskRun: TaskRunRecord, runId: string, status: RunStatus): void {
    const label = taskRun.status === "cancelled" || status === "cancelled"
      ? "cancelled"
      : taskRun.status === "failed" || status === "failed"
        ? "failed"
        : taskRun.status === "attention"
          ? "attention"
          : "completed";
    const customType = label === "completed" ? ENTRY_TYPE_COMPLETION : label === "attention" ? ENTRY_TYPE_ATTENTION : ENTRY_TYPE_FAILURE;
    const assignments = taskRun.assignments.filter((assignment) => assignment.runId === runId);
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
