import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { MAX_ASSIGNMENT_ARCHIVE_BYTES, MAX_CHECKPOINT_BYTES, MAX_TASK_RUN_OBJECT_BYTES, STORE_VERSION } from "../defaults.js";
import { canonicalJson, canonicalJsonBounded, sha256Hex } from "./canonical-json.js";
import type { StoredObject } from "./durable-types.js";
import { assignmentArchiveDir, assignmentArchiveLinkPath, sessionStoragePaths } from "./storage-paths.js";
import { PinnedDirectory as PinnedDirectoryCapability, pinExistingDirectory } from "./pinned-directory.mjs";

const DIGEST_ID = /^[a-f0-9]{64}$/;
type ObjectKind = StoredObject<unknown>["kind"];

interface PathIdentity {
  dev: number;
  ino: number;
  realpath: string;
}

export interface DurableObjectStoreOptions {
  /** Injectable operation-boundary hook for deterministic race/security tests. */
  beforePathOperation?: (operation: string) => Promise<void> | void;
  /** Injectable procfs dirfd path for deterministic unavailable-procfs tests. */
  procDirectoryPath?: (fd: number) => string;
}

interface PinnedDirectory {
  capability: PinnedDirectoryCapability;
  handle: fs.FileHandle;
  identity: PathIdentity;
  procPath: string;
}

/** Corruption and immutable-identity failures that archive discovery may quarantine. */
class ObjectIntegrityError extends Error {}

function assertDigest(id: string): void {
  if (!DIGEST_ID.test(id)) throw new Error("Invalid object digest");
}

function isObjectKind(value: unknown): value is ObjectKind {
  return value === "checkpoint" || value === "task-run" || value === "assignment";
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.realpath === right.realpath;
}

/**
 * Immutable, content-addressed JSON objects rooted in private application
 * storage. Node has no dirfd-relative API, so every path operation validates
 * each component before and after use and fails closed on identity uncertainty.
 */
export class DurableObjectStore {
  readonly root: string;

  constructor(root: string, private readonly options: DurableObjectStoreOptions = {}) {
    this.root = resolve(root);
  }

  async put<T>(kind: StoredObject<T>["kind"], payload: T, maxBytes: number): Promise<string> {
    this.assertBound(maxBytes);
    const envelope: StoredObject<T> = { storeVersion: STORE_VERSION as 1, kind, payload };
    const bytes = canonicalJsonBounded(envelope, maxBytes);
    const id = sha256Hex(bytes);
    await this.ensureStoreDirectories();
    const destination = this.objectPath(id);
    await this.installNoReplace(destination, bytes, async (directory, name) => {
      await this.readVerifiedPinnedObject(directory, name, id, kind, maxBytes);
    });
    return id;
  }

  async get<T>(id: string, kind: StoredObject<T>["kind"], maxBytes: number): Promise<T> {
    this.assertBound(maxBytes);
    assertDigest(id);
    return (await this.readVerifiedObject(this.objectPath(id), id, kind, maxBytes)).payload as T;
  }

  async verify(id: string): Promise<boolean> {
    try {
      assertDigest(id);
      // A kind is not known until the envelope is parsed, so cap the initial
      // read at the largest configured object and then enforce its own limit.
      await this.readVerifiedObject(this.objectPath(id), id, undefined, MAX_TASK_RUN_OBJECT_BYTES);
      return true;
    } catch {
      return false;
    }
  }

  async linkAssignmentArchive(sessionId: string, assignmentId: string, archiveId: string): Promise<void> {
    assertDigest(archiveId);
    await this.get(archiveId, "assignment", MAX_ASSIGNMENT_ARCHIVE_BYTES);
    const paths = sessionStoragePaths(this.root, sessionId);
    const destination = assignmentArchiveLinkPath(paths, assignmentId, archiveId);
    await this.ensureDirectory(dirname(destination));
    const source = this.objectPath(archiveId);
    const sourceRecord = await this.readVerifiedObject(source, archiveId, "assignment", MAX_ASSIGNMENT_ARCHIVE_BYTES);
    if (this.assignmentId(sourceRecord.payload) !== assignmentId) throw new Error("Archive assignment identity mismatch");

    const sourceIdentity = await this.regularFileIdentity(source);
    const sourceParent = await this.ensureDirectory(dirname(source), false);
    const destinationParent = await this.ensureDirectory(dirname(destination));
    const sourceName = this.safeBasename(basename(source));
    const destinationName = this.safeBasename(basename(destination));
    await this.beforePathOperation("link-assignment-archive");
    const sourceDirectory = await this.pinDirectory(dirname(source), sourceParent);
    try {
      const destinationDirectory = await this.pinDirectory(dirname(destination), destinationParent);
      try {
        await this.assertPinnedFileIdentity(sourceDirectory, sourceName, sourceIdentity, true);
        await this.assertPinnedDirectory(destinationDirectory, true);
        await this.beforePathOperation("link-assignment-archive-install");
        try {
          await sourceDirectory.capability.link(sourceName, destinationDirectory.capability, destinationName);
          const linked = await this.regularFileIdentity(this.pinnedPath(destinationDirectory, destinationName));
          if (linked.dev !== sourceIdentity.dev || linked.ino !== sourceIdentity.ino) {
            throw new Error("Archive link identity is uncertain");
          }
          await this.syncPinnedDirectory(destinationDirectory);
        } catch (error) {
          if (!this.isAlreadyExists(error)) throw error;
          const record = await this.readVerifiedPinnedObject(destinationDirectory, destinationName, archiveId, "assignment", MAX_ASSIGNMENT_ARCHIVE_BYTES);
          if (this.assignmentId(record.payload) !== assignmentId) {
            throw new ObjectIntegrityError("Immutable archive link has a different assignment identity", { cause: error });
          }
        }
      } finally {
        await destinationDirectory.handle.close();
      }
    } finally {
      await sourceDirectory.handle.close();
    }
  }

  async listAssignmentArchives<T>(sessionId: string, assignmentId: string): Promise<Array<{ archiveId: string; archive: T }>> {
    await this.ensureStoreDirectories();
    const paths = sessionStoragePaths(this.root, sessionId);
    const directory = assignmentArchiveDir(paths, assignmentId);
    let directoryIdentity: PathIdentity;
    try {
      directoryIdentity = await this.ensureDirectory(directory, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const results: Array<{ archiveId: string; archive: T }> = [];
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await this.assertIdentity(directory, directoryIdentity, true);
    for (const entry of entries) {
      const archiveId = entry.name.endsWith(".json") ? entry.name.slice(0, -".json".length) : "";
      const path = join(directory, entry.name);
      if (!entry.isFile() || !DIGEST_ID.test(archiveId)) {
        await this.quarantineArchiveLink(path, archiveId || "invalid");
        continue;
      }
      try {
        const record = await this.readVerifiedObject(path, archiveId, "assignment", MAX_ASSIGNMENT_ARCHIVE_BYTES);
        if (this.assignmentId(record.payload) !== assignmentId) throw new ObjectIntegrityError("Archive assignment identity mismatch");
        results.push({ archiveId, archive: record.payload as T });
      } catch (error) {
        // Filesystem failures (EIO, EMFILE, EACCES, unavailable procfs, …)
        // are not evidence of corrupt data and must never delete an archive.
        if (!(error instanceof ObjectIntegrityError)) throw error;
        await this.quarantineArchiveLink(path, archiveId);
      }
    }
    await this.assertIdentity(directory, directoryIdentity, true);
    return results.sort((left, right) => left.archiveId.localeCompare(right.archiveId));
  }

  /** Move a corrupt object aside without ever resolving a path outside root. */
  async quarantine(id: string, _reason: string): Promise<void> {
    assertDigest(id);
    const source = this.objectPath(id);
    let sourceIdentity: PathIdentity;
    try {
      sourceIdentity = await this.regularFileIdentity(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const sourceParent = await this.ensureDirectory(dirname(source), false);
    const directory = join(this.root, "quarantine");
    const destinationParent = await this.ensureDirectory(directory);
    const target = join(directory, `${id}.${Date.now()}.${randomBytes(6).toString("hex")}.json`);
    await this.moveNoReplace(source, target, sourceIdentity, sourceParent, destinationParent);
  }

  /** Delete only unreferenced regular object files whose mtime predates `olderThan`. */
  async cleanupOrphans(referenced: ReadonlySet<string>, olderThan: number): Promise<number> {
    await this.ensureStoreDirectories();
    if (!Number.isFinite(olderThan)) throw new Error("Invalid orphan cleanup cutoff");
    const directory = this.objectDirectory();
    const directoryIdentity = await this.ensureDirectory(directory, false);
    const pinnedDirectory = await this.pinDirectory(directory, directoryIdentity);
    let removed = 0;
    try {
      for (const entry of await fs.readdir(pinnedDirectory.procPath, { withFileTypes: true })) {
        if (!entry.isFile() || !DIGEST_ID.test(entry.name.replace(/\.json$/, "")) || !entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -".json".length);
        if (referenced.has(id)) continue;
        let identity: PathIdentity;
        try {
          identity = await this.regularFileIdentity(this.pinnedPath(pinnedDirectory, entry.name));
          const stat = await fs.stat(this.pinnedPath(pinnedDirectory, entry.name));
          if (stat.mtimeMs >= olderThan) continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        await this.assertPinnedFileIdentity(pinnedDirectory, entry.name, identity, true);
        await pinnedDirectory.capability.unlink(entry.name);
        removed += 1;
      }
      if (removed > 0) await this.syncPinnedDirectory(pinnedDirectory);
      return removed;
    } finally {
      await pinnedDirectory.handle.close();
    }
  }

  private objectDirectory(): string {
    return join(this.root, "objects");
  }

  private objectPath(id: string): string {
    assertDigest(id);
    const path = join(this.objectDirectory(), `${id}.json`);
    this.assertContained(path);
    return path;
  }

  private assertContained(candidate: string): void {
    const difference = relative(this.root, candidate);
    if (difference === "" || difference === ".." || difference.startsWith(`..${sep}`) || difference.startsWith("/")) {
      throw new Error("Storage path escapes configured root");
    }
  }

  private async ensureStoreDirectories(): Promise<void> {
    await this.ensureRoot();
    for (const directory of ["objects", "sessions", "assignments", "runs", "results", "quarantine"]) {
      await this.ensureDirectory(join(this.root, directory));
    }
  }

  private async ensureRoot(): Promise<PathIdentity> {
    try {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new Error("Unable to create private storage root", { cause: error });
    }
    return this.privateDirectoryIdentity(this.root);
  }

  /** Validate every component immediately before use and normalize its mode. */
  private async ensureDirectory(directory: string, create = true): Promise<PathIdentity> {
    this.assertContained(directory);
    const rootIdentity = await this.ensureRoot();
    const rootRealpath = rootIdentity.realpath;
    let current = this.root;
    for (const component of relative(this.root, directory).split(sep).filter(Boolean)) {
      current = join(current, component);
      try {
        await fs.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw new Error("Unable to create private storage directory", { cause: mkdirError });
          }
        }
      }
      const identity = await this.privateDirectoryIdentity(current);
      this.assertRealContained(rootRealpath, identity.realpath);
    }
    const result = await this.privateDirectoryIdentity(directory);
    this.assertRealContained(rootRealpath, result.realpath);
    return result;
  }

  private async privateDirectoryIdentity(path: string): Promise<PathIdentity> {
    return this.directoryIdentity(path, true);
  }

  private async directoryIdentity(path: string, normalizePermissions: boolean): Promise<PathIdentity> {
    const stat = await fs.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Storage directory is not a regular contained directory");
    const beforeRealpath = await fs.realpath(path);
    if (normalizePermissions) await fs.chmod(path, 0o700);
    const after = await fs.lstat(path);
    const afterRealpath = await fs.realpath(path);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || afterRealpath !== beforeRealpath) {
      throw new Error("Storage directory identity changed during validation");
    }
    return { dev: after.dev, ino: after.ino, realpath: afterRealpath };
  }

  private assertRealContained(root: string, candidate: string): void {
    const difference = relative(root, candidate);
    if (difference === ".." || difference.startsWith(`..${sep}`) || difference.startsWith("/")) {
      throw new Error("Storage path escapes configured root");
    }
  }

  private assertBound(maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid object byte limit");
  }

  private assertBytes(bytes: string, maxBytes: number): void {
    if (Buffer.byteLength(bytes, "utf8") > maxBytes) throw new Error("Object exceeds its byte limit");
  }

  private async readVerifiedObject(path: string, id: string, expectedKind?: ObjectKind, maxBytes = Number.MAX_SAFE_INTEGER): Promise<StoredObject<unknown>> {
    assertDigest(id);
    this.assertBound(maxBytes);
    const parent = await this.ensureDirectory(dirname(path), false);
    const directory = await this.pinDirectory(dirname(path), parent);
    try {
      return await this.readVerifiedPinnedObject(directory, this.safeBasename(basename(path)), id, expectedKind, maxBytes);
    } finally {
      await directory.handle.close();
    }
  }

  /** Read an immutable collision through an already-live destination capability. */
  private async readVerifiedPinnedObject(directory: PinnedDirectory, name: string, id: string, expectedKind: ObjectKind | undefined, maxBytes: number): Promise<StoredObject<unknown>> {
    assertDigest(id);
    this.assertBound(maxBytes);
    await this.assertPinnedDirectory(directory, true);
    const handle = await directory.capability.openFile(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw new ObjectIntegrityError("Object is not a regular file");
      if (opened.size > maxBytes) throw new ObjectIntegrityError("Object exceeds its byte limit");
      bytes = await handle.readFile({ encoding: "utf8" });
      const after = await handle.stat();
      if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
        throw new ObjectIntegrityError("Object identity changed while reading");
      }
    } finally {
      await handle.close();
    }
    await this.assertPinnedDirectory(directory, true);
    return this.parseVerifiedObject(bytes, id, expectedKind, maxBytes);
  }

  private parseVerifiedObject(bytes: string, id: string, expectedKind: ObjectKind | undefined, maxBytes: number): StoredObject<unknown> {
    this.assertBytes(bytes, maxBytes);
    if (sha256Hex(bytes) !== id) throw new ObjectIntegrityError("Object digest mismatch");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      throw new ObjectIntegrityError("Object contains invalid JSON");
    }
    if (typeof parsed !== "object" || parsed === null) throw new ObjectIntegrityError("Object envelope is invalid");
    const envelope = parsed as Partial<StoredObject<unknown>>;
    if (envelope.storeVersion !== STORE_VERSION || !isObjectKind(envelope.kind) || !("payload" in envelope)) {
      throw new ObjectIntegrityError("Object envelope is invalid");
    }
    this.assertBytes(bytes, this.objectKindMaxBytes(envelope.kind));
    if (canonicalJson(envelope) !== bytes) throw new ObjectIntegrityError("Object is not canonically encoded");
    if (expectedKind !== undefined && envelope.kind !== expectedKind) throw new ObjectIntegrityError("Object kind mismatch");
    return envelope as StoredObject<unknown>;
  }

  private objectKindMaxBytes(kind: ObjectKind): number {
    switch (kind) {
      case "checkpoint": return MAX_CHECKPOINT_BYTES;
      case "task-run": return MAX_TASK_RUN_OBJECT_BYTES;
      case "assignment": return MAX_ASSIGNMENT_ARCHIVE_BYTES;
    }
  }

  private async regularFileIdentity(path: string): Promise<PathIdentity> {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ObjectIntegrityError("Object is not a regular file");
    return { dev: stat.dev, ino: stat.ino, realpath: await fs.realpath(path) };
  }

  private async assertIdentity(path: string, expected: PathIdentity, directory: boolean): Promise<void> {
    const actual = directory ? await this.directoryIdentity(path, false) : await this.regularFileIdentity(path);
    if (!sameIdentity(actual, expected)) throw new Error("Storage path identity changed during operation");
  }

  private assignmentId(payload: unknown): string | undefined {
    if (typeof payload !== "object" || payload === null) return undefined;
    const value = (payload as { assignmentId?: unknown }).assignmentId;
    return typeof value === "string" ? value : undefined;
  }

  private async beforePathOperation(operation: string): Promise<void> {
    await this.options.beforePathOperation?.(operation);
  }

  private async installNoReplace(destination: string, bytes: string, verifyExisting: (directory: PinnedDirectory, name: string) => Promise<void>): Promise<void> {
    const directory = dirname(destination);
    const directoryIdentity = await this.ensureDirectory(directory);
    const destinationName = this.safeBasename(basename(destination));
    const temporaryName = this.safeBasename(`.${destinationName}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    const pinnedDirectory = await this.pinDirectory(directory, directoryIdentity);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await pinnedDirectory.capability.openFile(temporaryName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
      const temporaryIdentity = await handle.stat();
      await handle.close();
      handle = undefined;
      await this.assertPinnedDirectory(pinnedDirectory, true);
      await this.beforePathOperation("install-object");
      // link(2) is the no-replace final-install winner gate.
      try {
        await pinnedDirectory.capability.link(temporaryName, pinnedDirectory.capability, destinationName);
      } catch (error) {
        if (!this.isAlreadyExists(error)) throw error;
        // Verify the collision through this live capability before it can close.
        await verifyExisting(pinnedDirectory, destinationName);
        return;
      }
      const destinationIdentity = await this.regularFileIdentity(this.pinnedPath(pinnedDirectory, destinationName));
      if (destinationIdentity.dev !== temporaryIdentity.dev || destinationIdentity.ino !== temporaryIdentity.ino) {
        throw new Error("Immutable object install identity is uncertain");
      }
      await this.syncPinnedDirectory(pinnedDirectory);
    } finally {
      await handle?.close();
      try {
        await this.safeUnlinkTemporary(temporaryName, pinnedDirectory);
      } finally {
        await pinnedDirectory.handle.close();
      }
    }
  }

  private async safeUnlinkTemporary(name: string, directory: PinnedDirectory): Promise<void> {
    const path = this.pinnedPath(directory, name);
    try {
      const identity = await this.regularFileIdentity(path);
      await this.assertPinnedDirectory(directory, false);
      await this.assertPinnedFileIdentity(directory, name, identity, false);
      await directory.capability.unlink(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async quarantineArchiveLink(path: string, label: string): Promise<void> {
    try {
      const source = await this.regularFileIdentity(path);
      const sourceParent = await this.ensureDirectory(dirname(path), false);
      const directory = join(this.root, "quarantine");
      const destinationDirectory = await this.ensureDirectory(directory);
      const safeLabel = /^[a-f0-9]{64}$/.test(label) ? label : "invalid-archive";
      const target = join(directory, `${safeLabel}.${Date.now()}.${randomBytes(6).toString("hex")}.json`);
      await this.moveNoReplace(path, target, source, sourceParent, destinationDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** Link-then-unlink is a no-replace move and never follows a final target. */
  private async moveNoReplace(source: string, target: string, sourceIdentity: PathIdentity, sourceParent: PathIdentity, targetParent: PathIdentity): Promise<void> {
    const sourceName = this.safeBasename(basename(source));
    const targetName = this.safeBasename(basename(target));
    const sourceDirectory = await this.pinDirectory(dirname(source), sourceParent);
    try {
      const targetDirectory = await this.pinDirectory(dirname(target), targetParent);
      try {
        await this.assertPinnedFileIdentity(sourceDirectory, sourceName, sourceIdentity, true);
        await this.assertPinnedDirectory(targetDirectory, true);
        await sourceDirectory.capability.link(sourceName, targetDirectory.capability, targetName);
        const targetIdentity = await this.regularFileIdentity(this.pinnedPath(targetDirectory, targetName));
        if (targetIdentity.dev !== sourceIdentity.dev || targetIdentity.ino !== sourceIdentity.ino) {
          throw new Error("Quarantine target identity is uncertain");
        }
        await this.assertPinnedFileIdentity(sourceDirectory, sourceName, sourceIdentity, true);
        await sourceDirectory.capability.unlink(sourceName);
        await this.syncPinnedDirectory(sourceDirectory);
        if (targetDirectory !== sourceDirectory) await this.syncPinnedDirectory(targetDirectory);
      } finally {
        await targetDirectory.handle.close();
      }
    } finally {
      await sourceDirectory.handle.close();
    }
  }

  private safeBasename(name: string): string {
    if (name.length === 0 || name === "." || name === ".." || basename(name) !== name || name.includes("/") || name.includes("\\")) {
      throw new Error("Storage filename is not a safe basename");
    }
    return name;
  }

  /**
   * Pin a validated directory before its final mutation. Linux procfs exposes
   * the still-open directory even if an attacker replaces its pathname.
   */
  private async pinDirectory(directory: string, expected: PathIdentity): Promise<PinnedDirectory> {
    const pinned = await pinExistingDirectory(this.root, directory, expected, {
      procDirectoryPath: this.options.procDirectoryPath,
    });
    return {
      capability: pinned,
      handle: pinned.handle,
      identity: expected,
      procPath: pinned.procDirectoryPath,
    };
  }

  private pinnedPath(directory: PinnedDirectory, name: string): string {
    return join(directory.procPath, this.safeBasename(name));
  }

  private async assertPinnedDirectory(directory: PinnedDirectory, requireOriginalRealpath = false): Promise<void> {
    const rootIdentity = await this.ensureRoot();
    const stat = await directory.handle.stat();
    if (!stat.isDirectory() || stat.dev !== directory.identity.dev || stat.ino !== directory.identity.ino) {
      throw new Error("Pinned storage directory identity changed during operation");
    }
    let realpath: string;
    try {
      realpath = await fs.realpath(directory.procPath);
    } catch (error) {
      throw new Error("Procfs dirfd paths are unavailable; refusing storage mutation", { cause: error });
    }
    if (requireOriginalRealpath && realpath !== directory.identity.realpath) {
      throw new Error("Pinned storage directory realpath changed during operation");
    }
    this.assertRealContained(rootIdentity.realpath, realpath);
  }

  private async assertPinnedFileIdentity(directory: PinnedDirectory, name: string, expected: PathIdentity, requireOriginalRealpath = false): Promise<void> {
    await this.assertPinnedDirectory(directory, requireOriginalRealpath);
    const actual = await this.regularFileIdentity(this.pinnedPath(directory, name));
    if (!sameIdentity(actual, expected)) throw new Error("Storage path identity changed during operation");
  }

  private async syncPinnedDirectory(directory: PinnedDirectory): Promise<void> {
    await this.assertPinnedDirectory(directory);
    await directory.handle.sync();
    await this.assertPinnedDirectory(directory);
  }

  private isAlreadyExists(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "EEXIST";
  }
}
