import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  MAX_ASSIGNMENT_ARCHIVE_BYTES,
  MAX_CHECKPOINT_BYTES,
  MAX_POINTER_BYTES,
  MAX_TASK_RUN_OBJECT_BYTES,
} from "../defaults.js";
import type { AssignmentStatus, TaskAssignmentRecord, TaskRunRecord, TaskedSubagentsState } from "../types.js";
import { sha256Hex, utf8Bytes } from "./canonical-json.js";
import type { StatePointerV5 } from "./durable-types.js";
import {
  buildCheckpointManifest,
  buildCheckpointProjection,
  projectAssignmentArchive,
  type ArchiveRef,
} from "./durable-projection.js";
import { DurableObjectStore } from "./object-store.js";
import type { SessionEntry } from "./persistence.js";
import { ensureState } from "./store.js";
import { sessionStoragePaths, type SessionStoragePaths } from "./storage-paths.js";
import { openPinnedDirectory, safeBasename } from "./pinned-directory.mjs";

const TERMINAL_ASSIGNMENT_STATUSES = new Set<AssignmentStatus>(["completed", "failed", "cancelled", "skipped"]);
const ACTIVE_HANDLE_STATUSES = new Set<AssignmentStatus>(["running", "blocked", "paused"]);
const RUN_STATUSES = new Set(["pending", "running", "attention", "completed", "failed", "cancelled"]);
const GROUP_AND_TASK_STATUSES = new Set(["pending", "ready", "running", "blocked", "attention", "completed", "failed", "cancelled"]);
const ASSIGNMENT_STATUSES = new Set(["queued", "running", "blocked", "attention", "completed", "failed", "cancelled", "paused", "skipped"]);
const REPORT_STATUSES = new Set(["completed", "attention", "failed"]);
const DIGEST_ID = /^[a-f0-9]{64}$/;
/** Legacy runner status is advisory metadata, not an unbounded migration input. */
const MAX_LEGACY_STATUS_BYTES = 64 * 1024;

export interface V4MigrationContext {
  sessionId: string;
  appendMigratedPointer(pointer: StatePointerV5): void;
  now?: number;
  /** Sequence follows every pointer visible on the selected branch. */
  sequence?: number;
}

export type V4MigrationResult =
  | { migrated: true; state: TaskedSubagentsState; pointer: StatePointerV5; archiveRefs: ArchiveRef[] }
  | { migrated: false; reason: "no_valid_v4" | "limit_exceeded" | "write_failed"; message: string };

function missingResult(): { unavailable: "missing-legacy-result" } {
  return { unavailable: "missing-legacy-result" };
}

async function digestOpenFile(handle: fs.FileHandle): Promise<string> {
  const stat = await handle.stat();
  if (!stat.isFile()) throw new Error("Durable result is not a regular file");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

/**
 * Copy a legacy result in bounded chunks and install it under its full content
 * digest. A pre-existing destination is accepted only after digest validation.
 */
export async function ingestLegacyResult(
  sourcePath: string,
  destination: SessionStoragePaths,
  options: { beforeMutation?: (operation: "ingest-legacy-result" | "install-legacy-result") => Promise<void> | void } = {},
): Promise<{ resultId: string } | { unavailable: "missing-legacy-result" }> {
  let source: fs.FileHandle | undefined;
  let temporary: fs.FileHandle | undefined;
  let destinationDirectory: Awaited<ReturnType<typeof openPinnedDirectory>> | undefined;
  let temporaryName: string | undefined;
  try {
    try {
      source = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await source.stat()).isFile()) return missingResult();
    } catch {
      return missingResult();
    }

    destinationDirectory = await openPinnedDirectory(destination.root, destination.resultsDir);
    await options.beforeMutation?.("ingest-legacy-result");
    temporaryName = safeBasename(`.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
    temporary = await destinationDirectory.openFile(temporaryName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await temporary.writeFile(chunk);
      position += bytesRead;
    }
    await temporary.sync();
    await temporary.close();
    temporary = undefined;
    await source.close();
    source = undefined;

    const resultId = hash.digest("hex");
    const finalName = safeBasename(`${resultId}.json`);
    try {
      // link(2) is the no-replace winner gate, through the still-open dirfd.
      await options.beforeMutation?.("install-legacy-result");
      await destinationDirectory.link(temporaryName, destinationDirectory, finalName);
      await destinationDirectory.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await destinationDirectory.openFile(finalName, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (await digestOpenFile(existing) !== resultId) {
          throw new Error("Existing durable result digest mismatch", { cause: error });
        }
      } finally {
        await existing.close();
      }
    }
    return { resultId };
  } finally {
    await source?.close();
    await temporary?.close();
    if (temporaryName && destinationDirectory) await destinationDirectory.unlink(temporaryName).catch(() => undefined);
    await destinationDirectory?.close();
  }
}

function legacyResultPath(assignment: TaskAssignmentRecord): string | undefined {
  return assignment.result?.rawResultPath ?? assignment.launchRef?.resultPath;
}

const SAFE_LEGACY_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LIVE_LEGACY_STATES = new Set(["queued", "running"]);

type MigratedLegacyHandle = Extract<NonNullable<TaskAssignmentRecord["launchRef"]>, { legacy: true }>;

function isLivePid(value: unknown): boolean {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    // A process we cannot signal is still live; all other failures mean this
    // legacy status file cannot establish an actionable runner.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function explicitLegacyHandle(assignment: TaskAssignmentRecord): MigratedLegacyHandle | undefined {
  const handle = assignment.launchRef;
  if (!handle || !assignment.runId || !SAFE_LEGACY_RUN_ID.test(assignment.runId) ||
    handle.runId !== assignment.runId || !SAFE_LEGACY_RUN_ID.test(handle.runId) ||
    !handle.asyncId || !Array.isArray(handle.assignments) || !handle.asyncDir || !isAbsolute(handle.asyncDir)) return undefined;
  const ownHandle = handle.assignments.find((candidate) => candidate.assignmentId === assignment.id);
  if (!ownHandle || ownHandle.runId !== handle.runId ||
    handle.assignments.some((candidate) => !candidate.assignmentId || candidate.runId !== handle.runId)) return undefined;
  // Do not treat a v4 handle as a v5 identity just because it happened to
  // contain similarly named fields. This is a narrowly scoped compatibility
  // handle retained only so restored work can be reconciled; unrelated legacy
  // session and artifact paths are deliberately not carried across.
  return {
    legacy: true,
    runId: handle.runId,
    asyncId: handle.asyncId,
    asyncDir: handle.asyncDir,
    ...(handle.resultPath === undefined ? {} : { resultPath: handle.resultPath }),
    assignments: handle.assignments.map((candidate) => ({
      assignmentId: candidate.assignmentId,
      runId: candidate.runId,
    })),
  };
}

async function hasLiveLegacyStatus(handle: MigratedLegacyHandle): Promise<boolean> {
  const asyncDir = resolve(handle.asyncDir!);
  const statusPath = resolve(asyncDir, "status.json");
  // The locator is an explicit directory plus its direct status file. Reject
  // traversal, symlinks, and arbitrary neighboring files before parsing data.
  if (relative(asyncDir, statusPath) !== "status.json") return false;
  try {
    const directory = await fs.lstat(asyncDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    const status = await fs.open(statusPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      const statusInfo = await status.stat();
      if (!statusInfo.isFile() || statusInfo.size > MAX_LEGACY_STATUS_BYTES) return false;
      raw = await status.readFile({ encoding: "utf8" });
    } finally {
      await status.close();
    }
    // realpath establishes that status.json remains directly contained after
    // resolving any existing path components.
    if (dirname(await fs.realpath(statusPath)) !== await fs.realpath(asyncDir)) return false;
    const parsed = JSON.parse(raw) as { runId?: unknown; state?: unknown; pid?: unknown; steps?: unknown };
    if (parsed.runId !== handle.runId || !LIVE_LEGACY_STATES.has(String(parsed.state))) return false;
    const stepPids = Array.isArray(parsed.steps)
      ? parsed.steps.filter((step): step is { id?: unknown; status?: unknown; pid?: unknown } => typeof step === "object" && step !== null)
        .filter((step) => handle.assignments.some((assignment) => assignment.assignmentId === step.id) && LIVE_LEGACY_STATES.has(String(step.status)))
        .map((step) => step.pid)
      : [];
    return [parsed.pid, ...stepPids].some(isLivePid);
  } catch {
    return false;
  }
}

async function hasTerminalLegacyResult(handle: MigratedLegacyHandle): Promise<boolean> {
  if (!handle.resultPath || !isAbsolute(handle.resultPath)) return false;
  try {
    const result = await fs.open(handle.resultPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return (await result.stat()).isFile();
    } finally {
      await result.close();
    }
  } catch {
    return false;
  }
}

async function activeHandleIsAvailable(assignment: TaskAssignmentRecord): Promise<MigratedLegacyHandle | undefined> {
  const handle = explicitLegacyHandle(assignment);
  if (!handle) return undefined;
  // A published terminal result is independently reconcilable. Live runners,
  // however, must establish liveness from their contained status locator; a
  // not-yet-published result must never turn a live run into attention.
  return await hasLiveLegacyStatus(handle) || await hasTerminalLegacyResult(handle) ? handle : undefined;
}

function moveMissingActiveHandleToAttention(run: TaskRunRecord, assignment: TaskAssignmentRecord, now: number): void {
  assignment.status = "attention";
  assignment.updatedAt = now;
  delete assignment.completedAt;
  assignment.result = {
    assignmentId: assignment.id,
    status: "attention",
    summary: "Legacy active runner cannot be reconciled because its handle or result is unavailable",
    criteriaEvidence: [],
    artifacts: [],
    followUps: ["Reattach or resolve this assignment before continuing."],
    createdAt: now,
  };
  const task = run.tasks.find((candidate) => candidate.id === assignment.taskId);
  if (task) {
    task.status = "attention";
    task.updatedAt = now;
    delete task.completedAt;
  }
  const group = assignment.groupId === undefined ? undefined : run.groups.find((candidate) => candidate.id === assignment.groupId);
  if (group) {
    group.status = "attention";
    group.updatedAt = now;
    delete group.completedAt;
  }
  run.status = "attention";
  run.updatedAt = now;
  delete run.completedAt;
}

function compactCompletedRun(run: TaskRunRecord): TaskRunRecord {
  return {
    id: run.id,
    title: run.title,
    request: "",
    context: "",
    status: run.status,
    groups: [],
    tasks: [],
    assignments: [],
    artifacts: [],
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
  };
}

async function archiveTerminalAssignments(
  state: TaskedSubagentsState,
  store: DurableObjectStore,
  context: V4MigrationContext,
): Promise<ArchiveRef[]> {
  const refs: ArchiveRef[] = [];
  for (const run of state.taskRuns) {
    for (const assignment of run.assignments) {
      if (!TERMINAL_ASSIGNMENT_STATUSES.has(assignment.status)) continue;
      const source = legacyResultPath(assignment);
      const ingested = source ? await ingestLegacyResult(source, migrationSessionPaths(store, context.sessionId)) : missingResult();
      const archive = projectAssignmentArchive({
        assignmentId: assignment.id,
        taskRunId: run.id,
        ...(assignment.groupId === undefined ? {} : { groupId: assignment.groupId }),
        taskId: assignment.taskId,
        status: assignment.status as "completed" | "failed" | "cancelled" | "skipped",
        summary: assignment.result?.summary ?? "",
        criteriaEvidence: assignment.result?.criteriaEvidence ?? [],
        artifacts: assignment.result?.artifacts ?? run.artifacts.filter((artifact) => artifact.assignmentId === assignment.id),
        followUps: assignment.result?.followUps ?? [],
        runId: assignment.runId ?? "legacy-unknown",
        ...("resultId" in ingested ? { resultId: ingested.resultId } : { resultUnavailableReason: "missing-legacy-result" as const }),
        completedAt: assignment.completedAt ?? assignment.updatedAt,
      });
      const archiveId = await store.put("assignment", archive, MAX_ASSIGNMENT_ARCHIVE_BYTES);
      await store.linkAssignmentArchive(context.sessionId, assignment.id, archiveId);
      refs.push({
        assignmentId: assignment.id,
        assignmentIdHash: sha256Hex(assignment.id),
        archiveId,
        ...("resultId" in ingested ? { resultId: ingested.resultId } : {}),
        taskRunId: run.id,
        completedAt: archive.completedAt,
      });
    }
  }
  return refs;
}

function migrationSessionPaths(store: DurableObjectStore, sessionId: string): SessionStoragePaths {
  // All result path construction goes through the same session-ID validation
  // as new launches.
  return sessionStoragePaths(store.root, sessionId);
}

/** Convert one already-loaded v4 state into exactly one bounded v5 pointer. */
export async function migrateV4State(
  input: TaskedSubagentsState,
  store: DurableObjectStore,
  context: V4MigrationContext,
): Promise<V4MigrationResult> {
  const sequence = context.sequence ?? 1;
  // A migration must reserve a strictly newer sequence. MAX_SAFE_INTEGER
  // cannot be advanced without losing integer precision on the next write.
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) {
    return { migrated: false, reason: "limit_exceeded", message: "Checkpoint sequence space is exhausted" };
  }
  const state = structuredClone(input);
  const now = context.now ?? Date.now();
  for (const run of state.taskRuns) {
    for (const assignment of run.assignments) {
      if (!ACTIVE_HANDLE_STATUSES.has(assignment.status)) continue;
      const legacyHandle = await activeHandleIsAvailable(assignment);
      if (!legacyHandle) {
        moveMissingActiveHandleToAttention(run, assignment, now);
      } else {
        assignment.launchRef = legacyHandle;
      }
    }
  }

  // Validate recoverable state before creating archive objects, so an active
  // oversized run is rejected rather than partially migrated or truncated.
  const preflight = buildCheckpointProjection(state, []);
  if (!preflight.ok) return { migrated: false, reason: "limit_exceeded", message: preflight.error.message };

  try {
    const archiveRefs = await archiveTerminalAssignments(state, store, context);
    const projected = buildCheckpointProjection(state, archiveRefs);
    if (!projected.ok) return { migrated: false, reason: "limit_exceeded", message: projected.error.message };
    const recoverableRuns = [];
    for (const run of projected.value.recoverableRuns) {
      recoverableRuns.push({
        taskRunId: run.id,
        status: run.status as "pending" | "running" | "attention" | "failed",
        objectId: await store.put("task-run", run, MAX_TASK_RUN_OBJECT_BYTES),
        updatedAt: run.updatedAt,
      });
    }
    const manifest = buildCheckpointManifest({
      sessionId: context.sessionId,
      sequence,
      recoverableRuns,
      projection: {
        currentTaskRunId: projected.value.currentTaskRunId,
        updatedAt: projected.value.updatedAt,
        completedRuns: projected.value.completedRuns,
        recentAssignmentRefs: projected.value.recentAssignmentRefs,
      },
    });
    if (!manifest.ok) return { migrated: false, reason: "limit_exceeded", message: manifest.error.message };
    const checkpointId = await store.put("checkpoint", manifest.value, MAX_CHECKPOINT_BYTES);
    const pointer: StatePointerV5 = {
      version: 5,
      checkpointId,
      ...(state.currentTaskRunId === undefined ? {} : { currentTaskRunId: state.currentTaskRunId }),
      sequence,
      writtenAt: now,
    };
    if (utf8Bytes(pointer) > MAX_POINTER_BYTES) {
      return { migrated: false, reason: "limit_exceeded", message: "Checkpoint pointer exceeds the 4 KiB limit" };
    }
    context.appendMigratedPointer(pointer);
    return {
      migrated: true,
      pointer,
      archiveRefs,
      state: {
        version: 4,
        taskRuns: [
          ...projected.value.recoverableRuns,
          ...state.taskRuns
            .filter((run) => run.status === "completed" || run.status === "cancelled")
            .sort((left, right) => (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt))
            .slice(0, 20)
            .map(compactCompletedRun),
        ],
        ...(state.currentTaskRunId === undefined ? {} : { currentTaskRunId: state.currentTaskRunId }),
        updatedAt: state.updatedAt,
      },
    };
  } catch {
    return { migrated: false, reason: "write_failed", message: "Unable to write bounded migrated state" };
  }
}

function validV5Pointer(value: unknown): value is StatePointerV5 {
  const input = record(value);
  if (!input) return false;
  try {
    return input.version === 5 && DIGEST_ID.test(String(input.checkpointId ?? "")) &&
      Number.isSafeInteger(input.sequence) && (input.sequence as number) >= 0 &&
      Number.isSafeInteger(input.writtenAt) &&
      (input.currentTaskRunId === undefined || nonEmptyString(input.currentTaskRunId)) &&
      utf8Bytes(value) <= MAX_POINTER_BYTES;
  } catch {
    return false;
  }
}

function rawV4(entry: SessionEntry): unknown | undefined {
  if (entry.type !== "custom" || entry.customType !== "pi-tasked-subagents:state") return undefined;
  try {
    const value = typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data;
    return typeof value === "object" && value !== null && (value as { version?: unknown }).version === 4 ? value : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasOptionalString(input: Record<string, unknown>, key: string): boolean {
  return input[key] === undefined || nonEmptyString(input[key]);
}

function hasOptionalTimestamp(input: Record<string, unknown>, key: string): boolean {
  return input[key] === undefined || finiteNumber(input[key]);
}

function strictStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString) && new Set(value).size === value.length;
}

function strictLaunchRef(value: unknown, assignmentId: string): boolean {
  const input = record(value);
  if (!input || !nonEmptyString(input.runId) || !nonEmptyString(input.asyncId) || !Array.isArray(input.assignments) ||
    !hasOptionalString(input, "asyncDir") || !hasOptionalString(input, "sessionFile") || !hasOptionalString(input, "artifactPath") ||
    !hasOptionalString(input, "resultId") || !hasOptionalString(input, "resultPath") || !hasOptionalString(input, "resultReservationPath") ||
    (input.legacy !== undefined && typeof input.legacy !== "boolean")) return false;
  const handles = input.assignments.map(record);
  return handles.every((handle) => Boolean(handle && nonEmptyString(handle.assignmentId) && nonEmptyString(handle.runId) &&
    handle.runId === input.runId && hasOptionalString(handle, "resultPath"))) &&
    new Set(handles.map((handle) => handle?.assignmentId)).size === handles.length &&
    handles.some((handle) => handle?.assignmentId === assignmentId);
}

function strictResult(value: unknown, assignmentId: string): boolean {
  if (value === undefined) return true;
  const input = record(value);
  if (!input || input.assignmentId !== assignmentId || !REPORT_STATUSES.has(String(input.status)) || !nonEmptyString(input.summary) ||
    !Array.isArray(input.criteriaEvidence) || !Array.isArray(input.artifacts) || !strictStringList(input.followUps) ||
    !hasOptionalString(input, "rawResultPath") || !finiteNumber(input.createdAt)) return false;
  return input.criteriaEvidence.every((item) => {
    const evidence = record(item);
    return Boolean(evidence && Number.isInteger(evidence.criteriaIndex) && nonEmptyString(evidence.criterionId) && nonEmptyString(evidence.evidence));
  });
}

/**
 * v4's normalizer is intentionally forgiving for interactive state. Migration
 * is a durability boundary, so only accept candidates that already contain a
 * complete, typed graph; do not let normalization invent IDs, statuses, or
 * references for a checkpoint.
 */
function losslessV4Graph(raw: unknown, normalized: TaskedSubagentsState): boolean {
  const input = record(raw);
  if (!input || !Array.isArray(input.taskRuns) || input.taskRuns.length !== normalized.taskRuns.length ||
    !finiteNumber(input.updatedAt) || (input.currentTaskRunId !== undefined && !nonEmptyString(input.currentTaskRunId))) return false;
  const rawRuns = input.taskRuns.map(record);
  if (rawRuns.some((run) => !run)) return false;

  for (let runIndex = 0; runIndex < rawRuns.length; runIndex += 1) {
    const rawRun = rawRuns[runIndex]!;
    const run = normalized.taskRuns[runIndex];
    if (!run || rawRun.id !== run.id || rawRun.title !== run.title || rawRun.request !== run.request || rawRun.context !== run.context || rawRun.status !== run.status ||
      !nonEmptyString(rawRun.id) || !nonEmptyString(rawRun.title) || !nonEmptyString(rawRun.request) || !nonEmptyString(rawRun.context) || !RUN_STATUSES.has(String(rawRun.status)) ||
      !Array.isArray(rawRun.groups) || !Array.isArray(rawRun.tasks) || !Array.isArray(rawRun.assignments) || !Array.isArray(rawRun.artifacts) ||
      !finiteNumber(rawRun.createdAt) || !finiteNumber(rawRun.updatedAt) || !hasOptionalTimestamp(rawRun, "completedAt") ||
      (rawRun.maxConcurrency !== undefined && (!Number.isInteger(rawRun.maxConcurrency) || (rawRun.maxConcurrency as number) <= 0)) ||
      rawRun.groups.length !== run.groups.length || rawRun.tasks.length !== run.tasks.length ||
      rawRun.assignments.length !== run.assignments.length || rawRun.artifacts.length !== run.artifacts.length) return false;

    const groups = rawRun.groups.map(record);
    const tasks = rawRun.tasks.map(record);
    const assignments = rawRun.assignments.map(record);
    const artifacts = rawRun.artifacts.map(record);
    if (groups.some((group) => !group) || tasks.some((task) => !task) || assignments.some((assignment) => !assignment) || artifacts.some((artifact) => !artifact)) return false;
    const groupIds = new Set(groups.map((group) => group!.id));
    const taskIds = new Set(tasks.map((task) => task!.id));
    const assignmentIds = new Set(assignments.map((assignment) => assignment!.id));
    if (groupIds.size !== groups.length || taskIds.size !== tasks.length || assignmentIds.size !== assignments.length ||
      [...groupIds, ...taskIds, ...assignmentIds].some((id) => !nonEmptyString(id))) return false;

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      const normalizedGroup = run.groups[groupIndex];
      if (!group || !normalizedGroup || group.id !== normalizedGroup.id || group.title !== normalizedGroup.title || group.status !== normalizedGroup.status ||
        !nonEmptyString(group.title) || !GROUP_AND_TASK_STATUSES.has(String(group.status)) || !strictStringList(group.dependsOn) ||
        !Number.isInteger(group.maxConcurrency) || (group.maxConcurrency as number) <= 0 || !finiteNumber(group.createdAt) || !finiteNumber(group.updatedAt) ||
        !hasOptionalTimestamp(group, "completedAt") || !hasOptionalString(group, "agentHint") ||
        (group.filesHint !== undefined && !strictStringList(group.filesHint)) || group.dependsOn.some((id) => !groupIds.has(id) || id === group.id)) return false;
    }
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex]!;
      const normalizedTask = run.tasks[taskIndex];
      if (!normalizedTask || task.id !== normalizedTask.id || task.groupId !== normalizedTask.groupId || task.text !== normalizedTask.text || task.status !== normalizedTask.status ||
        !nonEmptyString(task.text) || !GROUP_AND_TASK_STATUSES.has(String(task.status)) ||
        !strictStringList(task.dependsOn) || !strictStringList(task.assignmentIds) || !Array.isArray(task.criteria) ||
        !finiteNumber(task.createdAt) || !finiteNumber(task.updatedAt) || !hasOptionalTimestamp(task, "completedAt") ||
        !hasOptionalString(task, "groupId") || !hasOptionalString(task, "agentHint") || !hasOptionalString(task, "cwd") ||
        !hasOptionalString(task, "outputSchema") || !hasOptionalString(task, "when") || !hasOptionalString(task, "continuation") ||
        (task.filesHint !== undefined && !strictStringList(task.filesHint)) ||
        (task.retries !== undefined && (!Number.isInteger(task.retries) || (task.retries as number) < 0)) ||
        (task.outputMode !== undefined && task.outputMode !== "text" && task.outputMode !== "json") ||
        (task.expansionMode !== undefined && task.expansionMode !== "append_tasks") ||
        (task.groupId !== undefined && !groupIds.has(task.groupId)) || task.dependsOn.some((id) => !taskIds.has(id) || id === task.id) ||
        task.assignmentIds.some((id) => !assignmentIds.has(id)) || task.criteria.length !== normalizedTask.criteria.length) return false;
      const taskAssignmentRefs = task.assignmentIds as string[];
      const taskAssignmentIds = assignments.filter((assignment) => assignment?.taskId === task.id).map((assignment) => assignment!.id);
      if (taskAssignmentIds.length !== taskAssignmentRefs.length || taskAssignmentIds.some((id, index) => id !== taskAssignmentRefs[index])) return false;
      for (let criterionIndex = 0; criterionIndex < task.criteria.length; criterionIndex += 1) {
        const criterion = record(task.criteria[criterionIndex]);
        const normalizedCriterion = normalizedTask.criteria[criterionIndex];
        if (!criterion || !normalizedCriterion || criterion.id !== normalizedCriterion.id || !nonEmptyString(criterion.text) ||
          typeof criterion.satisfied !== "boolean" || !Array.isArray(criterion.evidence)) return false;
        for (const item of criterion.evidence) {
          const evidence = record(item);
          if (!evidence || evidence.criterionId !== criterion.id || !nonEmptyString(evidence.assignmentId) || !nonEmptyString(evidence.summary) ||
            !hasOptionalString(evidence, "artifactPath") || !finiteNumber(evidence.createdAt) || !assignmentIds.has(evidence.assignmentId)) return false;
        }
      }
    }
    for (let assignmentIndex = 0; assignmentIndex < assignments.length; assignmentIndex += 1) {
      const assignment = assignments[assignmentIndex]!;
      const normalizedAssignment = run.assignments[assignmentIndex];
      const task = tasks.find((candidate) => candidate?.id === assignment.taskId);
      if (!normalizedAssignment || assignment.id !== normalizedAssignment.id || assignment.taskRunId !== rawRun.id || assignment.taskRunId !== normalizedAssignment.taskRunId ||
        assignment.groupId !== normalizedAssignment.groupId || assignment.taskId !== normalizedAssignment.taskId || assignment.agent !== normalizedAssignment.agent ||
        assignment.prompt !== normalizedAssignment.prompt || assignment.status !== normalizedAssignment.status || !task || assignment.groupId !== task.groupId ||
        !nonEmptyString(assignment.agent) || !nonEmptyString(assignment.prompt) ||
        !ASSIGNMENT_STATUSES.has(String(assignment.status)) || !hasOptionalString(assignment, "runId") ||
        !hasOptionalString(assignment, "currentTool") || !hasOptionalString(assignment, "lastActionSummary") ||
        !hasOptionalTimestamp(assignment, "lastActionAt") || !hasOptionalTimestamp(assignment, "staleWarnedAt") ||
        !hasOptionalTimestamp(assignment, "staleEscalatedAt") || !hasOptionalTimestamp(assignment, "supersededAt") ||
        !hasOptionalString(assignment, "supersededByAssignmentId") || !finiteNumber(assignment.createdAt) || !finiteNumber(assignment.updatedAt) ||
        !hasOptionalTimestamp(assignment, "completedAt") || (assignment.recentActivity !== undefined && !strictStringList(assignment.recentActivity)) ||
        !strictResult(assignment.result, assignment.id as string) || (assignment.launchRef !== undefined && !strictLaunchRef(assignment.launchRef, assignment.id as string))) return false;
    }
    for (const artifact of artifacts) {
      if (!artifact || !nonEmptyString(artifact.label) || !nonEmptyString(artifact.path) || artifact.taskRunId !== rawRun.id ||
        !nonEmptyString(artifact.assignmentId) || !nonEmptyString(artifact.taskId) || !hasOptionalString(artifact, "groupId")) return false;
      const task = tasks.find((candidate) => candidate?.id === artifact.taskId);
      const assignment = assignments.find((candidate) => candidate?.id === artifact.assignmentId);
      if (!task || !assignment || assignment.taskId !== artifact.taskId || artifact.groupId !== task.groupId) return false;
    }
  }
  return input.currentTaskRunId === undefined || (input.currentTaskRunId === normalized.currentTaskRunId && rawRuns.some((run) => run?.id === input.currentTaskRunId));
}

/** Locate the newest loadable v4 record; malformed candidates are skipped. */
export async function migrateNewestV4State(
  entries: readonly SessionEntry[],
  store: DurableObjectStore,
  context: V4MigrationContext,
): Promise<V4MigrationResult> {
  let sequence = 1;
  let sequenceExhausted = false;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "pi-tasked-subagents:state") continue;
    try {
      const data = typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data;
      if (validV5Pointer(data)) {
        if (data.sequence >= Number.MAX_SAFE_INTEGER) sequenceExhausted = true;
        else sequence = Math.max(sequence, data.sequence + 1);
      }
    } catch {
      // Malformed pointer-like records do not affect migration sequence.
    }
  }
  if (sequenceExhausted) {
    return { migrated: false, reason: "limit_exceeded", message: "Checkpoint sequence space is exhausted" };
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const raw = rawV4(entries[index]);
    if (!raw) continue;
    try {
      const state = ensureState(raw);
      if (!losslessV4Graph(raw, state)) continue;
      return await migrateV4State(state, store, { ...context, sequence });
    } catch {
      // A malformed v4 candidate must never replace an earlier loadable one.
    }
  }
  return { migrated: false, reason: "no_valid_v4", message: "No loadable v4 state entry was found" };
}
