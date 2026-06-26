// ──────────────────────────────────────────────
// Plan-first controller for pi-tasked-subagents
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
  AcceptedPlanResult,
  EditPlanInput,
  EditPlanResult,
  PlanRecord,
  RunProgressSnapshot,
  RunStatus,
  SubagentRunHandle,
  SubagentRuntime,
  SubagentTaskReport,
  TaskAssignmentRecord,
  TaskRecord,
  TaskedSubagentsState,
  ValidatedPlanInput,
} from "../types.js";
import { PiRunnerAdapter } from "../launcher/pi-runner-adapter.js";
import type { RunnerRuntimeContext } from "../launcher/interface.js";
import { cloneState, createEmptyState, createStateLock, ensureState } from "../state/store.js";
import { normalizePlanInput, validatePlanInput } from "../state/plan-validation.js";
import { statusLabel } from "../ui/messages.js";
import { buildFooterStatus } from "../ui/status.js";
import { buildWidgetLines, createWidgetContent } from "../ui/widget.js";
import { shortTitle } from "../utils/text.js";
import {
  applyAssignmentProgress,
  createReadyAssignments,
  derivePlanStatus,
  toLaunchTaskEntries,
} from "./task-scheduler.js";
import { applySubagentTaskReport, parseTaskReport } from "./task-result-reducer.js";

export type { ValidatedPlanInput, EditPlanInput, AcceptedPlanResult, EditPlanResult } from "../types.js";

export interface DispatchOptions {
  maxConcurrency?: number;
  defaultAgent?: string;
  defaultCwd?: string;
  ctx?: ExtensionContext;
  planId?: string;
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
  if (runStatus === "blocked" || runStatus === "paused") return "attention";
  return runStatus;
}

function controlStatusForAssignment(
  currentStatus: TaskAssignmentRecord["status"],
  targetStatus: RunStatus,
): TaskAssignmentRecord["status"] | undefined {
  if (targetStatus === "paused") {
    return currentStatus === "queued" || currentStatus === "running" ? "paused" : undefined;
  }
  if (targetStatus === "cancelled") {
    if (finalAssignmentStatus(currentStatus)) return undefined;
    return "cancelled";
  }
  return undefined;
}

function normalizeTargetId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function maxPlanCounter(plans: PlanRecord[]): number {
  return plans.reduce((max, plan) => {
    const match = /^plan-(\d+)$/u.exec(plan.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

function taskRecordToValidationInput(task: PlanRecord["phases"][number]["tasks"][number]): ValidatedPlanInput["phases"][number]["tasks"][number] {
  return {
    id: task.id,
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

function phaseRecordToValidationInput(phase: PlanRecord["phases"][number]): ValidatedPlanInput["phases"][number] {
  return {
    id: phase.id,
    title: phase.title,
    goal: phase.goal,
    dependsOn: phase.dependsOn,
    agentHint: phase.agentHint,
    filesHint: phase.filesHint,
    brief: phase.brief,
    maxConcurrency: phase.maxConcurrency,
    tasks: phase.tasks.map(taskRecordToValidationInput),
  };
}

function planRecordToValidationInput(plan: PlanRecord): ValidatedPlanInput {
  return {
    id: plan.id,
    title: plan.title,
    request: plan.request,
    spec: plan.spec,
    maxConcurrency: plan.maxConcurrency,
    phases: plan.phases.map(phaseRecordToValidationInput),
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
  | { kind: "plan"; plan: PlanRecord }
  | { kind: "phase"; plan: PlanRecord; phase: PlanRecord["phases"][number] }
  | { kind: "task"; plan: PlanRecord; phase: PlanRecord["phases"][number]; task: PlanRecord["phases"][number]["tasks"][number] }
  | { kind: "assignment"; plan: PlanRecord; assignment: TaskAssignmentRecord; phase: PlanRecord["phases"][number]; task: PlanRecord["phases"][number]["tasks"][number] };

function recoverableTaskStatus(status: string): boolean {
  return status === "attention" || status === "failed" || status === "blocked" || status === "cancelled";
}

function assignmentResolutionLines(plan: PlanRecord, task: TaskRecord): string[] {
  return task.assignmentIds
    .map((assignmentId) => plan.assignments.find((assignment) => assignment.id === assignmentId))
    .filter((assignment): assignment is TaskAssignmentRecord => Boolean(assignment))
    .map((assignment) => {
      const details = [
        assignment.result?.summary ? `summary: ${assignment.result.summary}` : undefined,
        assignment.result?.followUps.length ? `follow-ups: ${assignment.result.followUps.join("; ")}` : undefined,
      ].filter((line): line is string => Boolean(line));
      return [`- ${assignment.id} (${assignment.status})`, ...details.map((line) => `  ${line}`)].join("\n");
    });
}

function buildResolutionPrompt(plan: PlanRecord, task: TaskRecord, prompt: string): string {
  const priorAssignments = assignmentResolutionLines(plan, task);
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

export class TaskedSubagentsController {
  private state: TaskedSubagentsState = createEmptyState();
  private readonly lock = createStateLock();
  private readonly runtime: SubagentRuntime<RunnerRuntimeContext>;
  private readonly defaultAgent: string;
  private readonly pi: ExtensionAPI;
  private planCounter = 0;
  private lastContext: ExtensionContext | undefined;
  private lastDispatchWork: Promise<void> = Promise.resolve();
  private readonly runProgressSignatures = new Map<string, string>();

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
    this.planCounter = Math.max(this.planCounter, maxPlanCounter(this.state.plans));
    this.runProgressSignatures.clear();
  }

  async awaitLastWork(): Promise<void> {
    await this.lastDispatchWork;
  }

  /** Explicit freeform routing creates a real one-phase/one-task plan. */
  async handleUserAsk(text: string, ctx?: ExtensionContext): Promise<void> {
    const request = text.trim();
    if (!request) return;
    await this.acceptValidatedPlan({
      title: shortTitle(request, 80),
      request,
      spec: request,
      phases: [
        {
          id: "main",
          title: "Main",
          tasks: [{ id: "task", text: request, criteria: ["The requested task is completed with concrete evidence."] }],
        },
      ],
    }, ctx);
  }

  async acceptValidatedPlan(input: ValidatedPlanInput, ctx?: ExtensionContext): Promise<AcceptedPlanResult> {
    if (ctx) this.lastContext = ctx;
    const result = await this.lock.withLock(() => {
      const errors = validatePlanInput(input);
      if (errors.length > 0) return { accepted: false, errors, dispatchScheduled: false } satisfies AcceptedPlanResult;

      const planId = input.id ?? `plan-${this.planCounter + 1}`;
      const normalized = normalizePlanInput(input, { planId });
      if (!normalized.plan) return { accepted: false, errors: normalized.errors, dispatchScheduled: false } satisfies AcceptedPlanResult;

      this.planCounter += 1;
      this.state.plans.push(normalized.plan);
      this.state.currentPlanId = normalized.plan.id;
      this.state.updatedAt = normalized.plan.updatedAt;
      this.persistState();
      this.updateUI(ctx ?? this.lastContext);
      return { accepted: true, planId: normalized.plan.id, errors: [], dispatchScheduled: true } satisfies AcceptedPlanResult;
    });

    if (result.accepted && result.planId) this.scheduleDispatch(result.planId, ctx);
    return result;
  }

  async editPlan(input: EditPlanInput, ctx?: ExtensionContext): Promise<EditPlanResult> {
    if (ctx) this.lastContext = ctx;
    const result = await this.lock.withLock(() => this.editPlanMutable(input, ctx));
    if (result.edited && result.dispatchScheduled && result.planId) this.scheduleDispatch(result.planId, ctx);
    return result;
  }

  async dispatchReady(options: DispatchOptions = {}): Promise<DispatchResult> {
    if (options.ctx) this.lastContext = options.ctx;
    const aggregate: DispatchResult = { launched: 0, skipped: 0, errors: [], hasBlockingIssue: false };
    const runtimeCtx = this.runtimeContext(options.ctx);

    while (true) {
      const launch = await this.lock.withLock(() => {
        const plan = this.resolvePlanMutable(options.planId);
        if (!plan) return undefined;
        const scheduled = createReadyAssignments(plan, {
          defaultAgent: options.defaultAgent ?? this.defaultAgent,
          defaultCwd: options.defaultCwd ?? runtimeCtx.cwd,
        });
        aggregate.hasBlockingIssue ||= scheduled.hasBlockingIssue;
        if (scheduled.assignments.length === 0) {
          derivePlanStatus(plan);
          this.persistState();
          this.updateUI(options.ctx ?? this.lastContext);
          return undefined;
        }
        const runId = `plan-${plan.id}-${Date.now()}`;
        return { planId: plan.id, runId, title: plan.title, assignments: scheduled.assignments };
      });

      if (!launch) return aggregate;

      try {
        const plan = this.state.plans.find((candidate) => candidate.id === launch.planId);
        if (!plan) return aggregate;
        const ref = await this.runtime.launchTaskGraph({
          runId: launch.runId,
          title: `Plan ${plan.id}: ${plan.title}`,
          taskSummary: plan.title,
          tasks: toLaunchTaskEntries(launch.assignments, plan),
          maxConcurrency: options.maxConcurrency ?? plan.maxConcurrency,
          cwd: options.defaultCwd ?? runtimeCtx.cwd,
        }, runtimeCtx);

        await this.lock.withLock(() => {
          const current = this.state.plans.find((candidate) => candidate.id === launch.planId);
          if (!current) return;
          for (const assignment of launch.assignments) {
            const stored = current.assignments.find((candidate) => candidate.id === assignment.id);
            if (!stored) continue;
            stored.status = "running";
            stored.runId = ref.runId;
            stored.launchRef = ref;
            stored.updatedAt = Date.now();
          }
          derivePlanStatus(current);
          this.persistState();
          this.updateUI(options.ctx ?? this.lastContext);
        });
        aggregate.launched += launch.assignments.length;

        const status = finalWaitStatus(await this.runtime.waitForRunSignal(ref, {
          ctx: runtimeCtx,
          onUpdate: (snapshot) => this.applyRunProgressUpdate(launch.planId, snapshot, options.ctx ?? this.lastContext),
        }));
        const raw = await this.runtime.getRunResult(ref);
        await this.applyRunOutcome(launch.planId, ref.runId, status, raw, options.ctx ?? this.lastContext);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        aggregate.errors.push(message);
        aggregate.hasBlockingIssue = true;
        await this.lock.withLock(() => {
          const plan = this.state.plans.find((candidate) => candidate.id === launch.planId);
          if (!plan) return;
          for (const assignment of launch.assignments) {
            const stored = plan.assignments.find((candidate) => candidate.id === assignment.id);
            if (!stored) continue;
            stored.status = "failed";
            stored.updatedAt = Date.now();
          }
          derivePlanStatus(plan);
          this.persistState();
          this.updateUI(options.ctx ?? this.lastContext);
        });
      }

      const shouldContinue = this.state.plans
        .find((candidate) => candidate.id === launch.planId)
        ?.phases.some((phase) => phase.status === "ready" || phase.tasks.some((task) => task.status === "ready"));
      if (!shouldContinue) return aggregate;
    }
  }

  async continuePhase(targetId: string, prompt: string, ctx?: ExtensionContext): Promise<boolean> {
    return this.continueTarget(targetId, prompt, ctx);
  }

  async continueTarget(targetId: string, prompt: string, ctx?: ExtensionContext): Promise<boolean> {
    const result = await this.readyTargetForDispatch(targetId, () => prompt.trim(), { ctx, directTargetsMustBeRecoverable: false });
    if (!result) return false;
    this.scheduleDispatch(result, ctx);
    return true;
  }

  async resolveTarget(targetId: string, prompt: string, ctx?: ExtensionContext): Promise<boolean> {
    const result = await this.readyTargetForDispatch(
      targetId,
      (plan, task) => buildResolutionPrompt(plan, task, prompt),
      { ctx, directTargetsMustBeRecoverable: true },
    );
    if (!result) return false;
    this.scheduleDispatch(result, ctx);
    return true;
  }

  async stopRun(assignmentId: string): Promise<boolean> {
    const handle = this.resolveHandleForAssignment(assignmentId);
    if (!handle) return false;
    const ok = await this.runtime.stopRun(handle, this.runtimeContext(this.lastContext));
    if (!ok) return false;
    await this.markRunStatus(handle.runId, "paused");
    return true;
  }

  async cancelRun(assignmentId: string): Promise<boolean> {
    const handle = this.resolveHandleForAssignment(assignmentId);
    if (!handle) return false;
    const ok = await this.runtime.cancelRun(handle, this.runtimeContext(this.lastContext));
    if (!ok) return false;
    await this.markRunStatus(handle.runId, "cancelled");
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
      const before = this.state.plans.length;
      if (scope === "all") this.state = createEmptyState();
      else {
        this.state.plans = this.state.plans.filter((plan) => plan.status !== "completed" && plan.status !== "cancelled");
        if (this.state.currentPlanId && !this.state.plans.some((plan) => plan.id === this.state.currentPlanId)) {
          this.state.currentPlanId = this.state.plans.at(-1)?.id;
        }
        this.state.updatedAt = Date.now();
      }
      this.persistState();
      this.updateUI(this.lastContext);
      return before - this.state.plans.length;
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

  private tasksForTarget(target: MutableTarget, options: { directTargetsMustBeRecoverable: boolean }): TaskRecord[] {
    const directTasks = target.kind === "task" || target.kind === "assignment"
      ? [target.task]
      : target.kind === "phase"
        ? target.phase.tasks
        : target.plan.phases.flatMap((phase) => phase.tasks);

    if (target.kind === "task" || target.kind === "assignment") {
      return options.directTargetsMustBeRecoverable
        ? directTasks.filter((task) => recoverableTaskStatus(task.status))
        : directTasks;
    }

    return directTasks.filter((task) => recoverableTaskStatus(task.status));
  }

  private readyTargetForDispatch(
    targetId: string,
    continuationForTask: (plan: PlanRecord, task: TaskRecord) => string,
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
        task.continuation = continuationForTask(target.plan, task).trim();
        task.completedAt = undefined;
        task.updatedAt = timestamp;
      }
      for (const phase of target.plan.phases) {
        if (phase.tasks.some((task) => taskIds.has(task.id))) {
          phase.status = "ready";
          phase.completedAt = undefined;
          phase.updatedAt = timestamp;
        }
      }
      target.plan.status = "running";
      target.plan.completedAt = undefined;
      target.plan.updatedAt = timestamp;
      derivePlanStatus(target.plan, timestamp);
      this.persistState();
      this.updateUI(ctx ?? this.lastContext);
      return target.plan.id;
    });
  }

  private editPlanMutable(input: EditPlanInput, ctx?: ExtensionContext): EditPlanResult {
    const plan = this.resolvePlanMutable(input.planId);
    if (!plan) return { edited: false, errors: [input.planId ? `Plan ${input.planId} not found` : "No current plan"], dispatchScheduled: false };
    const targetId = normalizeTargetId(input.targetId) ?? input.phase?.id ?? input.task?.id ?? plan.id;
    const timestamp = Date.now();

    if (targetId === plan.id) {
      const nextTitle = input.title !== undefined ? input.title.trim() : plan.title;
      const nextRequest = input.request !== undefined ? input.request.trim() : plan.request;
      const nextSpec = input.spec !== undefined ? input.spec.trim() : plan.spec;
      if (!nextTitle || !nextRequest || !nextSpec) return { edited: false, planId: plan.id, targetId, errors: ["Plan title, request, and spec must be non-empty"], dispatchScheduled: false };
      plan.title = nextTitle;
      plan.request = nextRequest;
      plan.spec = nextSpec;
      plan.updatedAt = timestamp;
      this.persistState();
      this.updateUI(ctx ?? this.lastContext);
      return { edited: true, planId: plan.id, targetId, errors: [], dispatchScheduled: false };
    }

    const phase = plan.phases.find((candidate) => candidate.id === targetId || candidate.id === input.phase?.id);
    if (phase && input.phase) {
      const nextPhase = {
        ...phase,
        title: input.phase.title !== undefined ? input.phase.title.trim() : phase.title,
        goal: input.phase.goal !== undefined ? input.phase.goal.trim() || undefined : phase.goal,
        dependsOn: input.phase.dependsOn !== undefined ? input.phase.dependsOn.map((dep) => dep.trim()).filter(Boolean) : phase.dependsOn,
        agentHint: input.phase.agentHint !== undefined ? input.phase.agentHint.trim() || undefined : phase.agentHint,
        filesHint: input.phase.filesHint !== undefined ? input.phase.filesHint.map((file) => file.trim()).filter(Boolean) : phase.filesHint,
        brief: input.phase.brief !== undefined ? input.phase.brief.trim() || undefined : phase.brief,
        maxConcurrency: input.phase.maxConcurrency !== undefined ? input.phase.maxConcurrency : phase.maxConcurrency,
      };
      if (!nextPhase.title) return { edited: false, planId: plan.id, targetId, errors: ["Phase title must be non-empty"], dispatchScheduled: false };
      if (nextPhase.maxConcurrency !== undefined && (!Number.isInteger(nextPhase.maxConcurrency) || nextPhase.maxConcurrency < 1)) {
        return { edited: false, planId: plan.id, targetId, errors: ["Phase maxConcurrency must be a positive integer"], dispatchScheduled: false };
      }

      let nextTasks = phase.tasks;
      let replaceTasks = false;
      if (input.phase.tasks !== undefined) {
        const replaced = normalizePlanInput({ title: plan.title, spec: plan.spec, phases: [{ ...nextPhase, dependsOn: [], tasks: input.phase.tasks }] }, { planId: plan.id, now: timestamp });
        if (!replaced.plan) return { edited: false, planId: plan.id, targetId, errors: replaced.errors, dispatchScheduled: false };
        nextTasks = replaced.plan.phases[0].tasks;
        replaceTasks = true;
      }

      const candidate = planRecordToValidationInput(plan);
      const candidatePhase = candidate.phases.find((candidate) => candidate.id === phase.id);
      if (candidatePhase) {
        candidatePhase.title = nextPhase.title;
        candidatePhase.goal = nextPhase.goal;
        candidatePhase.dependsOn = nextPhase.dependsOn;
        candidatePhase.agentHint = nextPhase.agentHint;
        candidatePhase.filesHint = nextPhase.filesHint;
        candidatePhase.brief = nextPhase.brief;
        candidatePhase.maxConcurrency = nextPhase.maxConcurrency;
        candidatePhase.tasks = nextTasks.map(taskRecordToValidationInput);
      }
      const validationErrors = validatePlanInput(candidate);
      if (validationErrors.length > 0) return { edited: false, planId: plan.id, targetId, errors: validationErrors, dispatchScheduled: false };

      const oldTaskIds = new Set(phase.tasks.map((task) => task.id));
      phase.title = nextPhase.title;
      phase.goal = nextPhase.goal;
      phase.dependsOn = nextPhase.dependsOn;
      phase.agentHint = nextPhase.agentHint;
      phase.filesHint = nextPhase.filesHint;
      phase.brief = nextPhase.brief;
      phase.maxConcurrency = nextPhase.maxConcurrency;
      if (replaceTasks) {
        phase.tasks = nextTasks;
        phase.completedAt = undefined;
        plan.assignments = plan.assignments.filter((assignment) => assignment.phaseId !== phase.id || !oldTaskIds.has(assignment.taskId));
        plan.artifacts = plan.artifacts.filter((artifact) => artifact.phaseId !== phase.id || !oldTaskIds.has(artifact.taskId));
      }
      phase.status = "ready";
      phase.updatedAt = timestamp;
      plan.status = "running";
      plan.completedAt = undefined;
      plan.updatedAt = timestamp;
      derivePlanStatus(plan, timestamp);
      this.persistState();
      this.updateUI(ctx ?? this.lastContext);
      return { edited: true, planId: plan.id, targetId: phase.id, errors: [], dispatchScheduled: true };
    }

    const taskRef = this.findTask(plan, targetId);
    if (taskRef && input.task) {
      const nextText = input.task.text !== undefined ? input.task.text.trim() : taskRef.task.text;
      const nextCriteria = input.task.criteria !== undefined
        ? input.task.criteria.map((text, index) => ({ id: `C${index + 1}`, text: text.trim(), satisfied: false, evidence: [] })).filter((criterion) => criterion.text)
        : taskRef.task.criteria;
      const nextDependsOn = input.task.dependsOn !== undefined ? input.task.dependsOn.map((dep) => dep.trim()).filter(Boolean) : taskRef.task.dependsOn;
      const nextAgentHint = input.task.agentHint !== undefined ? input.task.agentHint.trim() || undefined : taskRef.task.agentHint;
      const nextFilesHint = input.task.filesHint !== undefined ? input.task.filesHint.map((file) => file.trim()).filter(Boolean) : taskRef.task.filesHint;
      const nextCwd = input.task.cwd !== undefined ? input.task.cwd.trim() || undefined : taskRef.task.cwd;
      const nextRetries = input.task.retries !== undefined ? input.task.retries : taskRef.task.retries;
      if (!nextText || nextCriteria.length === 0) return { edited: false, planId: plan.id, targetId, errors: ["Task text and criteria must be non-empty"], dispatchScheduled: false };
      if (nextRetries !== undefined && (!Number.isInteger(nextRetries) || nextRetries < 0)) {
        return { edited: false, planId: plan.id, targetId, errors: ["Task retries must be a non-negative integer"], dispatchScheduled: false };
      }
      const candidate = planRecordToValidationInput(plan);
      const candidatePhase = candidate.phases.find((phase) => phase.id === taskRef.phase.id);
      const candidateTask = candidatePhase?.tasks.find((task) => task.id === taskRef.task.id);
      if (candidateTask) {
        candidateTask.text = nextText;
        candidateTask.criteria = nextCriteria.map((criterion) => criterion.text);
        candidateTask.dependsOn = nextDependsOn;
        candidateTask.agentHint = nextAgentHint;
        candidateTask.filesHint = nextFilesHint;
        candidateTask.cwd = nextCwd;
        candidateTask.retries = nextRetries;
      }
      const validationErrors = validatePlanInput(candidate);
      if (validationErrors.length > 0) return { edited: false, planId: plan.id, targetId, errors: validationErrors, dispatchScheduled: false };

      taskRef.task.text = nextText;
      taskRef.task.criteria = nextCriteria;
      taskRef.task.dependsOn = nextDependsOn;
      taskRef.task.agentHint = nextAgentHint;
      taskRef.task.filesHint = nextFilesHint;
      taskRef.task.cwd = nextCwd;
      taskRef.task.retries = nextRetries;
      taskRef.task.status = "ready";
      taskRef.task.assignmentIds = [];
      taskRef.task.completedAt = undefined;
      taskRef.task.updatedAt = timestamp;
      taskRef.phase.status = "ready";
      taskRef.phase.updatedAt = timestamp;
      plan.assignments = plan.assignments.filter((assignment) => assignment.taskId !== taskRef.task.id);
      plan.artifacts = plan.artifacts.filter((artifact) => artifact.taskId !== taskRef.task.id);
      plan.status = "running";
      plan.completedAt = undefined;
      plan.updatedAt = timestamp;
      derivePlanStatus(plan, timestamp);
      this.persistState();
      this.updateUI(ctx ?? this.lastContext);
      return { edited: true, planId: plan.id, targetId: taskRef.task.id, errors: [], dispatchScheduled: true };
    }

    return { edited: false, planId: plan.id, targetId, errors: [`Target ${targetId} not found`], dispatchScheduled: false };
  }

  private scheduleDispatch(planId: string, ctx?: ExtensionContext): void {
    this.lastDispatchWork = new Promise((resolve) => {
      setTimeout(() => {
        void this.dispatchReady({ planId, ctx }).catch((error: unknown) => {
          console.error(`[${PACKAGE_NAME}] dispatch failed:`, error);
        }).finally(resolve);
      }, 0);
    });
  }

  private async applyRunProgressUpdate(planId: string, snapshot: RunProgressSnapshot, ctx?: ExtensionContext): Promise<void> {
    const signature = progressSignature(snapshot);
    const key = `${planId}:${snapshot.runId}`;
    if (this.runProgressSignatures.get(key) === signature) return;
    await this.lock.withLock(() => {
      const plan = this.state.plans.find((candidate) => candidate.id === planId);
      if (!plan) return;
      if (!applyAssignmentProgress(plan, snapshot)) return;
      this.runProgressSignatures.set(key, signature);
      this.persistState();
      this.updateUI(ctx ?? this.lastContext);
    });
  }

  private async applyRunOutcome(planId: string, runId: string, status: RunStatus, raw: string | undefined, ctx?: ExtensionContext): Promise<void> {
    let planForSignal: PlanRecord | undefined;
    await this.lock.withLock(() => {
      const plan = this.state.plans.find((candidate) => candidate.id === planId);
      if (!plan) return;
      const assignments = plan.assignments.filter((assignment) => assignment.runId === runId);
      const timestamp = Date.now();

      const reports = parseReportsFromRaw(raw);
      const handledAssignmentIds = new Set<string>();
      for (const { assignmentId, report } of reports) {
        const expectedAssignmentId = assignmentId ?? report.assignmentId;
        const assignment = assignments.find((candidate) => candidate.id === expectedAssignmentId);
        if (!assignment) continue;
        handledAssignmentIds.add(assignment.id);
        applySubagentTaskReport(plan, report, {
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
        if (terminalStatus(status)) assignment.completedAt = timestamp;
      }
      derivePlanStatus(plan, timestamp);

      planForSignal = cloneState({ version: 3, plans: [plan], currentPlanId: plan.id, updatedAt: plan.updatedAt }).plans[0];
      this.persistState();
      this.updateUI(ctx ?? this.lastContext);
    });
    if (planForSignal && terminalStatus(status)) this.emitRunSignal(planForSignal, runId, status);
  }

  private async markRunStatus(runId: string, status: RunStatus): Promise<void> {
    await this.lock.withLock(() => {
      for (const plan of this.state.plans) {
        const assignments = plan.assignments.filter((assignment) => assignment.runId === runId);
        if (assignments.length === 0) continue;
        for (const assignment of assignments) {
          const nextStatus = controlStatusForAssignment(assignment.status, status);
          if (!nextStatus) continue;
          assignment.status = nextStatus;
          assignment.updatedAt = Date.now();
          if (terminalStatus(status)) assignment.completedAt = Date.now();
        }
        derivePlanStatus(plan);
      }
      this.persistState();
      this.updateUI(this.lastContext);
    });
  }

  private emitRunSignal(plan: PlanRecord, runId: string, status: RunStatus): void {
    const label = plan.status === "cancelled" || status === "cancelled"
      ? "cancelled"
      : plan.status === "failed" || status === "failed"
        ? "failed"
        : plan.status === "attention"
          ? "attention"
          : "completed";
    const customType = label === "completed" ? ENTRY_TYPE_COMPLETION : label === "attention" ? ENTRY_TYPE_ATTENTION : ENTRY_TYPE_FAILURE;
    const assignments = plan.assignments.filter((assignment) => assignment.runId === runId);
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
          `[tasked-subagents] ${label}: ${plan.id} · ${plan.title}`,
          assignmentLines.length > 0 ? "assignments:" : undefined,
          ...assignmentLines,
          `plan: ${plan.status}`,
          detailsHint,
        ].filter(Boolean).join("\n"),
        display: false,
        details: { planId: plan.id, assignmentIds, status: label, routedCompletion: true },
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

  private resolvePlanMutable(planId?: string): PlanRecord | undefined {
    const target = normalizeTargetId(planId) ?? this.state.currentPlanId;
    if (target) return this.state.plans.find((plan) => plan.id === target);
    return this.state.plans.at(-1);
  }

  private resolveHandleForAssignment(assignmentId: string): SubagentRunHandle | undefined {
    for (const plan of this.state.plans) {
      const assignment = plan.assignments.find((candidate) => candidate.id === assignmentId);
      if (!assignment) continue;
      const launchRef = assignment.launchRef;
      if (!launchRef?.runId || !launchRef.asyncId || !Array.isArray(launchRef.assignments) || launchRef.assignments.length === 0) {
        return undefined;
      }
      if (!assignment.runId || assignment.runId !== launchRef.runId) return undefined;
      const ownsAssignment = launchRef.assignments.some((entry) => entry.assignmentId === assignment.id && entry.runId === launchRef.runId);
      if (!ownsAssignment) return undefined;
      return launchRef;
    }
    return undefined;
  }

  private findTask(plan: PlanRecord, taskId: string): { phase: PlanRecord["phases"][number]; task: PlanRecord["phases"][number]["tasks"][number] } | undefined {
    for (const phase of plan.phases) {
      const task = phase.tasks.find((candidate) => candidate.id === taskId);
      if (task) return { phase, task };
    }
    return undefined;
  }

  private resolveTargetMutable(targetId: string): MutableTarget | undefined {
    for (const plan of this.state.plans) {
      if (plan.id === targetId) return { kind: "plan", plan };
      for (const phase of plan.phases) {
        if (phase.id === targetId) return { kind: "phase", plan, phase };
        for (const task of phase.tasks) {
          if (task.id === targetId) return { kind: "task", plan, phase, task };
        }
      }
      const assignment = plan.assignments.find((candidate) => candidate.id === targetId);
      if (assignment) {
        const phase = plan.phases.find((candidate) => candidate.id === assignment.phaseId);
        const task = phase?.tasks.find((candidate) => candidate.id === assignment.taskId);
        if (phase && task) return { kind: "assignment", plan, assignment, phase, task };
      }
    }
    return undefined;
  }
}
