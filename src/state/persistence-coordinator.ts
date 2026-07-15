import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname } from "node:path";

import {
  MAX_CHECKPOINT_BYTES,
  MAX_POINTER_BYTES,
  MAX_TASK_RUN_OBJECT_BYTES,
} from "../defaults.js";
import type { TaskedSubagentsState } from "../types.js";
import { canonicalJson, sha256Hex, utf8Bytes } from "./canonical-json.js";
import type {
  RecoverableRunReference,
  StatePointerV5,
  StoredObject,
} from "./durable-types.js";
import {
  buildCheckpointManifest,
  buildCheckpointProjection,
} from "./durable-projection.js";
import { sessionStoragePaths } from "./storage-paths.js";

const DIGEST_ID = /^[a-f0-9]{64}$/;

export interface PointerAppender {
  append(pointer: StatePointerV5): void;
}

export interface CheckpointContext {
  sessionId: string;
  /** Every valid v5 pointer returned by sessionManager.getEntries(), not just the active branch. */
  visiblePointers: readonly StatePointerV5[];
  now?: number;
}

export interface PersistenceFailure {
  code: "projection" | "object_write" | "pointer_too_large" | "pointer_append" | "stale_generation" | "session_mismatch";
  message: string;
}

export type CheckpointResult =
  | { committed: true; pointer: StatePointerV5; deduplicated: boolean }
  | { committed: false; error: PersistenceFailure; dirty: true };

/** Minimal store boundary keeps coordinator tests independent of filesystem implementation details. */
export interface CheckpointObjectStore {
  readonly root?: string;
  put<T>(kind: StoredObject<T>["kind"], payload: T, maxBytes: number): Promise<string>;
}

export interface PersistenceCoordinatorOptions {
  /** Needed only when an injected store does not expose its storage root. */
  dataRoot?: string;
  /** Test-only observation point after the atomic refs replacement completes. */
  onRefsWritten?: () => void;
}

interface DirtyCheckpoint {
  state: TaskedSubagentsState;
  sessionId: string;
  epoch: number;
}

function failure(code: PersistenceFailure["code"], message: string): PersistenceFailure {
  return { code, message };
}

function safeErrorMessage(error: unknown): string {
  // Object-store errors are already intentionally path-free. Do not leak an
  // arbitrary filesystem error (which can contain a private absolute path).
  if (error instanceof Error && /^[A-Za-z0-9 _;:,.-]+$/.test(error.message)) return error.message;
  return "Durable persistence operation failed";
}

/**
 * Serializes durable checkpoints. It deliberately does not mutate controller
 * state: failed snapshots remain available for a later explicit retry.
 */
export class PersistenceCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private epoch = 0;
  private sessionId?: string;
  private sequence = 0;
  private projectionDigest?: string;
  private lastCommitted?: StatePointerV5;
  private dirty?: DirtyCheckpoint;
  private readonly committedIds = new Set<string>();
  private readonly root: string;

  constructor(
    private readonly store: CheckpointObjectStore,
    private readonly appender: PointerAppender,
    options: PersistenceCoordinatorOptions = {},
  ) {
    this.root = options.dataRoot ?? store.root ?? "";
    if (!this.root) throw new Error("PersistenceCoordinator requires a storage root");
    this.onRefsWritten = options.onRefsWritten;
  }

  private readonly onRefsWritten?: () => void;

  checkpoint(state: TaskedSubagentsState, context: CheckpointContext): Promise<CheckpointResult> {
    let snapshot: TaskedSubagentsState;
    try {
      snapshot = structuredClone(state);
    } catch {
      return Promise.resolve(this.recordDirty(state, context.sessionId, this.epoch, failure("projection", "State cannot be safely cloned for durable persistence")));
    }
    const contextError = this.activateContext(context);
    if (contextError) return Promise.resolve(this.rejected(contextError));
    const capturedEpoch = this.epoch;
    return this.enqueue(() => this.write(snapshot, context, capturedEpoch));
  }

  retryDirty(context: CheckpointContext): Promise<CheckpointResult> {
    const contextError = this.contextError(context);
    if (contextError) return Promise.resolve(this.rejected(contextError));
    const dirty = this.dirty;
    if (!dirty) {
      if (!this.lastCommitted) return Promise.resolve(this.rejected(failure("projection", "No durable checkpoint is available")));
      if (context.sessionId !== this.sessionId) {
        return Promise.resolve(this.rejected(failure("session_mismatch", "Checkpoint context belongs to a different session")));
      }
      return Promise.resolve({ committed: true, pointer: this.lastCommitted, deduplicated: true });
    }
    if (dirty.sessionId !== context.sessionId || context.sessionId !== this.sessionId) {
      return Promise.resolve(this.rejected(failure("session_mismatch", "Dirty state belongs to a different session")));
    }
    if (dirty.epoch !== this.epoch) {
      return Promise.resolve(this.rejected(failure("stale_generation", "A newer session generation superseded this checkpoint")));
    }
    const capturedEpoch = this.epoch;
    return this.enqueue(() => this.write(dirty.state, context, capturedEpoch));
  }

  async flush(context: CheckpointContext): Promise<void> {
    await this.queue;
    if (!this.dirty) return;
    const result = await this.retryDirty(context);
    if (!result.committed) throw new Error(result.error.message);
  }

  restoreCommitted(pointer: StatePointerV5): void {
    if (!this.validPointer(pointer)) return;
    this.lastCommitted = pointer;
    this.sequence = Math.max(this.sequence, pointer.sequence);
    this.committedIds.add(pointer.checkpointId);
    // A restored pointer is authoritative, but its projection digest is not
    // available without reading the manifest. The first new request may write
    // one equivalent pointer; later requests are deduplicated exactly.
    this.projectionDigest = undefined;
  }

  invalidate(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Invalid persistence epoch");
    this.epoch = Math.max(this.epoch + 1, epoch);
    this.resetSessionScopedState();
  }

  private enqueue(operation: () => Promise<CheckpointResult>): Promise<CheckpointResult> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async write(state: TaskedSubagentsState, context: CheckpointContext, capturedEpoch: number): Promise<CheckpointResult> {
    if (!this.currentContext(context, capturedEpoch)) {
      return this.recordDirty(state, context.sessionId, capturedEpoch, failure("stale_generation", "A newer session generation superseded this checkpoint"));
    }

    const projected = buildCheckpointProjection(state, []);
    if (!projected.ok) return this.recordDirty(state, context.sessionId, capturedEpoch, failure("projection", projected.error.message));
    const digest = sha256Hex(canonicalJson(projected.value));
    if (digest === this.projectionDigest && this.lastCommitted) {
      this.dirty = undefined;
      return { committed: true, pointer: this.lastCommitted, deduplicated: true };
    }

    const sequence = Math.max(
      this.sequence,
      ...context.visiblePointers.filter((pointer) => this.validPointer(pointer)).map((pointer) => pointer.sequence),
    ) + 1;
    const pointer: StatePointerV5 = {
      version: 5,
      checkpointId: "0".repeat(64),
      ...(projected.value.currentTaskRunId === undefined ? {} : { currentTaskRunId: projected.value.currentTaskRunId }),
      sequence,
      writtenAt: context.now ?? Date.now(),
    };
    if (utf8Bytes(pointer) > MAX_POINTER_BYTES) {
      return this.recordDirty(state, context.sessionId, capturedEpoch, failure("pointer_too_large", "Checkpoint pointer exceeds the 4 KiB limit"));
    }

    let manifestId: string;
    try {
      const recoverableRuns: RecoverableRunReference[] = [];
      for (const run of projected.value.recoverableRuns) {
        const objectId = await this.store.put("task-run", run, MAX_TASK_RUN_OBJECT_BYTES);
        // buildCheckpointProjection only returns the four recoverable statuses.
        recoverableRuns.push({ taskRunId: run.id, status: run.status as RecoverableRunReference["status"], objectId, updatedAt: run.updatedAt });
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
      if (!manifest.ok) return this.recordDirty(state, context.sessionId, capturedEpoch, failure("projection", manifest.error.message));
      manifestId = await this.store.put("checkpoint", manifest.value, MAX_CHECKPOINT_BYTES);
    } catch (error) {
      return this.recordDirty(state, context.sessionId, capturedEpoch, failure("object_write", safeErrorMessage(error)));
    }

    if (!this.currentContext(context, capturedEpoch)) {
      return this.recordDirty(state, context.sessionId, capturedEpoch, failure("stale_generation", "A newer session generation superseded this checkpoint"));
    }

    pointer.checkpointId = manifestId;
    // A real digest is fixed-width, so it cannot make the provisional pointer larger.
    if (utf8Bytes(pointer) > MAX_POINTER_BYTES) {
      return this.recordDirty(state, context.sessionId, capturedEpoch, failure("pointer_too_large", "Checkpoint pointer exceeds the 4 KiB limit"));
    }

    try {
      await this.writeRefs(context.sessionId, context.visiblePointers, manifestId);
    } catch (error) {
      return this.recordDirty(state, context.sessionId, capturedEpoch, failure("object_write", safeErrorMessage(error)));
    }
    if (!this.currentContext(context, capturedEpoch)) {
      return this.recordDirty(state, context.sessionId, capturedEpoch, failure("stale_generation", "A newer session generation superseded this checkpoint"));
    }

    try {
      this.appender.append(pointer);
    } catch (error) {
      return this.recordDirty(state, context.sessionId, capturedEpoch, failure("pointer_append", safeErrorMessage(error)));
    }

    this.sequence = sequence;
    this.projectionDigest = digest;
    this.lastCommitted = pointer;
    this.committedIds.add(manifestId);
    this.dirty = undefined;
    return { committed: true, pointer, deduplicated: false };
  }

  private recordDirty(state: TaskedSubagentsState, sessionId: string, epoch: number, error: PersistenceFailure): CheckpointResult {
    this.dirty = { state: structuredClone(state), sessionId, epoch };
    return { committed: false, error, dirty: true };
  }

  private rejected(error: PersistenceFailure): CheckpointResult {
    return { committed: false, error, dirty: true };
  }

  private contextError(context: CheckpointContext): PersistenceFailure | undefined {
    if (typeof context.sessionId !== "string" || !context.sessionId) {
      return failure("session_mismatch", "Checkpoint context has no active session");
    }
    if (!Array.isArray(context.visiblePointers)) {
      return failure("session_mismatch", "Checkpoint context has no visible pointer set");
    }
    try {
      sessionStoragePaths(this.root, context.sessionId);
    } catch {
      return failure("session_mismatch", "Checkpoint context has an invalid session");
    }
    return undefined;
  }

  private activateContext(context: CheckpointContext): PersistenceFailure | undefined {
    const error = this.contextError(context);
    if (error) return error;
    if (this.sessionId !== undefined && this.sessionId !== context.sessionId) {
      this.epoch += 1;
      this.resetSessionScopedState();
    }
    this.sessionId = context.sessionId;
    return undefined;
  }

  private currentContext(context: CheckpointContext, epoch: number): boolean {
    return this.sessionId === context.sessionId && this.epoch === epoch;
  }

  private resetSessionScopedState(): void {
    this.sequence = 0;
    this.projectionDigest = undefined;
    this.lastCommitted = undefined;
    this.committedIds.clear();
  }

  private validPointer(pointer: StatePointerV5): boolean {
    return pointer.version === 5 && DIGEST_ID.test(pointer.checkpointId) &&
      Number.isSafeInteger(pointer.sequence) && pointer.sequence >= 0;
  }

  private async writeRefs(sessionId: string, visiblePointers: readonly StatePointerV5[], checkpointId: string): Promise<void> {
    const paths = sessionStoragePaths(this.root, sessionId);
    const checkpointIds = new Set<string>(this.committedIds);
    for (const pointer of visiblePointers) {
      if (this.validPointer(pointer)) checkpointIds.add(pointer.checkpointId);
    }
    checkpointIds.add(checkpointId);
    const bytes = canonicalJson({ version: 1, checkpointIds: [...checkpointIds].sort() });
    await fs.mkdir(dirname(paths.refsPath), { recursive: true, mode: 0o700 });
    const temporary = `${paths.refsPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, paths.refsPath);
      const directory = await fs.open(dirname(paths.refsPath), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.onRefsWritten?.();
    } finally {
      await handle?.close();
      await fs.rm(temporary, { force: true });
    }
  }
}
