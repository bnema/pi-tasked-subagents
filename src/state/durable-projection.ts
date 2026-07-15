import {
  MAX_ASSIGNMENT_ARCHIVE_BYTES,
  MAX_CHECKPOINT_BYTES,
  MAX_RECENT_ASSIGNMENT_REFS,
  MAX_RECENT_COMPLETED,
  MAX_RECOVERABLE_TASK_RUNS,
  MAX_TASK_RUN_OBJECT_BYTES,
} from "../defaults.js";
import type {
  ArtifactRef,
  TaskResultRecord,
  TaskRunRecord,
  TaskRunStatus,
  TaskedSubagentsState,
} from "../types.js";
import { canonicalJson, utf8Bytes } from "./canonical-json.js";
import type {
  AssignmentArchiveV1,
  CheckpointManifestV1,
  CompletedRunSummary,
  RecentAssignmentReference,
  RecoverableRunReference,
  TerminalAssignmentArchiveStatus,
} from "./durable-types.js";

/** Text appended whenever a detail field is reduced to its byte budget. */
export const ARCHIVE_TRUNCATION_MARKER = "…[truncated]";
export const MAX_ARCHIVE_SUMMARY_BYTES = 16 * 1024;
export const MAX_ARCHIVE_CRITERIA_EVIDENCE = 64;
export const MAX_ARCHIVE_CRITERION_EVIDENCE_BYTES = 8 * 1024;
export const MAX_ARCHIVE_ARTIFACTS = 128;
export const MAX_ARCHIVE_ARTIFACT_LABEL_BYTES = 1024;
export const MAX_ARCHIVE_ARTIFACT_PATH_BYTES = 8 * 1024;
export const MAX_ARCHIVE_FOLLOW_UPS = 64;
export const MAX_ARCHIVE_FOLLOW_UP_BYTES = 4 * 1024;

export type ProjectionError = { code: "limit_exceeded"; message: string };
export type ProjectionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProjectionError };

/** An already-written assignment archive and the terminal event it represents. */
export interface ArchiveRef extends RecentAssignmentReference {
  taskRunId: string;
  completedAt: number;
}

interface AssignmentArchiveInputBase {
  assignmentId: string;
  taskRunId: string;
  groupId?: string;
  taskId: string;
  status: TerminalAssignmentArchiveStatus;
  summary: string;
  criteriaEvidence: TaskResultRecord["criteriaEvidence"];
  artifacts: ArtifactRef[];
  followUps: string[];
  runId: string;
  completedAt: number;
}

type AssignmentArchiveInputResult =
  | { resultId: string; resultUnavailableReason?: never }
  | { resultId?: never; resultUnavailableReason: "missing-legacy-result" };

export type AssignmentArchiveInput = AssignmentArchiveInputBase & AssignmentArchiveInputResult;

/** The bounded data from which the coordinator writes task-run objects and a manifest. */
export interface CheckpointProjection {
  currentTaskRunId?: string;
  updatedAt: number;
  recoverableRuns: TaskRunRecord[];
  completedRuns: CompletedRunSummary[];
  recentAssignmentRefs: RecentAssignmentReference[];
}

export interface CheckpointManifestInput {
  sessionId: string;
  sequence: number;
  recoverableRuns: RecoverableRunReference[];
  projection: Omit<CheckpointProjection, "recoverableRuns">;
}

const RECOVERABLE_STATUSES = new Set<TaskRunStatus>(["pending", "running", "attention", "failed"]);
const COMPLETED_STATUSES = new Set<TaskRunStatus>(["completed", "cancelled"]);

function limitError(message: string): ProjectionResult<never> {
  return { ok: false, error: { code: "limit_exceeded", message } };
}

function cloneRunWithoutTransientFields(run: TaskRunRecord): TaskRunRecord {
  // Clone first: a projection must not share mutable nested records with controller state.
  const clone = structuredClone(run);
  clone.assignments = clone.assignments.map((assignment) => {
    const {
      currentTool: _currentTool,
      lastActionAt: _lastActionAt,
      lastActionSummary: _lastActionSummary,
      recentActivity: _recentActivity,
      result,
      ...durableAssignment
    } = assignment;
    if (!result) return durableAssignment;
    // Legacy raw paths are neither a durable result identity nor safe state data.
    const { rawResultPath: _rawResultPath, ...durableResult } = result;
    return { ...durableAssignment, result: durableResult };
  });
  // Runtime records commonly retain optional properties as `undefined`.
  // Persisted objects are JSON, so normalize those exactly as JSON does.
  return JSON.parse(JSON.stringify(clone)) as TaskRunRecord;
}

/**
 * Produce an independent, durable TaskRun payload. Transient runner display
 * fields and legacy raw result paths are deliberately omitted.
 */
export function projectTaskRun(run: TaskRunRecord): ProjectionResult<TaskRunRecord> {
  let projected: TaskRunRecord;
  try {
    projected = cloneRunWithoutTransientFields(run);
  } catch {
    return limitError("TaskRun cannot be safely cloned for durable persistence");
  }

  try {
    if (utf8Bytes({ storeVersion: 1, kind: "task-run", payload: projected }) > MAX_TASK_RUN_OBJECT_BYTES) {
      return limitError("TaskRun exceeds the 2 MiB durable limit; shorten task context or move large content into an artifact file");
    }
  } catch {
    return limitError("TaskRun cannot be serialized for durable persistence");
  }
  return { ok: true, value: projected };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(ARCHIVE_TRUNCATION_MARKER, "utf8");
  if (markerBytes >= maxBytes) return ARCHIVE_TRUNCATION_MARKER.slice(0, maxBytes);
  const budget = maxBytes - markerBytes;
  let output = "";
  let used = 0;
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (used + bytes > budget) break;
    output += codePoint;
    used += bytes;
  }
  return `${output}${ARCHIVE_TRUNCATION_MARKER}`;
}

/** Reduce one string field until its containing JSON record fits a byte limit. */
function fitRecordText<T extends Record<string, unknown>>(
  record: T,
  key: keyof T,
  maxBytes: number,
): T {
  if (utf8Bytes(record) <= maxBytes) return record;
  const source = record[key];
  if (typeof source !== "string") return record;
  const points = Array.from(source);
  let low = 0;
  let high = points.length;
  let best = "";
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = count === points.length ? source : `${points.slice(0, count).join("")}${ARCHIVE_TRUNCATION_MARKER}`;
    const next = { ...record, [key]: candidate } as T;
    if (utf8Bytes(next) <= maxBytes) {
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return { ...record, [key]: best } as T;
}

function normalizeCriterionEvidence(
  evidence: TaskResultRecord["criteriaEvidence"],
): TaskResultRecord["criteriaEvidence"] {
  return evidence.slice(0, MAX_ARCHIVE_CRITERIA_EVIDENCE).map((item) => {
    let bounded = {
      criteriaIndex: item.criteriaIndex,
      criterionId: item.criterionId,
      evidence: item.evidence,
    };
    // Evidence is the primary detail; criterion IDs are reduced only if a
    // malformed/legacy ID would otherwise make the item exceed its hard cap.
    bounded = fitRecordText(bounded, "evidence", MAX_ARCHIVE_CRITERION_EVIDENCE_BYTES);
    bounded = fitRecordText(bounded, "criterionId", MAX_ARCHIVE_CRITERION_EVIDENCE_BYTES);
    bounded = fitRecordText(bounded, "evidence", MAX_ARCHIVE_CRITERION_EVIDENCE_BYTES);
    return bounded;
  });
}

function normalizeArtifacts(artifacts: ArtifactRef[]): ArtifactRef[] {
  return artifacts.slice(0, MAX_ARCHIVE_ARTIFACTS).map((artifact) => ({
    ...artifact,
    label: truncateUtf8(artifact.label, MAX_ARCHIVE_ARTIFACT_LABEL_BYTES),
    path: truncateUtf8(artifact.path, MAX_ARCHIVE_ARTIFACT_PATH_BYTES),
  }));
}

function archiveResultState(input: AssignmentArchiveInput): AssignmentArchiveInputResult {
  return input.resultId === undefined
    ? { resultUnavailableReason: input.resultUnavailableReason }
    : { resultId: input.resultId };
}

function archiveMetadata(input: AssignmentArchiveInput): AssignmentArchiveV1 {
  return {
    assignmentId: input.assignmentId,
    taskRunId: input.taskRunId,
    ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
    taskId: input.taskId,
    status: input.status,
    runId: input.runId,
    ...archiveResultState(input),
    completedAt: input.completedAt,
    detailOmitted: true,
  };
}

/**
 * Normalize terminal assignment metadata before it enters an immutable archive.
 * Detail omission is deterministic and leaves result identity intact.
 */
export function projectAssignmentArchive(input: AssignmentArchiveInput): AssignmentArchiveV1 {
  const archive: AssignmentArchiveV1 = {
    assignmentId: input.assignmentId,
    taskRunId: input.taskRunId,
    ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
    taskId: input.taskId,
    status: input.status,
    summary: truncateUtf8(input.summary, MAX_ARCHIVE_SUMMARY_BYTES),
    criteriaEvidence: normalizeCriterionEvidence(input.criteriaEvidence),
    artifacts: normalizeArtifacts(input.artifacts),
    followUps: input.followUps
      .slice(0, MAX_ARCHIVE_FOLLOW_UPS)
      .map((followUp) => truncateUtf8(followUp, MAX_ARCHIVE_FOLLOW_UP_BYTES)),
    runId: input.runId,
    ...archiveResultState(input),
    completedAt: input.completedAt,
  };
  try {
    return utf8Bytes({ storeVersion: 1, kind: "assignment", payload: archive }) <= MAX_ASSIGNMENT_ARCHIVE_BYTES
      ? archive
      : archiveMetadata(input);
  } catch {
    // Invalid JSON-compatible detail cannot be made durable. Preserve only the
    // required identity metadata, exactly as for an oversized archive.
    return archiveMetadata(input);
  }
}

function newestFirst<T>(values: readonly T[], timestamp: (value: T) => number): T[] {
  return values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => timestamp(right.value) - timestamp(left.value) || right.index - left.index)
    .map(({ value }) => value);
}

function completedSummary(run: TaskRunRecord, refs: readonly ArchiveRef[]): CompletedRunSummary {
  const archives = refs
    .filter((ref) => ref.taskRunId === run.id)
    .map((ref) => ref.archiveId);
  return {
    taskRunId: run.id,
    title: run.title,
    status: run.status === "cancelled" ? "cancelled" : "completed",
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    groupCount: run.groups.length,
    taskCount: run.tasks.length,
    assignmentCount: run.assignments.length,
    assignmentArchiveIds: archives,
  };
}

/** Build all bounded manifest inputs without changing the runtime state. */
export function buildCheckpointProjection(
  state: TaskedSubagentsState,
  archives: readonly ArchiveRef[],
): ProjectionResult<CheckpointProjection> {
  const recoverable = state.taskRuns.filter((run) => RECOVERABLE_STATUSES.has(run.status));
  if (recoverable.length > MAX_RECOVERABLE_TASK_RUNS) {
    return limitError(`Checkpoint has more than ${MAX_RECOVERABLE_TASK_RUNS} recoverable TaskRuns`);
  }

  const projectedRuns: TaskRunRecord[] = [];
  for (const run of recoverable) {
    const projected = projectTaskRun(run);
    if (!projected.ok) return projected;
    projectedRuns.push(projected.value);
  }

  const newestArchives = newestFirst(archives, (archive) => archive.completedAt)
    .slice(0, MAX_RECENT_ASSIGNMENT_REFS);
  const recentAssignmentRefs = newestArchives.map(({ assignmentId, assignmentIdHash, archiveId, resultId }) => ({
    assignmentId,
    assignmentIdHash,
    archiveId,
    ...(resultId === undefined ? {} : { resultId }),
  }));
  // Restored terminal history is not rehydrated as a schedulable TaskRun.
  // Preserve it alongside newly completed live runs, with the latter taking
  // precedence when a run appears in both sources.
  const completedById = new Map<string, CompletedRunSummary>();
  for (const summary of state.completedHistory ?? []) {
    const { archives: _archives, ...restored } = summary;
    completedById.set(restored.taskRunId, restored);
  }
  for (const run of state.taskRuns) {
    if (COMPLETED_STATUSES.has(run.status)) completedById.set(run.id, completedSummary(run, newestArchives));
  }
  const completedRuns = newestFirst(
    [...completedById.values()],
    (summary) => summary.completedAt ?? summary.updatedAt,
  ).slice(0, MAX_RECENT_COMPLETED);
  // The active selection may deliberately inspect a completed run. Retain it
  // even when newer history would otherwise displace it from the bounded set.
  const selectedCompleted = state.currentTaskRunId === undefined ? undefined : completedById.get(state.currentTaskRunId);
  if (selectedCompleted && !completedRuns.some((summary) => summary.taskRunId === selectedCompleted.taskRunId)) {
    completedRuns[MAX_RECENT_COMPLETED - 1] = selectedCompleted;
  }

  return {
    ok: true,
    value: {
      ...(state.currentTaskRunId === undefined ? {} : { currentTaskRunId: state.currentTaskRunId }),
      updatedAt: state.updatedAt,
      recoverableRuns: projectedRuns,
      completedRuns,
      recentAssignmentRefs,
    },
  };
}

/** Build and validate the exact bounded checkpoint payload written by the store. */
export function buildCheckpointManifest(input: CheckpointManifestInput): ProjectionResult<CheckpointManifestV1> {
  const { projection, recoverableRuns } = input;
  if (recoverableRuns.length > MAX_RECOVERABLE_TASK_RUNS) {
    return limitError(`Checkpoint has more than ${MAX_RECOVERABLE_TASK_RUNS} recoverable TaskRuns`);
  }
  if (projection.completedRuns.length > MAX_RECENT_COMPLETED) {
    return limitError(`Checkpoint has more than ${MAX_RECENT_COMPLETED} completed summaries`);
  }
  if (projection.recentAssignmentRefs.length > MAX_RECENT_ASSIGNMENT_REFS) {
    return limitError(`Checkpoint has more than ${MAX_RECENT_ASSIGNMENT_REFS} assignment archive references`);
  }
  const manifest: CheckpointManifestV1 = {
    checkpointVersion: 1,
    sessionId: input.sessionId,
    sequence: input.sequence,
    ...(projection.currentTaskRunId === undefined ? {} : { currentTaskRunId: projection.currentTaskRunId }),
    recoverableRuns: [...recoverableRuns],
    recentCompleted: [...projection.completedRuns],
    recentAssignmentRefs: [...projection.recentAssignmentRefs],
    updatedAt: projection.updatedAt,
  };
  try {
    if (utf8Bytes({ storeVersion: 1, kind: "checkpoint", payload: manifest }) > MAX_CHECKPOINT_BYTES) {
      return limitError("Checkpoint exceeds the 256 KiB durable limit");
    }
  } catch {
    return limitError("Checkpoint cannot be serialized for durable persistence");
  }
  return { ok: true, value: manifest };
}

/** Assert an archive is safe to hand to an immutable object store. */
export function archiveSerializedBytes(archive: AssignmentArchiveV1): number {
  return Buffer.byteLength(canonicalJson({ storeVersion: 1, kind: "assignment", payload: archive }), "utf8");
}
