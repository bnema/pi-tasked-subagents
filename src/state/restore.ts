import {
  MAX_ASSIGNMENT_ARCHIVE_BYTES,
  MAX_CHECKPOINT_BYTES,
  MAX_POINTER_BYTES,
  MAX_RECENT_ASSIGNMENT_REFS,
  MAX_RECENT_COMPLETED,
  MAX_RECOVERABLE_TASK_RUNS,
  MAX_TASK_RUN_OBJECT_BYTES,
  STATE_POINTER_VERSION,
} from "../defaults.js";
import type { TaskRunRecord, TaskedSubagentsState } from "../types.js";
import {
  MAX_ARCHIVE_ARTIFACT_LABEL_BYTES,
  MAX_ARCHIVE_ARTIFACT_PATH_BYTES,
  MAX_ARCHIVE_ARTIFACTS,
  MAX_ARCHIVE_CRITERIA_EVIDENCE,
  MAX_ARCHIVE_CRITERION_EVIDENCE_BYTES,
  MAX_ARCHIVE_FOLLOW_UP_BYTES,
  MAX_ARCHIVE_FOLLOW_UPS,
  MAX_ARCHIVE_SUMMARY_BYTES,
} from "./durable-projection.js";
import { sha256Hex, utf8Bytes } from "./canonical-json.js";
import type {
  AssignmentArchiveV1,
  CheckpointManifestV1,
  CompletedRunSummary,
  RestoredCompletedHistoryV1,
  StatePointerV5,
} from "./durable-types.js";
import { DurableObjectStore } from "./object-store.js";
import type { SessionEntry } from "./persistence.js";
import { ensureState } from "./store.js";
import { migrateNewestV4State } from "./v4-migration.js";
import type { ArchiveRef } from "./durable-projection.js";

const DIGEST_ID = /^[a-f0-9]{64}$/;
const RECOVERABLE_STATUS = new Set(["pending", "running", "attention", "failed"]);
const TERMINAL_STATUS = new Set(["completed", "cancelled"]);
const TERMINAL_ASSIGNMENT_STATUS = new Set(["completed", "failed", "skipped", "cancelled"]);
const MAX_ARCHIVE_ID_BYTES = 8 * 1024;

export interface RestoreContext {
  sessionId: string;
  /** All session entries are retained for the subsequent v4 migration phase. */
  allEntries: readonly SessionEntry[];
  appendMigratedPointer(pointer: StatePointerV5): void;
}

export interface RestoreDiagnostic {
  code: "pointer_invalid" | "checkpoint_invalid" | "object_missing" | "object_invalid" | "migration_failed";
  message: string;
  checkpointId?: string;
  objectId?: string;
  quarantined?: boolean;
}

export type RestoreResult =
  | { restored: true; state: TaskedSubagentsState; pointer: StatePointerV5; archiveRefs: ArchiveRef[]; diagnostics: RestoreDiagnostic[]; migrated: boolean }
  | { restored: false; diagnostics: RestoreDiagnostic[]; hasV4Candidate: boolean };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseData(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function optionalSame(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function boundedString(value: unknown, maxBytes = MAX_ARCHIVE_ID_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

function pointerFromEntry(entry: SessionEntry): StatePointerV5 | undefined {
  if (entry.type !== "custom" || entry.customType !== "pi-tasked-subagents:state") return undefined;
  const data = parseData(entry.data);
  const input = record(data);
  if (!input || utf8Bytes(data) > MAX_POINTER_BYTES) return undefined;
  const currentTaskRunId = input.currentTaskRunId === undefined ? undefined : optionalString(input.currentTaskRunId);
  if (
    input.version !== STATE_POINTER_VERSION || !DIGEST_ID.test(String(input.checkpointId ?? "")) ||
    !safeInteger(input.sequence) || input.sequence < 0 || !safeInteger(input.writtenAt) ||
    (input.currentTaskRunId !== undefined && currentTaskRunId === undefined)
  ) return undefined;
  return {
    version: 5,
    checkpointId: input.checkpointId as string,
    ...(currentTaskRunId === undefined ? {} : { currentTaskRunId }),
    sequence: input.sequence,
    writtenAt: input.writtenAt,
  };
}

function isV4Entry(entry: SessionEntry): boolean {
  if (entry.type !== "custom" || entry.customType !== "pi-tasked-subagents:state") return false;
  return record(parseData(entry.data))?.version === 4;
}

function validCompletedSummary(value: unknown): value is CompletedRunSummary {
  const input = record(value);
  return Boolean(input && optionalString(input.taskRunId) && optionalString(input.title) &&
    typeof input.status === "string" && TERMINAL_STATUS.has(input.status) &&
    safeInteger(input.createdAt) && safeInteger(input.updatedAt) &&
    (input.completedAt === undefined || safeInteger(input.completedAt)) &&
    safeInteger(input.groupCount) && input.groupCount >= 0 && safeInteger(input.taskCount) && input.taskCount >= 0 &&
    safeInteger(input.assignmentCount) && input.assignmentCount >= 0 &&
    Array.isArray(input.assignmentArchiveIds) && input.assignmentArchiveIds.every((id) => typeof id === "string" && DIGEST_ID.test(id)));
}

function validateManifest(value: unknown, sessionId: string): value is CheckpointManifestV1 {
  const input = record(value);
  if (!input || input.checkpointVersion !== 1 || input.sessionId !== sessionId || !safeInteger(input.sequence) || input.sequence < 0 ||
    !safeInteger(input.updatedAt) || !Array.isArray(input.recoverableRuns) || !Array.isArray(input.recentCompleted) ||
    !Array.isArray(input.recentAssignmentRefs) || input.recoverableRuns.length > MAX_RECOVERABLE_TASK_RUNS ||
    input.recentCompleted.length > MAX_RECENT_COMPLETED || input.recentAssignmentRefs.length > MAX_RECENT_ASSIGNMENT_REFS) return false;
  const currentTaskRunId = input.currentTaskRunId;
  if (currentTaskRunId !== undefined && !optionalString(currentTaskRunId)) return false;
  const runIds = new Set<string>();
  for (const run of input.recoverableRuns) {
    const ref = record(run);
    if (!ref || !optionalString(ref.taskRunId) || runIds.has(ref.taskRunId as string) || typeof ref.status !== "string" ||
      !RECOVERABLE_STATUS.has(ref.status) || !DIGEST_ID.test(String(ref.objectId ?? "")) || !safeInteger(ref.updatedAt)) return false;
    runIds.add(ref.taskRunId as string);
  }
  if (!input.recentCompleted.every(validCompletedSummary)) return false;
  const completedIds = new Set(input.recentCompleted.map((summary) => (summary as CompletedRunSummary).taskRunId));
  if (currentTaskRunId !== undefined && !runIds.has(currentTaskRunId as string) && !completedIds.has(currentTaskRunId as string)) return false;
  const archiveIds = new Set<string>();
  for (const ref of input.recentAssignmentRefs) {
    const item = record(ref);
    if (!item || !exactKeys(item, ["assignmentId", "assignmentIdHash", "archiveId", "resultId"]) || !boundedString(item.assignmentId) ||
      !DIGEST_ID.test(String(item.assignmentIdHash ?? "")) || sha256Hex(item.assignmentId as string) !== item.assignmentIdHash ||
      !DIGEST_ID.test(String(item.archiveId ?? "")) || (item.resultId !== undefined && !boundedString(item.resultId)) ||
      archiveIds.has(item.archiveId as string)) return false;
    archiveIds.add(item.archiveId as string);
  }
  return true;
}

function validArchiveArtifact(value: unknown, archive: Record<string, unknown>): boolean {
  const input = record(value);
  return Boolean(input && exactKeys(input, ["label", "path", "assignmentId", "taskRunId", "groupId", "taskId"]) &&
    boundedString(input.label, MAX_ARCHIVE_ARTIFACT_LABEL_BYTES) && boundedString(input.path, MAX_ARCHIVE_ARTIFACT_PATH_BYTES) &&
    input.assignmentId === archive.assignmentId && input.taskRunId === archive.taskRunId && input.taskId === archive.taskId &&
    input.groupId === archive.groupId);
}

function validArchiveEvidence(value: unknown): boolean {
  const input = record(value);
  return Boolean(input && exactKeys(input, ["criteriaIndex", "criterionId", "evidence"]) &&
    safeInteger(input.criteriaIndex) && input.criteriaIndex >= 0 &&
    boundedString(input.criterionId, MAX_ARCHIVE_CRITERION_EVIDENCE_BYTES) && boundedString(input.evidence, MAX_ARCHIVE_CRITERION_EVIDENCE_BYTES));
}

function validArchive(archive: unknown, assignmentId?: string, resultId?: string): archive is AssignmentArchiveV1 {
  const input = record(archive);
  const identityKeys = ["assignmentId", "taskRunId", "groupId", "taskId", "status", "runId", "resultId", "resultUnavailableReason", "completedAt"];
  if (!input || !boundedString(input.assignmentId) || !boundedString(input.taskRunId) || !boundedString(input.taskId) ||
    !boundedString(input.runId) || typeof input.status !== "string" || !TERMINAL_ASSIGNMENT_STATUS.has(input.status) ||
    !safeInteger(input.completedAt) || input.completedAt < 0 ||
    (input.groupId !== undefined && !boundedString(input.groupId)) ||
    (input.resultId !== undefined && !boundedString(input.resultId)) ||
    (input.resultUnavailableReason !== undefined && input.resultUnavailableReason !== "missing-legacy-result") ||
    ((input.resultId === undefined) === (input.resultUnavailableReason === undefined)) ||
    (assignmentId !== undefined && !optionalSame(assignmentId, input.assignmentId as string)) ||
    (resultId !== undefined && input.resultId !== resultId)) return false;
  if (input.detailOmitted === true) return exactKeys(input, [...identityKeys, "detailOmitted"]);
  if (!exactKeys(input, [...identityKeys, "summary", "criteriaEvidence", "artifacts", "followUps"]) ||
    !boundedString(input.summary, MAX_ARCHIVE_SUMMARY_BYTES) || !Array.isArray(input.criteriaEvidence) ||
    input.criteriaEvidence.length > MAX_ARCHIVE_CRITERIA_EVIDENCE || !input.criteriaEvidence.every(validArchiveEvidence) ||
    !Array.isArray(input.artifacts) || input.artifacts.length > MAX_ARCHIVE_ARTIFACTS || !input.artifacts.every((item) => validArchiveArtifact(item, input)) ||
    !Array.isArray(input.followUps) || input.followUps.length > MAX_ARCHIVE_FOLLOW_UPS ||
    !input.followUps.every((item) => boundedString(item, MAX_ARCHIVE_FOLLOW_UP_BYTES))) return false;
  return true;
}

function validateTaskRunGraph(run: TaskRunRecord): boolean {
  try {
    const candidate: TaskedSubagentsState = { version: 4, taskRuns: [run], currentTaskRunId: run.id, updatedAt: run.updatedAt };
    const normalized = ensureState(candidate).taskRuns[0];
    // The existing state validator establishes scalar/type validity. Its repair
    // behavior is acceptable only when it did not discard any graph member.
    if (!normalized || normalized.id !== run.id || normalized.title !== run.title || normalized.request !== run.request ||
      normalized.context !== run.context || normalized.status !== run.status || normalized.groups.length !== run.groups.length ||
      normalized.tasks.length !== run.tasks.length || normalized.assignments.length !== run.assignments.length ||
      normalized.artifacts.length !== run.artifacts.length) return false;
    if (normalized.groups.some((group, index) => group.id !== run.groups[index]?.id || group.title !== run.groups[index]?.title ||
      group.status !== run.groups[index]?.status || group.createdAt !== run.groups[index]?.createdAt || group.updatedAt !== run.groups[index]?.updatedAt)) return false;
    if (normalized.tasks.some((task, index) => task.id !== run.tasks[index]?.id || task.groupId !== run.tasks[index]?.groupId ||
      task.text !== run.tasks[index]?.text || task.status !== run.tasks[index]?.status || task.criteria.length !== run.tasks[index]?.criteria.length ||
      task.criteria.some((criterion, criterionIndex) => criterion.id !== run.tasks[index]?.criteria[criterionIndex]?.id ||
        criterion.text !== run.tasks[index]?.criteria[criterionIndex]?.text || criterion.satisfied !== run.tasks[index]?.criteria[criterionIndex]?.satisfied ||
        criterion.evidence.length !== run.tasks[index]?.criteria[criterionIndex]?.evidence.length))) return false;
    if (normalized.assignments.some((assignment, index) => assignment.id !== run.assignments[index]?.id ||
      assignment.taskRunId !== run.assignments[index]?.taskRunId || assignment.taskId !== run.assignments[index]?.taskId ||
      assignment.groupId !== run.assignments[index]?.groupId || assignment.agent !== run.assignments[index]?.agent ||
      assignment.prompt !== run.assignments[index]?.prompt || assignment.status !== run.assignments[index]?.status)) return false;

    const groupIds = new Set(run.groups.map((group) => group.id));
    const taskIds = new Set(run.tasks.map((task) => task.id));
    const assignments = new Map(run.assignments.map((assignment) => [assignment.id, assignment]));
    if (groupIds.size !== run.groups.length || taskIds.size !== run.tasks.length || assignments.size !== run.assignments.length) return false;
    for (const task of run.tasks) {
      if ((task.groupId !== undefined && !groupIds.has(task.groupId)) || task.assignmentIds.some((id) => !assignments.has(id))) return false;
      if (task.criteria.some((criterion) => criterion.evidence.some((evidence) => !assignments.has(evidence.assignmentId)))) return false;
    }
    for (const assignment of run.assignments) {
      if (assignment.taskRunId !== run.id || !taskIds.has(assignment.taskId) ||
        (assignment.groupId !== undefined && !groupIds.has(assignment.groupId))) return false;
    }
    return run.artifacts.every((artifact) => artifact.taskRunId === run.id && assignments.has(artifact.assignmentId) &&
      taskIds.has(artifact.taskId) && (artifact.groupId === undefined || groupIds.has(artifact.groupId)));
  } catch {
    return false;
  }
}

function missing(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as NodeJS.ErrnoException).code === "ENOENT") return true;
    current = current.cause;
  }
  return false;
}

async function diagnosticForObject(
  diagnostics: RestoreDiagnostic[],
  store: DurableObjectStore,
  checkpointId: string,
  objectId: string,
  error: unknown,
): Promise<void> {
  const absent = missing(error);
  let quarantined = false;
  if (!absent) {
    try {
      await store.quarantine(objectId, "restore validation failed");
      quarantined = true;
    } catch {
      // The original validation error remains authoritative; quarantining is best effort.
    }
  }
  diagnostics.push({
    code: absent ? "object_missing" : "object_invalid",
    message: absent ? "A required durable object is missing" : "A durable object failed validation",
    checkpointId,
    objectId,
    ...(quarantined ? { quarantined } : {}),
  });
}

class RestoreObjectError extends Error {
  constructor(readonly objectId: string, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

async function requiredObject<T>(
  store: DurableObjectStore,
  objectId: string,
  kind: "checkpoint" | "task-run" | "assignment",
  maxBytes: number,
): Promise<T> {
  try {
    return await store.get<T>(objectId, kind, maxBytes);
  } catch (error) {
    throw new RestoreObjectError(objectId, "Required durable object could not be read", { cause: error });
  }
}

async function restorePointer(pointer: StatePointerV5, store: DurableObjectStore, sessionId: string): Promise<{ state: TaskedSubagentsState; archiveRefs: ArchiveRef[] }> {
  const manifest = await requiredObject<CheckpointManifestV1>(store, pointer.checkpointId, "checkpoint", MAX_CHECKPOINT_BYTES);
  if (!validateManifest(manifest, sessionId) || manifest.sequence !== pointer.sequence ||
    !optionalSame(manifest.currentTaskRunId, pointer.currentTaskRunId)) throw new Error("Checkpoint manifest is invalid");

  const runs: TaskRunRecord[] = [];
  for (const ref of manifest.recoverableRuns) {
    const run = await requiredObject<TaskRunRecord>(store, ref.objectId, "task-run", MAX_TASK_RUN_OBJECT_BYTES);
    if (run.id !== ref.taskRunId || run.status !== ref.status || run.updatedAt !== ref.updatedAt || !validateTaskRunGraph(run)) {
      throw new Error(`Invalid task-run object:${ref.objectId}`);
    }
    runs.push(run);
  }

  const archives = new Map<string, { assignmentId?: string; assignmentIdHash?: string; resultId?: string; summaryTaskRunId?: string }>();
  for (const ref of manifest.recentAssignmentRefs) {
    archives.set(ref.archiveId, { assignmentId: ref.assignmentId, assignmentIdHash: ref.assignmentIdHash, ...(ref.resultId === undefined ? {} : { resultId: ref.resultId }) });
  }
  for (const summary of manifest.recentCompleted) {
    for (const archiveId of summary.assignmentArchiveIds) {
      const existing = archives.get(archiveId);
      if (existing?.summaryTaskRunId && existing.summaryTaskRunId !== summary.taskRunId) throw new Error(`Invalid assignment object:${archiveId}`);
      archives.set(archiveId, { ...existing, summaryTaskRunId: summary.taskRunId });
    }
  }
  const archiveRefs: ArchiveRef[] = [];
  const restoredArchives = new Map<string, AssignmentArchiveV1 & { archiveId: string }>();
  for (const [archiveId, reference] of archives) {
    const archive = await requiredObject<AssignmentArchiveV1>(store, archiveId, "assignment", MAX_ASSIGNMENT_ARCHIVE_BYTES);
    if (!validArchive(archive, reference.assignmentId, reference.resultId) ||
      (reference.summaryTaskRunId !== undefined && archive.taskRunId !== reference.summaryTaskRunId)) {
      throw new Error(`Invalid assignment object:${archiveId}`);
    }
    restoredArchives.set(archiveId, { ...archive, archiveId });
    archiveRefs.push({
      assignmentId: archive.assignmentId,
      assignmentIdHash: reference.assignmentIdHash ?? sha256Hex(archive.assignmentId),
      archiveId,
      ...(archive.resultId === undefined ? {} : { resultId: archive.resultId }),
      taskRunId: archive.taskRunId,
      completedAt: archive.completedAt,
    });
  }

  const completedHistory: RestoredCompletedHistoryV1[] = manifest.recentCompleted.map((summary) => ({
    ...summary,
    archives: summary.assignmentArchiveIds.map((archiveId) => restoredArchives.get(archiveId)).filter((archive): archive is AssignmentArchiveV1 & { archiveId: string } => Boolean(archive)),
  }));
  return {
    state: {
      version: 4,
      taskRuns: runs,
      ...(completedHistory.length === 0 ? {} : { completedHistory }),
      ...(manifest.currentTaskRunId === undefined ? {} : { currentTaskRunId: manifest.currentTaskRunId }),
      updatedAt: manifest.updatedAt,
    },
    archiveRefs,
  };
}

/**
 * Select the newest fully valid v5 graph from one Pi branch. A graph is never
 * composed from separate checkpoints: any failed reference rejects its pointer.
 */
export async function restoreBranchState(
  branchEntries: readonly SessionEntry[],
  store: DurableObjectStore,
  context: RestoreContext,
): Promise<RestoreResult> {
  const diagnostics: RestoreDiagnostic[] = [];
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry.type !== "custom" || entry.customType !== "pi-tasked-subagents:state") continue;
    const pointer = pointerFromEntry(entry);
    if (!pointer) {
      const raw = parseData(entry.data);
      if (record(raw)?.version === 5) diagnostics.push({ code: "pointer_invalid", message: "A v5 checkpoint pointer is malformed or exceeds its limit" });
      continue;
    }
    try {
      const restored = await restorePointer(pointer, store, context.sessionId);
      return { restored: true, state: restored.state, pointer, archiveRefs: restored.archiveRefs, diagnostics, migrated: false };
    } catch (error) {
      const text = error instanceof Error ? error.message : "";
      const objectId = error instanceof RestoreObjectError
        ? error.objectId
        : text.startsWith("Invalid task-run object:") || text.startsWith("Invalid assignment object:")
          ? text.slice(text.indexOf(":") + 1)
          : pointer.checkpointId;
      await diagnosticForObject(diagnostics, store, pointer.checkpointId, objectId, error);
    }
  }
  const migration = await migrateNewestV4State(branchEntries, store, {
    sessionId: context.sessionId,
    appendMigratedPointer: context.appendMigratedPointer,
  });
  if (migration.migrated) {
    return {
      restored: true,
      state: migration.state,
      pointer: migration.pointer,
      archiveRefs: migration.archiveRefs,
      diagnostics,
      migrated: true,
    };
  }
  const hasV4Candidate = [...branchEntries, ...context.allEntries].some(isV4Entry);
  if (hasV4Candidate && migration.reason !== "no_valid_v4") {
    diagnostics.push({ code: "migration_failed", message: migration.message });
  }
  return { restored: false, diagnostics, hasV4Candidate };
}
