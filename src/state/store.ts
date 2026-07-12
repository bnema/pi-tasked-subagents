// ──────────────────────────────────────────────
// Task-run state store: create, normalize, serialize, and lock
// ──────────────────────────────────────────────

import { STATE_VERSION } from "../defaults.js";
import type {
  ArtifactRef,
  AssignmentStatus,
  SubagentRunAssignmentHandle,
  SubagentRunHandle,
  TaskAssignmentRecord,
  TaskCriterion,
  TaskEvidence,
  TaskGroupRecord,
  TaskGroupStatus,
  TaskRecord,
  TaskReportStatus,
  TaskResultRecord,
  TaskRunRecord,
  TaskRunStatus,
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

function optionalTimestamp(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

const TASK_RUN_STATUS: Record<TaskRunStatus, true> = { pending: true, running: true, attention: true, completed: true, failed: true, cancelled: true };
const TASK_GROUP_STATUS: Record<TaskGroupStatus, true> = { pending: true, ready: true, running: true, blocked: true, attention: true, completed: true, failed: true, cancelled: true };
const TASK_STATUS: Record<TaskStatus, true> = { pending: true, ready: true, running: true, blocked: true, attention: true, completed: true, failed: true, cancelled: true };
const ASSIGNMENT_STATUS: Record<AssignmentStatus, true> = { queued: true, running: true, blocked: true, attention: true, completed: true, failed: true, cancelled: true, paused: true, skipped: true };
const TASK_REPORT_STATUS: Record<TaskReportStatus, true> = { completed: true, attention: true, failed: true };

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

function normalizeTask(raw: unknown): TaskRecord | undefined {
  const input = objectRecord(raw);
  const id = optionalString(input.id);
  const text = optionalString(input.text);
  const rawStatus = optionalString(input.status) as TaskStatus | undefined;
  const createdAt = optionalTimestamp(input.createdAt);
  const updatedAt = optionalTimestamp(input.updatedAt);
  if (!id || !text || !rawStatus || !Array.isArray(input.criteria) || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  const filesHint = stringList(input.filesHint);
  const criteria = input.criteria.map((criterion, criterionIndex) => {
    if (typeof criterion === "string") {
      return normalizeCriterion({ id: `C${criterionIndex + 1}`, text: criterion }, criterionIndex);
    }
    return normalizeCriterion(criterion, criterionIndex);
  }).filter((criterion) => criterion.text);

  return {
    id,
    groupId: optionalString(input.groupId),
    text,
    status: Object.prototype.hasOwnProperty.call(TASK_STATUS, rawStatus) ? rawStatus : "pending",
    criteria,
    dependsOn: stringList(input.dependsOn),
    assignmentIds: stringList(input.assignmentIds),
    agentHint: optionalString(input.agentHint),
    filesHint: filesHint.length > 0 ? filesHint : undefined,
    cwd: optionalString(input.cwd),
    retries: typeof input.retries === "number" && Number.isInteger(input.retries) && input.retries >= 0 ? input.retries : undefined,
    outputMode: input.outputMode === "json" ? "json" : input.outputMode === "text" ? "text" : undefined,
    outputSchema: optionalString(input.outputSchema),
    when: optionalString(input.when),
    expansionMode: input.expansionMode === "append_tasks" ? "append_tasks" : undefined,
    continuation: optionalString(input.continuation),
    createdAt,
    updatedAt,
    completedAt: optionalTimestamp(input.completedAt),
  };
}

function normalizeGroup(raw: unknown): TaskGroupRecord | undefined {
  const input = objectRecord(raw);
  const id = optionalString(input.id);
  const title = optionalString(input.title);
  const rawStatus = optionalString(input.status) as TaskGroupStatus | undefined;
  const maxConcurrency = optionalPositiveInteger(input.maxConcurrency);
  const createdAt = optionalTimestamp(input.createdAt);
  const updatedAt = optionalTimestamp(input.updatedAt);
  if (!id || !title || !rawStatus || !Array.isArray(input.dependsOn) || maxConcurrency === undefined || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  const filesHint = stringList(input.filesHint);
  return {
    id,
    title,
    status: Object.prototype.hasOwnProperty.call(TASK_GROUP_STATUS, rawStatus) ? rawStatus : "pending",
    dependsOn: stringList(input.dependsOn),
    maxConcurrency,
    agentHint: optionalString(input.agentHint),
    filesHint: filesHint.length > 0 ? filesHint : undefined,
    createdAt,
    updatedAt,
    completedAt: optionalTimestamp(input.completedAt),
  };
}

interface TaskContextFallback {
  taskRunId: string;
  groupId?: string;
  taskId?: string;
  assignmentId?: string;
}

function normalizeArtifact(raw: unknown, fallback: TaskContextFallback): ArtifactRef | undefined {
  const input = objectRecord(raw);
  const label = optionalString(input.label);
  const path = optionalString(input.path);
  const assignmentId = optionalString(input.assignmentId) ?? fallback.assignmentId;
  const taskRunId = fallback.taskRunId;
  const taskId = optionalString(input.taskId) ?? fallback.taskId;
  const groupId = optionalString(input.groupId) ?? fallback.groupId;
  if (!label || !path || !assignmentId || !taskId) return undefined;
  return { label, path, assignmentId, taskRunId, groupId, taskId };
}

function normalizeLaunchAssignmentHandle(raw: unknown, fallback: { assignmentId: string; runId: string; resultPath?: string }): SubagentRunAssignmentHandle | undefined {
  const input = objectRecord(raw);
  const assignmentId = optionalString(input.assignmentId) ?? fallback.assignmentId;
  const runId = optionalString(input.runId) ?? fallback.runId;
  if (!assignmentId || !runId) return undefined;
  const resultPath = optionalString(input.resultPath) ?? fallback.resultPath;
  return {
    assignmentId,
    runId,
    ...(resultPath ? { resultPath } : {}),
  };
}

function normalizeLaunchRef(raw: unknown, assignmentId: string, assignmentRunId?: string, assignmentResultPath?: string): SubagentRunHandle | undefined {
  const input = objectRecord(raw);
  const runId = optionalString(input.runId) ?? assignmentRunId ?? optionalString(input.asyncId);
  if (!runId) return undefined;
  const asyncId = optionalString(input.asyncId) ?? runId;
  const resultPath = optionalString(input.resultPath) ?? assignmentResultPath;
  const assignments = Array.isArray(input.assignments)
    ? input.assignments
      .map((entry) => normalizeLaunchAssignmentHandle(entry, { assignmentId, runId, resultPath }))
      .filter((entry): entry is SubagentRunAssignmentHandle => Boolean(entry))
    : [];
  if (!assignments.some((entry) => entry.assignmentId === assignmentId)) {
    assignments.push({ assignmentId, runId, ...(resultPath ? { resultPath } : {}) });
  }
  return {
    runId,
    asyncId,
    ...(optionalString(input.asyncDir) ? { asyncDir: optionalString(input.asyncDir) } : {}),
    ...(resultPath ? { resultPath } : {}),
    ...(optionalString(input.sessionFile) ? { sessionFile: optionalString(input.sessionFile) } : {}),
    ...(optionalString(input.artifactPath) ? { artifactPath: optionalString(input.artifactPath) } : {}),
    assignments,
  };
}

function normalizeCriteriaEvidence(raw: unknown): TaskResultRecord["criteriaEvidence"][number] | undefined {
  const input = objectRecord(raw);
  const criterionId = optionalString(input.criterionId);
  const evidence = optionalString(input.evidence);
  if (typeof input.criteriaIndex !== "number" || !Number.isInteger(input.criteriaIndex) || !criterionId || !evidence) return undefined;
  return { criteriaIndex: input.criteriaIndex, criterionId, evidence };
}

function normalizeResult(raw: unknown, fallback: Required<Pick<TaskContextFallback, "assignmentId" | "taskRunId" | "taskId">> & Pick<TaskContextFallback, "groupId">): TaskResultRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const input = raw as Record<string, unknown>;
  const assignmentId = optionalString(input.assignmentId) ?? fallback.assignmentId;
  const rawStatus = stringValue(input.status) as TaskReportStatus;
  const summary = optionalString(input.summary);
  if (!assignmentId || !Object.prototype.hasOwnProperty.call(TASK_REPORT_STATUS, rawStatus) || !summary) return undefined;
  return {
    assignmentId,
    status: rawStatus,
    summary,
    criteriaEvidence: Array.isArray(input.criteriaEvidence)
      ? input.criteriaEvidence.map(normalizeCriteriaEvidence).filter((entry): entry is TaskResultRecord["criteriaEvidence"][number] => Boolean(entry))
      : [],
    artifacts: Array.isArray(input.artifacts)
      ? input.artifacts.map((artifact) => normalizeArtifact(artifact, fallback)).filter((entry): entry is ArtifactRef => Boolean(entry))
      : [],
    followUps: stringList(input.followUps),
    rawResultPath: optionalString(input.rawResultPath),
    createdAt: numberValue(input.createdAt, now()),
  };
}

function normalizeAssignment(raw: unknown, taskRunId: string, groupIdByTaskId: ReadonlyMap<string, string | undefined>): TaskAssignmentRecord | undefined {
  const input = objectRecord(raw);
  const id = optionalString(input.id);
  const taskId = optionalString(input.taskId);
  const agent = optionalString(input.agent);
  const prompt = optionalString(input.prompt);
  if (!id || !taskId || !agent || !prompt) return undefined;
  const groupId = groupIdByTaskId.has(taskId) ? groupIdByTaskId.get(taskId) : optionalString(input.groupId);
  const launchInput = objectRecord(input.launchRef);
  const runId = optionalString(input.runId) ?? optionalString(launchInput.runId) ?? optionalString(launchInput.asyncId);
  const assignmentResultPath = optionalString(input.resultPath);
  const launchRef = normalizeLaunchRef(input.launchRef, id, runId, assignmentResultPath);
  const timestamp = now();
  const rawStatus = stringValue(input.status, "queued") as AssignmentStatus;
  const recentActivity = stringList(input.recentActivity).slice(-3);
  return {
    id,
    taskRunId,
    groupId,
    taskId,
    agent,
    prompt,
    status: Object.prototype.hasOwnProperty.call(ASSIGNMENT_STATUS, rawStatus) ? rawStatus : "queued",
    runId: runId ?? launchRef?.runId,
    launchRef,
    result: normalizeResult(input.result, { assignmentId: id, taskRunId, groupId, taskId }),
    currentTool: optionalString(input.currentTool),
    lastActionAt: optionalTimestamp(input.lastActionAt),
    lastActionSummary: optionalString(input.lastActionSummary),
    ...(recentActivity.length > 0 ? { recentActivity } : {}),
    supersededAt: optionalTimestamp(input.supersededAt),
    supersededByAssignmentId: optionalString(input.supersededByAssignmentId),
    createdAt: numberValue(input.createdAt, timestamp),
    updatedAt: numberValue(input.updatedAt, timestamp),
    completedAt: optionalTimestamp(input.completedAt),
  };
}

function normalizeTaskRun(raw: unknown, _index: number): TaskRunRecord | undefined {
  const input = objectRecord(raw);
  const timestamp = now();
  const id = optionalString(input.id);
  const title = optionalString(input.title);
  const request = optionalString(input.request);
  const context = optionalString(input.context);
  if (!id || !title || !request || !context) return undefined;
  const rawStatus = stringValue(input.status, "pending") as TaskRunStatus;
  const groups = Array.isArray(input.groups)
    ? input.groups.map(normalizeGroup).filter((entry): entry is TaskGroupRecord => Boolean(entry))
    : [];
  const groupIds = new Set(groups.map((group) => group.id));
  const tasks = Array.isArray(input.tasks)
    ? input.tasks
      .map(normalizeTask)
      .filter((entry): entry is TaskRecord => Boolean(entry))
      .filter((task) => !task.groupId || groupIds.has(task.groupId))
    : [];
  const groupIdByTaskId = new Map(tasks.map((task) => [task.id, task.groupId]));
  const taskIds = new Set(tasks.map((task) => task.id));
  const assignments = Array.isArray(input.assignments)
    ? input.assignments
      .map((assignment) => normalizeAssignment(assignment, id, groupIdByTaskId))
      .filter((entry): entry is TaskAssignmentRecord => Boolean(entry))
      .filter((entry) => taskIds.has(entry.taskId))
    : [];
  const assignmentIds = new Set(assignments.map((assignment) => assignment.id));
  const reconciledTasks = tasks.map((task) => ({
    ...task,
    assignmentIds: task.assignmentIds.filter((assignmentId) => assignmentIds.has(assignmentId)),
  }));
  for (const task of reconciledTasks) {
    const taskAssignments = task.assignmentIds
      .map((assignmentId) => assignments.find((assignment) => assignment.id === assignmentId))
      .filter((assignment): assignment is TaskAssignmentRecord => Boolean(assignment));
    for (const [index, assignment] of taskAssignments.entries()) {
      const replacement = taskAssignments[index + 1];
      if (replacement) {
        assignment.supersededAt = replacement.createdAt;
        assignment.supersededByAssignmentId = replacement.id;
      } else {
        delete assignment.supersededAt;
        delete assignment.supersededByAssignmentId;
      }
    }
  }
  const supersededAssignmentIds = new Set(assignments
    .filter((assignment) => assignment.supersededAt !== undefined || assignment.supersededByAssignmentId !== undefined)
    .map((assignment) => assignment.id));
  for (const task of reconciledTasks) {
    for (const criterion of task.criteria) {
      const priorEvidenceCount = criterion.evidence.length;
      criterion.evidence = criterion.evidence.filter((evidence) => !supersededAssignmentIds.has(evidence.assignmentId));
      if (criterion.evidence.length < priorEvidenceCount && criterion.evidence.length === 0) criterion.satisfied = false;
    }
  }
  return {
    id,
    title,
    request,
    context,
    status: Object.prototype.hasOwnProperty.call(TASK_RUN_STATUS, rawStatus) ? rawStatus : "pending",
    groups,
    tasks: reconciledTasks,
    assignments,
    artifacts: Array.isArray(input.artifacts)
      ? input.artifacts
        .map((artifact) => normalizeArtifact(artifact, { taskRunId: id }))
        .filter((entry): entry is ArtifactRef => Boolean(entry))
        .filter((entry) => taskIds.has(entry.taskId) && assignmentIds.has(entry.assignmentId) && !supersededAssignmentIds.has(entry.assignmentId))
      : [],
    maxConcurrency: optionalPositiveInteger(input.maxConcurrency),
    createdAt: numberValue(input.createdAt, timestamp),
    updatedAt: numberValue(input.updatedAt, timestamp),
    completedAt: optionalTimestamp(input.completedAt),
  };
}

export function createEmptyState(): TaskedSubagentsState {
  return {
    version: STATE_VERSION as 4,
    taskRuns: [],
    updatedAt: now(),
  };
}

export function cloneState(state: TaskedSubagentsState): TaskedSubagentsState {
  return structuredClone(state);
}

/**
 * Normalize only valid v4 task-run state. Older plan/phase snapshots are a
 * clean break and intentionally reset without migration.
 */
export function ensureState(raw: unknown): TaskedSubagentsState {
  const input = objectRecord(raw);
  if (input.version !== STATE_VERSION || !Array.isArray(input.taskRuns)) return createEmptyState();

  const taskRuns = input.taskRuns
    .map(normalizeTaskRun)
    .filter((entry): entry is TaskRunRecord => Boolean(entry));
  const currentTaskRunId = optionalString(input.currentTaskRunId);
  const validCurrentTaskRunId = currentTaskRunId && taskRuns.some((taskRun) => taskRun.id === currentTaskRunId)
    ? currentTaskRunId
    : taskRuns.at(-1)?.id;
  return {
    version: STATE_VERSION as 4,
    taskRuns,
    ...(validCurrentTaskRunId ? { currentTaskRunId: validCurrentTaskRunId } : {}),
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
