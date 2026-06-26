// ──────────────────────────────────────────────
// Plan-first state store: create, normalize, serialize, and lock
// ──────────────────────────────────────────────

import { STATE_VERSION } from "../defaults.js";
import type {
  ArtifactRef,
  AssignmentStatus,
  PhaseRecord,
  PhaseStatus,
  PlanRecord,
  PlanStatus,
  TaskAssignmentRecord,
  TaskCriterion,
  TaskEvidence,
  TaskRecord,
  TaskStatus,
  TaskedSubagentsState,
} from "../types.js";

function now(): number {
  return Date.now();
}

function objectRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
}

function stringValue(raw: unknown, fallback = ""): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return fallback;
}

function optionalString(raw: unknown): string | undefined {
  const value = stringValue(raw).trim();
  return value ? value : undefined;
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => stringValue(value).trim()).filter(Boolean);
}

function numberValue(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function optionalPositiveInteger(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

const PLAN_STATUS_SET = new Set<PlanStatus>(["pending", "running", "attention", "completed", "failed", "cancelled"]);
const PHASE_STATUS_SET = new Set<PhaseStatus>(["pending", "ready", "running", "blocked", "attention", "completed", "failed", "cancelled"]);
const TASK_STATUS_SET = new Set<TaskStatus>(["pending", "ready", "running", "blocked", "attention", "completed", "failed", "cancelled"]);
const ASSIGNMENT_STATUS_SET = new Set<AssignmentStatus>(["queued", "running", "blocked", "attention", "completed", "failed", "cancelled", "paused", "skipped"]);

function normalizeEvidence(raw: unknown): TaskEvidence | undefined {
  const input = objectRecord(raw);
  const criterionId = optionalString(input.criterionId);
  const assignmentId = optionalString(input.assignmentId);
  const summary = optionalString(input.summary);
  if (!criterionId || !assignmentId || !summary) return undefined;
  return {
    criterionId,
    assignmentId,
    summary,
    artifactPath: optionalString(input.artifactPath),
    createdAt: numberValue(input.createdAt, now()),
  };
}

function normalizeCriterion(raw: unknown, index: number): TaskCriterion {
  const input = objectRecord(raw);
  const id = optionalString(input.id) ?? `C${index + 1}`;
  const text = optionalString(input.text) ?? optionalString(input.label) ?? "";
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.map(normalizeEvidence).filter((entry): entry is TaskEvidence => Boolean(entry))
    : [];
  const satisfied = typeof input.satisfied === "boolean" ? input.satisfied : evidence.length > 0;
  return { id, text, satisfied, evidence };
}

function normalizeTask(raw: unknown, index: number): TaskRecord {
  const input = objectRecord(raw);
  const timestamp = now();
  const rawStatus = stringValue(input.status, "pending") as TaskStatus;
  const criteria = Array.isArray(input.criteria)
    ? input.criteria.map((criterion, criterionIndex) => {
      if (typeof criterion === "string") {
        return normalizeCriterion({ id: `C${criterionIndex + 1}`, text: criterion }, criterionIndex);
      }
      return normalizeCriterion(criterion, criterionIndex);
    }).filter((criterion) => criterion.text)
    : [];

  return {
    id: optionalString(input.id) ?? `T${index + 1}`,
    text: optionalString(input.text) ?? "",
    status: TASK_STATUS_SET.has(rawStatus) ? rawStatus : "pending",
    criteria,
    dependsOn: stringList(input.dependsOn),
    assignmentIds: stringList(input.assignmentIds),
    agentHint: optionalString(input.agentHint),
    filesHint: stringList(input.filesHint).length > 0 ? stringList(input.filesHint) : undefined,
    cwd: optionalString(input.cwd),
    retries: typeof input.retries === "number" && Number.isInteger(input.retries) && input.retries >= 0 ? input.retries : undefined,
    outputMode: input.outputMode === "json" ? "json" : input.outputMode === "text" ? "text" : undefined,
    outputSchema: optionalString(input.outputSchema),
    when: optionalString(input.when),
    continuation: optionalString(input.continuation),
    createdAt: numberValue(input.createdAt, timestamp),
    updatedAt: numberValue(input.updatedAt, timestamp),
    completedAt: typeof input.completedAt === "number" && Number.isFinite(input.completedAt) ? input.completedAt : undefined,
  };
}

function normalizePhase(raw: unknown, index: number): PhaseRecord {
  const input = objectRecord(raw);
  const timestamp = now();
  const rawStatus = stringValue(input.status, "pending") as PhaseStatus;
  const filesHint = stringList(input.filesHint);
  return {
    id: optionalString(input.id) ?? `P${index + 1}`,
    title: optionalString(input.title) ?? "",
    status: PHASE_STATUS_SET.has(rawStatus) ? rawStatus : "pending",
    tasks: Array.isArray(input.tasks) ? input.tasks.map(normalizeTask) : [],
    dependsOn: stringList(input.dependsOn),
    goal: optionalString(input.goal),
    agentHint: optionalString(input.agentHint),
    filesHint: filesHint.length > 0 ? filesHint : undefined,
    brief: optionalString(input.brief),
    maxConcurrency: optionalPositiveInteger(input.maxConcurrency),
    createdAt: numberValue(input.createdAt, timestamp),
    updatedAt: numberValue(input.updatedAt, timestamp),
    completedAt: typeof input.completedAt === "number" && Number.isFinite(input.completedAt) ? input.completedAt : undefined,
  };
}

function normalizeArtifact(raw: unknown): ArtifactRef | undefined {
  const input = objectRecord(raw);
  const label = optionalString(input.label);
  const path = optionalString(input.path);
  const assignmentId = optionalString(input.assignmentId);
  const phaseId = optionalString(input.phaseId);
  const taskId = optionalString(input.taskId);
  if (!label || !path || !assignmentId || !phaseId || !taskId) return undefined;
  return { label, path, assignmentId, phaseId, taskId };
}

function normalizeAssignment(raw: unknown): TaskAssignmentRecord | undefined {
  const input = objectRecord(raw);
  const id = optionalString(input.id);
  const planId = optionalString(input.planId);
  const phaseId = optionalString(input.phaseId);
  const taskId = optionalString(input.taskId);
  const agent = optionalString(input.agent);
  const prompt = optionalString(input.prompt);
  if (!id || !planId || !phaseId || !taskId || !agent || !prompt) return undefined;
  const timestamp = now();
  const rawStatus = stringValue(input.status, "queued") as AssignmentStatus;
  return {
    id,
    planId,
    phaseId,
    taskId,
    agent,
    prompt,
    status: ASSIGNMENT_STATUS_SET.has(rawStatus) ? rawStatus : "queued",
    runId: optionalString(input.runId),
    launchRef: typeof input.launchRef === "object" && input.launchRef !== null ? input.launchRef as TaskAssignmentRecord["launchRef"] : undefined,
    result: typeof input.result === "object" && input.result !== null ? input.result as TaskAssignmentRecord["result"] : undefined,
    currentTool: optionalString(input.currentTool),
    lastActionAt: typeof input.lastActionAt === "number" && Number.isFinite(input.lastActionAt) ? input.lastActionAt : undefined,
    lastActionSummary: optionalString(input.lastActionSummary),
    recentActivity: stringList(input.recentActivity).slice(-3),
    createdAt: numberValue(input.createdAt, timestamp),
    updatedAt: numberValue(input.updatedAt, timestamp),
    completedAt: typeof input.completedAt === "number" && Number.isFinite(input.completedAt) ? input.completedAt : undefined,
  };
}

function normalizePlan(raw: unknown, index: number): PlanRecord | undefined {
  const input = objectRecord(raw);
  const timestamp = now();
  const id = optionalString(input.id) ?? `plan-${index + 1}`;
  const title = optionalString(input.title);
  const spec = optionalString(input.spec);
  if (!title || !spec) return undefined;
  const rawStatus = stringValue(input.status, "pending") as PlanStatus;
  return {
    id,
    title,
    request: optionalString(input.request) ?? spec,
    spec,
    status: PLAN_STATUS_SET.has(rawStatus) ? rawStatus : "pending",
    phases: Array.isArray(input.phases) ? input.phases.map(normalizePhase) : [],
    assignments: Array.isArray(input.assignments)
      ? input.assignments.map(normalizeAssignment).filter((entry): entry is TaskAssignmentRecord => Boolean(entry))
      : [],
    artifacts: Array.isArray(input.artifacts)
      ? input.artifacts.map(normalizeArtifact).filter((entry): entry is ArtifactRef => Boolean(entry))
      : [],
    maxConcurrency: optionalPositiveInteger(input.maxConcurrency),
    createdAt: numberValue(input.createdAt, timestamp),
    updatedAt: numberValue(input.updatedAt, timestamp),
    completedAt: typeof input.completedAt === "number" && Number.isFinite(input.completedAt) ? input.completedAt : undefined,
  };
}

export function createEmptyState(): TaskedSubagentsState {
  return {
    version: STATE_VERSION as 3,
    plans: [],
    updatedAt: now(),
  };
}

export function cloneState(state: TaskedSubagentsState): TaskedSubagentsState {
  return structuredClone(state);
}

/**
 * Normalize only valid current-version state. Older ask/run/workflow snapshots
 * and incompatible pre-run-handle snapshots are intentionally reset because the
 * plugin is still unreleased and the current model is a clean break.
 */
export function ensureState(raw: unknown): TaskedSubagentsState {
  const input = objectRecord(raw);
  if (input.version !== STATE_VERSION) return createEmptyState();

  const plans = Array.isArray(input.plans)
    ? input.plans.map(normalizePlan).filter((entry): entry is PlanRecord => Boolean(entry))
    : [];
  const currentPlanId = optionalString(input.currentPlanId);
  return {
    version: STATE_VERSION as 3,
    plans,
    currentPlanId: currentPlanId && plans.some((plan) => plan.id === currentPlanId) ? currentPlanId : plans.at(-1)?.id,
    updatedAt: numberValue(input.updatedAt, now()),
  };
}

export interface StateLock {
  withLock: <T>(operation: () => Promise<T> | T) => Promise<T>;
}

export function createStateLock(): StateLock {
  let queue: Promise<void> = Promise.resolve();
  return {
    withLock: async <T>(operation: () => Promise<T> | T): Promise<T> => {
      let release: (() => void) | undefined;
      const previous = queue;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release?.();
      }
    },
  };
}

export function serializeState(state: TaskedSubagentsState): string {
  if (state.version !== STATE_VERSION) {
    throw new Error(`Cannot serialize state: expected version ${STATE_VERSION}, got ${state.version}`);
  }
  return JSON.stringify(state);
}

export function deserializeState(raw: string): TaskedSubagentsState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Cannot deserialize state: invalid JSON");
  }
  const input = objectRecord(parsed);
  if (input.version !== STATE_VERSION) return createEmptyState();
  return ensureState(parsed);
}
