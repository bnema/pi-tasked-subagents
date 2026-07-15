import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  MAX_ASSIGNMENT_ARCHIVE_BYTES,
  MAX_CHECKPOINT_BYTES,
  MAX_POINTER_BYTES,
  MAX_RECENT_ASSIGNMENT_REFS,
  MAX_RECENT_COMPLETED,
  MAX_RECOVERABLE_TASK_RUNS,
  MAX_TASK_RUN_OBJECT_BYTES,
  STATE_POINTER_VERSION,
  STORE_VERSION,
} from "../src/defaults.js";
import { canonicalJson, canonicalJsonBounded, sha256Hex, utf8Bytes } from "../src/state/canonical-json.js";
import type { AssignmentArchiveV1 } from "../src/state/durable-types.js";
import { DurableObjectStore } from "../src/state/object-store.js";
import { rewriteSessionRefs } from "../src/state/persistence-coordinator.js";
import {
  assignmentArchiveDir,
  assignmentArchiveLinkPath,
  resolveStorageRoot,
  resultFilePath,
  resultReservationPath,
  sessionStoragePaths,
} from "../src/state/storage-paths.js";

const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalHome = process.env.HOME;

afterEach(() => {
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function expectContained(root: string, target: string): void {
  expect(relative(root, target)).not.toMatch(/^(?:\.\.(?:[/\\]|$)|\/)/);
}

describe("bounded durable storage primitives", () => {
  test("defines the approved versions, byte limits, and cardinality bounds exactly", () => {
    expect(STATE_POINTER_VERSION).toBe(5);
    expect(STORE_VERSION).toBe(1);
    expect(MAX_POINTER_BYTES).toBe(4 * 1024);
    expect(MAX_CHECKPOINT_BYTES).toBe(256 * 1024);
    expect(MAX_TASK_RUN_OBJECT_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_ASSIGNMENT_ARCHIVE_BYTES).toBe(256 * 1024);
    expect(MAX_RECOVERABLE_TASK_RUNS).toBe(100);
    expect(MAX_RECENT_COMPLETED).toBe(20);
    expect(MAX_RECENT_ASSIGNMENT_REFS).toBe(1_000);
  });

  test("resolves injected, XDG, and fallback user roots without consulting real user data", () => {
    const injected = join(tmpdir(), "storage-root-injected");
    expect(resolveStorageRoot({ dataRoot: injected })).toBe(injected);

    process.env.XDG_DATA_HOME = join(tmpdir(), "storage-root-xdg");
    expect(resolveStorageRoot()).toBe(join(process.env.XDG_DATA_HOME, "pi-tasked-subagents"));

    delete process.env.XDG_DATA_HOME;
    process.env.HOME = join(tmpdir(), "storage-root-home");
    expect(resolveStorageRoot()).toBe(join(process.env.HOME, ".local", "share", "pi-tasked-subagents"));
  });

  test("ignores a relative XDG data root and uses the home-based data directory", () => {
    process.env.XDG_DATA_HOME = "relative-data-root";
    process.env.HOME = join(tmpdir(), "storage-root-home-relative-xdg");

    expect(resolveStorageRoot()).toBe(join(process.env.HOME, ".local", "share", "pi-tasked-subagents"));
  });

  test("contains session and result paths and hashes assignment IDs instead of inserting them", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-paths-"));
    const paths = sessionStoragePaths(root, "session-123");
    const resultId = "0123456789abcdef0123456789abcdef";
    const archiveId = "a".repeat(64);
    const archiveDir = assignmentArchiveDir(paths, "../../assignment with separators");
    const archiveLink = assignmentArchiveLinkPath(paths, "../../assignment with separators", archiveId);

    for (const target of [paths.sessionDir, paths.resultsDir, paths.assignmentsDir, resultFilePath(paths, resultId), resultReservationPath(paths, resultId), archiveDir, archiveLink]) {
      expectContained(root, target);
    }
    expect(archiveDir).not.toContain("assignment with separators");
    expect(archiveLink).toBe(join(archiveDir, `${archiveId}.json`));
  });

  test("fails closed for traversal, unsafe IDs, and symlinked path components", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-paths-"));
    const paths = sessionStoragePaths(root, "session-123");

    expect(() => sessionStoragePaths(root, "../escape")).toThrow(/unsafe/i);
    expect(() => resultFilePath(paths, "../escape")).toThrow(/unsafe/i);
    expect(() => assignmentArchiveLinkPath(paths, "assignment", "../escape")).toThrow(/unsafe/i);

    const outside = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-outside-"));
    mkdirSync(join(paths.root, "results"), { recursive: true });
    symlinkSync(outside, paths.resultsDir);
    expect(() => resultFilePath(paths, "0123456789abcdef0123456789abcdef")).toThrow(/symlink|contain/i);
  });

  test("canonicalizes JSON and SHA-256 deterministically", () => {
    const first = { z: [true, { b: "β", a: 1 }], a: null };
    const second = { a: null, z: [true, { a: 1, b: "β" }] };

    expect(canonicalJson(first)).toBe('{"a":null,"z":[true,{"a":1,"b":"β"}]}');
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(sha256Hex(canonicalJson(first))).toBe(sha256Hex(canonicalJson(second)));
    expect(sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(utf8Bytes("β")).toBe(2);
    expect(() => canonicalJson({ value: undefined })).toThrow(/unsupported/i);
  });

  test("creates and normalizes every durable-store directory as private 0700", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-store-"));
    chmodSync(root, 0o755);
    mkdirSync(join(root, "objects"), { recursive: true, mode: 0o755 });
    chmodSync(join(root, "objects"), 0o755);
    const store = new DurableObjectStore(root);
    const archiveId = await store.put("assignment", { assignmentId: "assignment-1" }, MAX_ASSIGNMENT_ARCHIVE_BYTES);
    await store.linkAssignmentArchive("session-123", "assignment-1", archiveId);

    for (const directory of [
      root,
      join(root, "objects"),
      join(root, "sessions"),
      join(root, "assignments"),
      join(root, "assignments", "session-123"),
      assignmentArchiveDir(sessionStoragePaths(root, "session-123"), "assignment-1"),
      join(root, "runs"),
      join(root, "results"),
      join(root, "quarantine"),
    ]) {
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  test("writes canonical immutable objects locally, deduplicates them, and rejects oversized payloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-store-"));
    const store = new DurableObjectStore(root);
    const first = await store.put("checkpoint", { z: 1, a: "value" }, 1_024);
    const second = await store.put("checkpoint", { a: "value", z: 1 }, 1_024);

    expect(first).toBe(sha256Hex(canonicalJson({ storeVersion: 1, kind: "checkpoint", payload: { a: "value", z: 1 } })));
    expect(second).toBe(first);
    expect(readFileSync(join(root, "objects", `${first}.json`), "utf8")).toBe(canonicalJson({ storeVersion: 1, kind: "checkpoint", payload: { a: "value", z: 1 } }));
    expect(await store.get(first, "checkpoint", 1_024)).toEqual({ a: "value", z: 1 });
    await expect(store.put("checkpoint", { text: "β".repeat(20) }, 20)).rejects.toThrow(/limit/i);
  });

  test("aborts bounded canonical encoding before evaluating data beyond its byte limit", () => {
    const values = ["x".repeat(128)] as string[];
    Object.defineProperty(values, "1", {
      enumerable: true,
      get: () => {
        throw new Error("encoder evaluated data beyond the configured bound");
      },
    });
    values.length = 2;

    expect(() => canonicalJsonBounded({ values }, 32)).toThrow(/limit/i);
    const accepted = { z: [true, { b: "β", a: 1 }], a: null };
    expect(canonicalJsonBounded(accepted, 1_024)).toBe(canonicalJson(accepted));
  });

  test("never overwrites a corrupt immutable destination and verifies digests and kinds on read", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-store-"));
    const store = new DurableObjectStore(root);
    const payload = { value: "immutable" };
    const id = sha256Hex(canonicalJson({ storeVersion: 1, kind: "checkpoint", payload }));
    mkdirSync(join(root, "objects"), { recursive: true });
    writeFileSync(join(root, "objects", `${id}.json`), "corrupt");

    await expect(store.put("checkpoint", payload, 1_024)).rejects.toThrow(/digest|immutable/i);
    expect(readFileSync(join(root, "objects", `${id}.json`), "utf8")).toBe("corrupt");
    await expect(store.get(id, "task-run", 1_024)).rejects.toThrow(/digest|kind/i);
    expect(await store.verify(id)).toBe(false);
  });

  test("rejects a self-consistently hashed non-canonical object envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-store-"));
    const store = new DurableObjectStore(root);
    const bytes = '{"kind":"checkpoint","payload":{"z":1,"a":2},"storeVersion":1}';
    const id = sha256Hex(bytes);
    mkdirSync(join(root, "objects"), { recursive: true });
    writeFileSync(join(root, "objects", `${id}.json`), bytes);

    await expect(store.get(id, "checkpoint", 1_024)).rejects.toThrow(/canonical/i);
    expect(await store.verify(id)).toBe(false);
  });

  test("rejects intermediate symlink substitution at the archive I/O boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-store-"));
    const sessionId = "session-123";
    const assignmentId = "assignment-1";
    const outside = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-outside-"));
    const store = new DurableObjectStore(root, {
      beforePathOperation: async (operation) => {
        if (operation !== "link-assignment-archive") return;
        renameSync(join(root, "assignments"), join(root, "assignments-real"));
        symlinkSync(outside, join(root, "assignments"));
      },
    });
    const archiveId = await store.put("assignment", { assignmentId }, MAX_ASSIGNMENT_ARCHIVE_BYTES);
    const paths = sessionStoragePaths(root, sessionId);
    const archiveDirectory = assignmentArchiveDir(paths, assignmentId);
    mkdirSync(join(outside, relative(join(root, "assignments"), archiveDirectory)), { recursive: true });
    const outsideLink = join(outside, relative(join(root, "assignments"), assignmentArchiveLinkPath(paths, assignmentId, archiveId)));

    await expect(store.linkAssignmentArchive(sessionId, assignmentId, archiveId)).rejects.toThrow(/symlink|contain|identity/i);
    expect(() => lstatSync(outsideLink)).toThrow();
  });

  test("hard-links verified assignment archives and verifies hash, kind, byte bound, and original assignment identity on lookup", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-store-"));
    const store = new DurableObjectStore(root);
    const sessionId = "session-123";
    const assignmentId = "assignment/original-id";
    const archive: AssignmentArchiveV1 = {
      assignmentId,
      taskRunId: "run-1",
      taskId: "task-1",
      status: "completed",
      summary: "done",
      criteriaEvidence: [],
      artifacts: [],
      followUps: [],
      runId: "runner-1",
      resultId: "0123456789abcdef0123456789abcdef",
      completedAt: 1,
    };
    const archiveId = await store.put("assignment", archive, MAX_ASSIGNMENT_ARCHIVE_BYTES);
    await store.linkAssignmentArchive(sessionId, assignmentId, archiveId);
    await store.linkAssignmentArchive(sessionId, assignmentId, archiveId);
    const paths = sessionStoragePaths(root, sessionId);
    const linkPath = assignmentArchiveLinkPath(paths, assignmentId, archiveId);

    expect(lstatSync(linkPath).nlink).toBeGreaterThanOrEqual(2);
    expect(Buffer.byteLength(readFileSync(join(root, "objects", `${archiveId}.json`), "utf8"), "utf8")).toBeLessThanOrEqual(MAX_ASSIGNMENT_ARCHIVE_BYTES);
    await expect(store.listAssignmentArchives<AssignmentArchiveV1>(sessionId, assignmentId)).resolves.toEqual([{ archiveId, archive }]);
    await expect(store.get(archiveId, "assignment", 1)).rejects.toThrow(/limit/i);

    const mismatched = await store.put("assignment", { ...archive, assignmentId: "other-assignment" }, MAX_ASSIGNMENT_ARCHIVE_BYTES);
    const mismatchPath = assignmentArchiveLinkPath(paths, assignmentId, mismatched);
    writeFileSync(mismatchPath, readFileSync(join(root, "objects", `${mismatched}.json`)));
    await expect(store.listAssignmentArchives<AssignmentArchiveV1>(sessionId, assignmentId)).resolves.toEqual([{ archiveId, archive }]);
    expect(() => lstatSync(mismatchPath)).toThrow();
  });

  test("installs immutable objects through the pinned original directory after a final-validation swap", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-store-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-outside-"));
    let swapped = false;
    const store = new DurableObjectStore(root, {
      beforePathOperation: (operation) => {
        if (operation !== "install-object") return;
        renameSync(join(root, "objects"), join(root, "objects-real"));
        symlinkSync(outside, join(root, "objects"));
        swapped = true;
      },
    });

    const id = await store.put("checkpoint", { value: "pinned" }, 1_024);

    expect(swapped).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(root, "objects-real", `${id}.json`)).isFile()).toBe(true);
  });

  test("pins both archive-link directories after final validation so swaps cannot write outside root", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-store-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-outside-"));
    const sessionId = "session-123";
    const assignmentId = "assignment-1";
    let swapped = false;
    const store = new DurableObjectStore(root, {
      beforePathOperation: (operation) => {
        if (operation !== "link-assignment-archive-install") return;
        renameSync(join(root, "assignments"), join(root, "assignments-real"));
        symlinkSync(outside, join(root, "assignments"));
        swapped = true;
      },
    });
    const archiveId = await store.put("assignment", { assignmentId }, MAX_ASSIGNMENT_ARCHIVE_BYTES);
    const linkPath = assignmentArchiveLinkPath(sessionStoragePaths(root, sessionId), assignmentId, archiveId);

    await store.linkAssignmentArchive(sessionId, assignmentId, archiveId);

    expect(swapped).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(root, "assignments-real", relative(join(root, "assignments"), linkPath))).nlink).toBeGreaterThanOrEqual(2);
  });

  test("fails closed before mutation when procfs dirfd paths are unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-store-"));
    const store = new DurableObjectStore(root, {
      procDirectoryPath: () => join(root, "unavailable-dirfd"),
    });

    await expect(store.put("checkpoint", { value: "blocked" }, 1_024)).rejects.toThrow(/dirfd|procfs|pinned/i);
    expect(readdirSync(join(root, "objects"))).toEqual([]);
  });

  test("preserves every branch-pinned object and immutable result until its ref is explicitly cleared", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-store-"));
    const store = new DurableObjectStore(root);
    const branchOne = await store.put("checkpoint", { branch: "one" }, 1_024);
    const branchTwo = await store.put("checkpoint", { branch: "two" }, 1_024);
    const cleared = await store.put("checkpoint", { branch: "cleared" }, 1_024);
    const objects = join(root, "objects");
    const old = new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1);
    for (const id of [branchOne, branchTwo, cleared]) utimesSync(join(objects, `${id}.json`), old, old);
    const paths = sessionStoragePaths(root, "session-branches");
    const resultId = "e".repeat(32);
    mkdirSync(paths.resultsDir, { recursive: true });
    writeFileSync(resultFilePath(paths, resultId), "immutable branch result");

    await rewriteSessionRefs(root, "session-branches", new Set([branchOne, branchTwo]));
    const initialRefs = JSON.parse(readFileSync(paths.refsPath, "utf8")) as { checkpointIds: string[] };
    expect(await store.cleanupOrphans(new Set(initialRefs.checkpointIds), Date.now() - 24 * 60 * 60 * 1_000)).toBe(1);
    expect(lstatSync(join(objects, `${branchOne}.json`)).isFile()).toBe(true);
    expect(lstatSync(join(objects, `${branchTwo}.json`)).isFile()).toBe(true);
    expect(readFileSync(resultFilePath(paths, resultId), "utf8")).toBe("immutable branch result");

    await rewriteSessionRefs(root, "session-branches", new Set([branchTwo]));
    const clearedRefs = JSON.parse(readFileSync(paths.refsPath, "utf8")) as { checkpointIds: string[] };
    expect(await store.cleanupOrphans(new Set(clearedRefs.checkpointIds), Date.now() - 24 * 60 * 60 * 1_000)).toBe(1);
    expect(() => lstatSync(join(objects, `${branchOne}.json`))).toThrow();
    expect(lstatSync(join(objects, `${branchTwo}.json`)).isFile()).toBe(true);

    const outside = join(root, "outside-result.json");
    writeFileSync(outside, "outside root");
    symlinkSync(outside, join(objects, `${"f".repeat(64)}.json`));
    await store.cleanupOrphans(new Set([branchTwo]), Date.now() + 1);
    expect(readFileSync(outside, "utf8")).toBe("outside root");
  });

  test("quarantines corrupt objects and only cleans unreferenced objects older than 24 hours without following links", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasked-subagents-store-"));
    const store = new DurableObjectStore(root);
    const retained = await store.put("checkpoint", { retained: true }, 1_024);
    const orphan = await store.put("checkpoint", { orphan: true }, 1_024);
    const corrupt = await store.put("checkpoint", { corrupt: true }, 1_024);
    const objectsDir = join(root, "objects");
    const old = new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1);
    utimesSync(join(objectsDir, `${retained}.json`), old, old);
    utimesSync(join(objectsDir, `${orphan}.json`), old, old);
    writeFileSync(join(objectsDir, `${corrupt}.json`), "bad");

    await store.quarantine(corrupt, "digest mismatch");
    expect(() => lstatSync(join(objectsDir, `${corrupt}.json`))).toThrow();
    expect(readdirSync(join(root, "quarantine")).some((name) => name.startsWith(corrupt))).toBe(true);
    expect(await store.cleanupOrphans(new Set([retained]), Date.now() - 24 * 60 * 60 * 1_000)).toBe(1);
    expect(lstatSync(join(objectsDir, `${retained}.json`)).isFile()).toBe(true);
    expect(() => lstatSync(join(objectsDir, `${orphan}.json`))).toThrow();

    const outside = join(root, "outside.json");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(objectsDir, `${"f".repeat(64)}.json`));
    await store.cleanupOrphans(new Set(), Date.now() + 1);
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });
});
