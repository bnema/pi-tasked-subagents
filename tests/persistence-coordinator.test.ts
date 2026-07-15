import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_CHECKPOINT_BYTES,
  MAX_POINTER_BYTES,
  MAX_RECENT_COMPLETED,
  MAX_TASK_RUN_OBJECT_BYTES,
} from "../src/defaults.js";
import {
  PersistenceCoordinator,
  type CheckpointContext,
  type PointerAppender,
} from "../src/state/persistence-coordinator.js";
import { DurableObjectStore } from "../src/state/object-store.js";
import type { StatePointerV5 } from "../src/state/durable-types.js";
import { sessionStoragePaths } from "../src/state/storage-paths.js";
import { restoreBranchState } from "../src/state/restore.js";
import type { TaskedSubagentsState } from "../src/types.js";
import { syntheticState, syntheticTaskRun } from "./persistence-fixtures.js";

const SESSION_ID = "generic-session";
const context = (visiblePointers: readonly StatePointerV5[] = [], sessionId = SESSION_ID): CheckpointContext => ({
  sessionId,
  visiblePointers,
  now: 1_800_000_000_000,
});

class CapturingAppender implements PointerAppender {
  readonly pointers: StatePointerV5[] = [];
  fail = false;

  append(pointer: StatePointerV5): void {
    if (this.fail) throw new Error("append unavailable");
    this.pointers.push(pointer);
  }
}

class TracingStore {
  readonly calls: string[] = [];
  private nextId = 0;
  gate?: Promise<void>;

  async put(kind: "checkpoint" | "task-run" | "assignment", _payload: unknown, _maxBytes: number): Promise<string> {
    this.calls.push(kind);
    await this.gate;
    this.nextId += 1;
    return `${this.nextId}`.padStart(64, "0");
  }
}

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function coordinator(appender = new CapturingAppender()) {
  const root = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-coordinator-"));
  roots.push(root);
  return { root, appender, coordinator: new PersistenceCoordinator(new DurableObjectStore(root), appender) };
}

describe("PersistenceCoordinator", () => {
  it("deduplicates unchanged projections and appends no pointer for pure progress projections", async () => {
    const { coordinator: subject, appender } = await coordinator();
    const state = syntheticState(100);

    await expect(subject.checkpoint(state, context())).resolves.toMatchObject({ committed: true, deduplicated: false });
    await expect(subject.checkpoint(structuredClone(state), context())).resolves.toMatchObject({ committed: true, deduplicated: true });

    for (const run of state.taskRuns) {
      run.assignments[0].currentTool = "display-only-progress";
      run.assignments[0].lastActionAt = 1_800_000_000_123;
      run.assignments[0].recentActivity = ["generic activity"];
      await expect(subject.checkpoint(structuredClone(state), context())).resolves.toMatchObject({ committed: true, deduplicated: true });
    }

    expect(appender.pointers).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(appender.pointers[0]), "utf8")).toBeLessThanOrEqual(MAX_POINTER_BYTES);
  });

  it("writes task-run objects and manifest before refs and the Pi pointer", async () => {
    const store = new TracingStore();
    const appender = new CapturingAppender();
    const root = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-coordinator-"));
    roots.push(root);
    const subject = new PersistenceCoordinator(store, appender, { dataRoot: root, onRefsWritten: () => store.calls.push("refs") });
    const state = syntheticState(0);
    state.taskRuns = [syntheticTaskRun(1, "running")];

    await expect(subject.checkpoint(state, context())).resolves.toMatchObject({ committed: true });
    expect(store.calls).toEqual(["task-run", "checkpoint", "refs"]);
    expect(appender.pointers).toHaveLength(1);
  });

  it("retains the exact dirty snapshot after append failure and retries it", async () => {
    const { root, coordinator: subject, appender } = await coordinator();
    const state = syntheticState(0);
    state.taskRuns = [syntheticTaskRun(1, "running")];
    await expect(subject.checkpoint(state, context())).resolves.toMatchObject({ committed: true });
    const previousAuthority = appender.pointers[0];
    state.taskRuns[0].title = "durable title";
    appender.fail = true;

    await expect(subject.checkpoint(state, context())).resolves.toMatchObject({ committed: false, dirty: true });
    expect(appender.pointers).toEqual([previousAuthority]);
    state.taskRuns[0].title = "mutated after failed durability";
    appender.fail = false;

    const retried = await subject.retryDirty(context());
    expect(retried).toMatchObject({ committed: true, deduplicated: false });
    if (!retried.committed) throw new Error("retry should commit");
    const store = new DurableObjectStore(root);
    const manifest = await store.get<{ recoverableRuns: Array<{ objectId: string }> }>(retried.pointer.checkpointId, "checkpoint", 256 * 1024);
    const run = await store.get<{ title: string }>(manifest.recoverableRuns[0].objectId, "task-run", 2 * 1024 * 1024);
    expect(run.title).toBe("durable title");
    await expect(subject.flush(context())).resolves.toBeUndefined();
  });

  it("unions all visible branch references and fences stale invalidated writes", async () => {
    const { root, coordinator: subject } = await coordinator();
    const oldPointer: StatePointerV5 = { version: 5, checkpointId: "a".repeat(64), sequence: 7, writtenAt: 1 };
    const first = await subject.checkpoint(syntheticState(0), context([oldPointer]));
    if (!first.committed) throw new Error("first checkpoint should commit");
    const changed = syntheticState(0);
    changed.currentTaskRunId = "next-task-run";
    const second = await subject.checkpoint(changed, context([oldPointer]));
    if (!second.committed) throw new Error("second checkpoint should commit");
    const refs = JSON.parse(await readFile(sessionStoragePaths(root, SESSION_ID).refsPath, "utf8")) as { checkpointIds: string[] };
    expect(refs.checkpointIds).toEqual(expect.arrayContaining([oldPointer.checkpointId, first.pointer.checkpointId, second.pointer.checkpointId]));

    const tracingStore = new TracingStore();
    let release!: () => void;
    tracingStore.gate = new Promise<void>((resolve) => { release = resolve; });
    const staleRoot = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-coordinator-"));
    roots.push(staleRoot);
    const staleAppender = new CapturingAppender();
    const stale = new PersistenceCoordinator(tracingStore, staleAppender, { dataRoot: staleRoot, onRefsWritten: () => tracingStore.calls.push("refs") });
    const pending = stale.checkpoint(syntheticState(0), context([oldPointer]));
    await vi.waitFor(() => expect(tracingStore.calls).toContain("checkpoint"));
    stale.invalidate(1);
    release();

    await expect(pending).resolves.toMatchObject({ committed: false, dirty: true });
    expect(tracingStore.calls).not.toContain("refs");
    expect(staleAppender.pointers).toHaveLength(0);
  });

  it("fences dirty snapshots captured before an invalidated epoch", async () => {
    const { coordinator: subject, appender } = await coordinator();
    const state = syntheticState(0);
    appender.fail = true;

    await expect(subject.checkpoint(state, context())).resolves.toMatchObject({ committed: false, dirty: true, error: { code: "pointer_append" } });
    subject.invalidate(1);
    appender.fail = false;

    await expect(subject.retryDirty(context())).resolves.toMatchObject({ committed: false, dirty: true, error: { code: "stale_generation" } });
    expect(appender.pointers).toHaveLength(0);
  });

  it("rejects dirty retries from a different session", async () => {
    const { coordinator: subject, appender } = await coordinator();
    appender.fail = true;
    await expect(subject.checkpoint(syntheticState(0), context())).resolves.toMatchObject({ committed: false, dirty: true });
    appender.fail = false;

    await expect(subject.retryDirty(context([], "other-session"))).resolves.toMatchObject({
      committed: false,
      dirty: true,
      error: { code: "session_mismatch" },
    });
    expect(appender.pointers).toHaveLength(0);
  });

  it("resets session-scoped dedupe and references after a generation change", async () => {
    const store = new TracingStore();
    const appender = new CapturingAppender();
    const root = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-coordinator-"));
    roots.push(root);
    const subject = new PersistenceCoordinator(store, appender, { dataRoot: root });
    const state = syntheticState(0);

    await expect(subject.checkpoint(state, context())).resolves.toMatchObject({ committed: true, deduplicated: false });
    subject.invalidate(1);
    await expect(subject.checkpoint(structuredClone(state), context())).resolves.toMatchObject({ committed: true, deduplicated: false });

    expect(store.calls.filter((call) => call === "checkpoint")).toHaveLength(2);
    const refs = JSON.parse(await readFile(sessionStoragePaths(root, SESSION_ID).refsPath, "utf8")) as { checkpointIds: string[] };
    expect(refs.checkpointIds).toEqual(["0000000000000000000000000000000000000000000000000000000000000002"]);
  });

  it("fails closed when session context is missing", async () => {
    const { coordinator: subject, appender } = await coordinator();
    const missingSession = { sessionId: "", visiblePointers: [] } as CheckpointContext;

    await expect(subject.checkpoint(syntheticState(0), missingSession)).resolves.toMatchObject({
      committed: false,
      dirty: true,
      error: { code: "session_mismatch" },
    });
    expect(appender.pointers).toHaveLength(0);
  });

  it("never appends a pointer above 4 KiB", async () => {
    const { coordinator: subject, appender } = await coordinator();
    const state: TaskedSubagentsState = { version: 4, taskRuns: [], currentTaskRunId: "x".repeat(MAX_POINTER_BYTES), updatedAt: 1 };

    await expect(subject.checkpoint(state, context())).resolves.toMatchObject({ committed: false, dirty: true });
    expect(appender.pointers).toHaveLength(0);
  });

  it("keeps 100-run branch resume stress bounded while 2,000 transient progress updates append zero pointers", async () => {
    const { root, coordinator: subject, appender } = await coordinator();
    const originalBranch = syntheticState(100);
    const original = await subject.checkpoint(originalBranch, context());
    if (!original.committed) throw new Error("original branch checkpoint should commit");

    const resumedBranch = structuredClone(originalBranch);
    const active = syntheticTaskRun(101, "running");
    resumedBranch.taskRuns.push(active);
    resumedBranch.currentTaskRunId = active.id;
    resumedBranch.updatedAt += 1;
    const resumed = await subject.checkpoint(resumedBranch, context([original.pointer]));
    if (!resumed.committed) throw new Error("resumed branch checkpoint should commit");
    const pointerCountBeforeProgress = appender.pointers.length;

    for (let run = 0; run < 100; run += 1) {
      for (let update = 0; update < 20; update += 1) {
        active.assignments[0].currentTool = `generic-tool-${run}-${update}`;
        active.assignments[0].lastActionAt = 1_800_000_000_000 + run * 20 + update;
        active.assignments[0].lastActionSummary = `generic progress ${run}-${update}`;
        active.assignments[0].recentActivity = [`generic activity ${run}-${update}`];
        await expect(subject.checkpoint(resumedBranch, context([original.pointer, resumed.pointer])))
          .resolves.toMatchObject({ committed: true, deduplicated: true });
      }
    }

    expect(appender.pointers).toHaveLength(pointerCountBeforeProgress);
    expect(appender.pointers.every((pointer) => Buffer.byteLength(JSON.stringify(pointer), "utf8") <= MAX_POINTER_BYTES)).toBe(true);

    const store = new DurableObjectStore(root);
    const manifest = await store.get<{
      recentCompleted: Array<{ taskRunId: string }>;
      recoverableRuns: Array<{ objectId: string }>;
    }>(resumed.pointer.checkpointId, "checkpoint", MAX_CHECKPOINT_BYTES);
    expect(manifest.recentCompleted).toHaveLength(MAX_RECENT_COMPLETED);
    expect(manifest.recentCompleted.map((summary) => summary.taskRunId)).toEqual(
      Array.from({ length: MAX_RECENT_COMPLETED }, (_, index) => `task-run-${String(100 - index).padStart(3, "0")}`),
    );
    expect(manifest.recoverableRuns).toHaveLength(1);
    const [activeObject] = manifest.recoverableRuns;
    expect(Buffer.byteLength(await readFile(join(root, "objects", `${resumed.pointer.checkpointId}.json`)), "utf8")).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
    expect(Buffer.byteLength(await readFile(join(root, "objects", `${activeObject.objectId}.json`)), "utf8")).toBeLessThanOrEqual(MAX_TASK_RUN_OBJECT_BYTES);

    const entry = (pointer: StatePointerV5) => ({ type: "custom" as const, customType: "pi-tasked-subagents:state", data: pointer });
    const restoreContext = {
      sessionId: SESSION_ID,
      allEntries: [entry(original.pointer), entry(resumed.pointer)],
      appendMigratedPointer: () => { throw new Error("v5 stress branches must not migrate"); },
    };
    const originalRestore = await restoreBranchState([entry(original.pointer)], store, restoreContext);
    const resumedRestore = await restoreBranchState([entry(original.pointer), entry(resumed.pointer)], store, restoreContext);

    expect(originalRestore).toMatchObject({ restored: true });
    expect(resumedRestore).toMatchObject({ restored: true });
    if (!originalRestore.restored || !resumedRestore.restored) throw new Error("both immutable branch checkpoints should restore");
    expect(originalRestore.state.taskRuns).toHaveLength(0);
    expect(originalRestore.state.completedHistory).toHaveLength(MAX_RECENT_COMPLETED);
    expect(resumedRestore.state.taskRuns).toMatchObject([{ id: "task-run-101", status: "running" }]);
    expect(resumedRestore.state.completedHistory).toHaveLength(MAX_RECENT_COMPLETED);
  }, 30_000);
});
