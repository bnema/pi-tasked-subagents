import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ENTRY_TYPE_STATE, MAX_TASK_RUN_OBJECT_BYTES } from "../src/defaults.js";
import { DurableObjectStore } from "../src/state/object-store.js";
import { restoreBranchState } from "../src/state/restore.js";
import { migrateV4State, ingestLegacyResult } from "../src/state/v4-migration.js";
import { resultFilePath, sessionStoragePaths } from "../src/state/storage-paths.js";
import type { TaskRunRecord, TaskedSubagentsState } from "../src/types.js";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function state(status: TaskRunRecord["status"] = "completed"): TaskedSubagentsState {
  const assignmentStatus = status === "completed" ? "completed" : "running";
  return {
    version: 4,
    currentTaskRunId: "run-1",
    updatedAt: 10,
    taskRuns: [{
      id: "run-1", title: "Generic run", request: "generic request", context: "generic context", status,
      groups: [{ id: "group-1", title: "Group", status: assignmentStatus === "completed" ? "completed" : "running", dependsOn: [], maxConcurrency: 1, createdAt: 1, updatedAt: 10 }],
      tasks: [{ id: "task-1", groupId: "group-1", text: "Generic task", status: assignmentStatus === "completed" ? "completed" : "running", criteria: [], dependsOn: [], assignmentIds: ["assignment-1"], createdAt: 1, updatedAt: 10 }],
      assignments: [{ id: "assignment-1", taskRunId: "run-1", groupId: "group-1", taskId: "task-1", agent: "delegate", prompt: "generic prompt", status: assignmentStatus, runId: "legacy-run", createdAt: 1, updatedAt: 10, ...(assignmentStatus === "completed" ? { completedAt: 10, result: { assignmentId: "assignment-1", status: "completed" as const, summary: "completed", criteriaEvidence: [], artifacts: [], followUps: [], createdAt: 10 } } : {}) }],
      artifacts: [], createdAt: 1, updatedAt: 10, ...(status === "completed" ? { completedAt: 10 } : {}),
    }],
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-v4-"));
  roots.push(value);
  return value;
}

describe("v4 bounded migration", () => {
  test("streams legacy results into full-digest immutable IDs and verifies idempotent reuse", async () => {
    const dataRoot = await root();
    const source = join(dataRoot, "legacy-result.json");
    const contents = JSON.stringify({ report: "generic terminal output" });
    await writeFile(source, contents);
    const paths = sessionStoragePaths(dataRoot, "generic-session");

    const first = await ingestLegacyResult(source, paths);
    expect(first).toEqual({ resultId: createHash("sha256").update(contents).digest("hex") });
    if ("resultId" in first) expect(await readFile(resultFilePath(paths, first.resultId), "utf8")).toBe(contents);
    expect(await ingestLegacyResult(source, paths)).toEqual(first);

    await rm(source);
    expect(await ingestLegacyResult(source, paths)).toEqual({ unavailable: "missing-legacy-result" });
  });

  test("converts terminal history once without retaining the legacy path and explicitly marks unavailable output", async () => {
    const dataRoot = await root();
    const source = join(dataRoot, "legacy-terminal.json");
    await writeFile(source, "generic result");
    const legacy = state();
    legacy.taskRuns[0].assignments[0].result!.rawResultPath = source;
    const appended: unknown[] = [];
    const migrated = await migrateV4State(legacy, new DurableObjectStore(dataRoot), {
      sessionId: "generic-session",
      appendMigratedPointer: (pointer) => appended.push(pointer),
    });

    expect(migrated.migrated).toBe(true);
    expect(appended).toHaveLength(1);
    if (!migrated.migrated) return;
    expect(migrated.state.taskRuns).toHaveLength(1);
    expect(migrated.state.taskRuns[0].groups).toEqual([]);
    const archive = await new DurableObjectStore(dataRoot).get<Record<string, unknown>>(migrated.archiveRefs[0].archiveId, "assignment", 256 * 1024);
    expect(archive.resultId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(archive)).not.toContain(source);

    const missing = state();
    missing.taskRuns[0].assignments[0].result!.rawResultPath = join(dataRoot, "missing-result.json");
    const missingMigration = await migrateV4State(missing, new DurableObjectStore(dataRoot), {
      sessionId: "missing-session", appendMigratedPointer: () => undefined,
    });
    expect(missingMigration.migrated).toBe(true);
    if (missingMigration.migrated) {
      const unavailable = await new DurableObjectStore(dataRoot).get<Record<string, unknown>>(missingMigration.archiveRefs[0].archiveId, "assignment", 256 * 1024);
      expect(unavailable).toMatchObject({ resultUnavailableReason: "missing-legacy-result" });
      expect(unavailable).not.toHaveProperty("resultId");
    }
  });

  test("selects the newest valid v4 candidate and restores the one emitted v5 pointer", async () => {
    const dataRoot = await root();
    const older = state();
    const malformed = state();
    malformed.taskRuns[0].tasks.push({} as never);
    const appended: unknown[] = [];
    const result = await restoreBranchState([
      { type: "custom", customType: ENTRY_TYPE_STATE, data: older },
      { type: "custom", customType: ENTRY_TYPE_STATE, data: malformed },
    ], new DurableObjectStore(dataRoot), {
      sessionId: "generic-session",
      allEntries: [],
      appendMigratedPointer: (pointer) => appended.push(pointer),
    });

    expect(result).toMatchObject({ restored: true, migrated: true });
    expect(appended).toHaveLength(1);
    if (!result.restored) return;
    const reloaded = await restoreBranchState([
      { type: "custom", customType: ENTRY_TYPE_STATE, data: result.pointer },
    ], new DurableObjectStore(dataRoot), {
      sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => { throw new Error("v4 must not be re-emitted"); },
    });
    expect(reloaded).toMatchObject({ restored: true, migrated: false, pointer: result.pointer });
  });

  test("uses the next visible v5 sequence in both the manifest and pointer", async () => {
    const dataRoot = await root();
    const legacy = state("running");
    const appended: unknown[] = [];
    const migrated = await restoreBranchState([
      { type: "custom", customType: ENTRY_TYPE_STATE, data: legacy },
      { type: "custom", customType: ENTRY_TYPE_STATE, data: { version: 5, checkpointId: "0".repeat(64), sequence: 7, writtenAt: 10 } },
    ], new DurableObjectStore(dataRoot), {
      sessionId: "generic-session", allEntries: [], appendMigratedPointer: (pointer) => appended.push(pointer),
    });

    expect(migrated).toMatchObject({ restored: true, migrated: true, pointer: { sequence: 8 } });
    expect(appended).toEqual([migrated.restored ? migrated.pointer : undefined]);
    if (!migrated.restored) return;
    const reloaded = await restoreBranchState([
      { type: "custom", customType: ENTRY_TYPE_STATE, data: migrated.pointer },
    ], new DurableObjectStore(dataRoot), {
      sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => { throw new Error("v4 must not be re-emitted"); },
    });
    expect(reloaded).toMatchObject({ restored: true, migrated: false, pointer: migrated.pointer });
  });

  test("falls back from malformed v4 scalar, status, and graph-reference candidates and refuses them alone", async () => {
    const corruptions: Array<(candidate: TaskedSubagentsState) => void> = [
      (candidate) => { (candidate.taskRuns[0] as unknown as { title: unknown }).title = 17; },
      (candidate) => { (candidate.taskRuns[0].tasks[0] as unknown as { status: unknown }).status = "unknown"; },
      (candidate) => { candidate.taskRuns[0].tasks[0].dependsOn = ["missing-task"]; },
      (candidate) => { candidate.taskRuns[0].assignments[0].groupId = "missing-group"; },
      (candidate) => { candidate.taskRuns[0].assignments[0].launchRef = { runId: 17, asyncId: "legacy-run", assignments: [] } as never; },
    ];

    for (const corrupt of corruptions) {
      const dataRoot = await root();
      const older = state();
      older.taskRuns[0].title = "Older valid run";
      const malformed = state();
      corrupt(malformed);
      const fallback = await restoreBranchState([
        { type: "custom", customType: ENTRY_TYPE_STATE, data: older },
        { type: "custom", customType: ENTRY_TYPE_STATE, data: malformed },
      ], new DurableObjectStore(dataRoot), {
        sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => undefined,
      });
      expect(fallback).toMatchObject({ restored: true, migrated: true, state: { taskRuns: [{ title: "Older valid run" }] } });
    }

    const dataRoot = await root();
    const malformed = state();
    (malformed.taskRuns[0] as unknown as { title: unknown }).title = 17;
    const refused = await restoreBranchState([
      { type: "custom", customType: ENTRY_TYPE_STATE, data: malformed },
    ], new DurableObjectStore(dataRoot), {
      sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => undefined,
    });
    expect(refused).toMatchObject({ restored: false, hasV4Candidate: true });
  });

  test("retains a live legacy runner without a terminal result as an actionable migration-only handle", async () => {
    const dataRoot = await root();
    const asyncDir = join(dataRoot, "legacy-async");
    const resultPath = join(dataRoot, "legacy-results", "legacy-run.json");
    await mkdir(asyncDir, { recursive: true });
    await writeFile(join(asyncDir, "status.json"), JSON.stringify({
      runId: "legacy-run",
      state: "running",
      pid: process.pid,
      steps: [{ id: "assignment-1", status: "running", pid: process.pid }],
    }));
    const active = state("running");
    active.taskRuns[0].assignments[0].launchRef = {
      legacy: true,
      runId: "legacy-run",
      asyncId: "legacy-run",
      asyncDir,
      resultPath,
      assignments: [{ assignmentId: "assignment-1", runId: "legacy-run", resultPath }],
    };

    const migrated = await migrateV4State(active, new DurableObjectStore(dataRoot), {
      sessionId: "generic-session", appendMigratedPointer: () => undefined,
    });

    expect(migrated.migrated).toBe(true);
    if (!migrated.migrated) return;
    const assignment = migrated.state.taskRuns[0].assignments[0];
    expect(migrated.state.taskRuns[0].status).toBe("running");
    expect(assignment).toMatchObject({
      status: "running",
      launchRef: { legacy: true, runId: "legacy-run", asyncId: "legacy-run", asyncDir },
    });
    expect(assignment.result).toBeUndefined();
    expect(JSON.stringify(migrated.pointer)).not.toContain(asyncDir);
    expect(JSON.stringify(migrated.archiveRefs)).not.toContain(asyncDir);
  });

  test("preserves actionable state, moves missing active handles to attention, and refuses oversized active data", async () => {
    const dataRoot = await root();
    const active = state("running");
    active.taskRuns[0].assignments[0].launchRef = {
      legacy: true, runId: "legacy-run", asyncId: "legacy-run", resultPath: join(dataRoot, "missing-live-result.json"), assignments: [{ assignmentId: "assignment-1", runId: "legacy-run" }],
    };
    const migrated = await migrateV4State(active, new DurableObjectStore(dataRoot), {
      sessionId: "generic-session", appendMigratedPointer: () => undefined,
    });
    expect(migrated.migrated).toBe(true);
    if (migrated.migrated) {
      const assignment = migrated.state.taskRuns[0].assignments[0];
      expect(migrated.state.taskRuns[0].status).toBe("attention");
      expect(assignment).toMatchObject({ status: "attention", result: { status: "attention" } });
    }

    const invalidAsyncDir = join(dataRoot, "invalid-legacy-async");
    await mkdir(invalidAsyncDir, { recursive: true });
    await writeFile(join(invalidAsyncDir, "status.json"), JSON.stringify({
      runId: "different-run", state: "running", pid: process.pid,
    }));
    const invalid = state("running");
    invalid.taskRuns[0].assignments[0].launchRef = {
      legacy: true, runId: "legacy-run", asyncId: "legacy-run", asyncDir: invalidAsyncDir,
      assignments: [{ assignmentId: "assignment-1", runId: "legacy-run" }],
    };
    const invalidMigration = await migrateV4State(invalid, new DurableObjectStore(dataRoot), {
      sessionId: "invalid-session", appendMigratedPointer: () => undefined,
    });
    expect(invalidMigration).toMatchObject({
      migrated: true,
      state: { taskRuns: [{ status: "attention", assignments: [{ status: "attention" }] }] },
    });

    const terminalAsyncDir = join(dataRoot, "terminal-legacy-async");
    const terminalResultPath = join(dataRoot, "terminal-legacy-results", "legacy-run.json");
    await mkdir(terminalAsyncDir, { recursive: true });
    await mkdir(join(dataRoot, "terminal-legacy-results"), { recursive: true });
    await writeFile(terminalResultPath, JSON.stringify({ state: "complete" }));
    const terminal = state("running");
    terminal.taskRuns[0].assignments[0].launchRef = {
      legacy: true, runId: "legacy-run", asyncId: "legacy-run", asyncDir: terminalAsyncDir,
      resultPath: terminalResultPath,
      assignments: [{ assignmentId: "assignment-1", runId: "legacy-run", resultPath: terminalResultPath }],
    };
    const terminalMigration = await migrateV4State(terminal, new DurableObjectStore(dataRoot), {
      sessionId: "terminal-session", appendMigratedPointer: () => undefined,
    });
    expect(terminalMigration).toMatchObject({
      migrated: true,
      state: { taskRuns: [{ status: "running", assignments: [{ status: "running", launchRef: { legacy: true } }] }] },
    });

    const oversized = state("running");
    oversized.taskRuns[0].context = "x".repeat(MAX_TASK_RUN_OBJECT_BYTES);
    const rejected = await migrateV4State(oversized, new DurableObjectStore(dataRoot), {
      sessionId: "oversized-session", appendMigratedPointer: () => undefined,
    });
    expect(rejected).toMatchObject({ migrated: false, reason: "limit_exceeded" });
  });
});
