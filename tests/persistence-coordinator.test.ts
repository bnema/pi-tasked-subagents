import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";

import { TaskedSubagentsController } from "../src/orchestration/controller.js";
import type { RunProgressSnapshot, TaskedSubagentsState } from "../src/types.js";
import {
  syntheticProgress,
  syntheticState,
} from "./persistence-fixtures.js";

const MAX_POINTER_BYTES = 4 * 1024;
const TASK_RUN_COUNT = 100;
const PROGRESS_UPDATES_PER_RUN = 20;
const FIXED_TIME = 1_800_000_000_000;

interface PersistenceProbe {
  restoreState(state: TaskedSubagentsState): void;
  persistState(): void;
  applyRunProgressUpdate(
    taskRunId: string,
    snapshot: RunProgressSnapshot,
    expectedEpoch: number | undefined,
  ): Promise<void>;
}

interface CapturedEntry {
  bytes: number;
  data: unknown;
}

function createCapture(): { pi: ExtensionAPI; entries: CapturedEntry[] } {
  const entries: CapturedEntry[] = [];
  const pi = {
    appendEntry: vi.fn((_customType: string, data: unknown) => {
      entries.push({
        bytes: Buffer.byteLength(JSON.stringify(data), "utf8"),
        data,
      });
    }),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, entries };
}

function asPersistenceProbe(controller: TaskedSubagentsController): PersistenceProbe {
  return controller as unknown as PersistenceProbe;
}

function entryVersion(data: unknown): unknown {
  return typeof data === "object" && data !== null
    ? (data as { version?: unknown }).version
    : undefined;
}

describe("bounded session-state persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("keeps v5 pointers bounded while transient progress does not amplify retained history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TIME);

    const state = syntheticState(TASK_RUN_COUNT);
    const { pi, entries } = createCapture();
    const controller = asPersistenceProbe(new TaskedSubagentsController(pi));
    controller.restoreState(state);

    const beforeUnchangedRequests = entries.length;
    controller.persistState();
    controller.persistState();
    const unchangedProjectionAppendCount = entries.length - beforeUnchangedRequests;

    const beforeProgress = entries.length;
    let globalSequence = 0;
    for (const taskRun of state.taskRuns) {
      const assignment = taskRun.assignments[0];
      for (let sequence = 1; sequence <= PROGRESS_UPDATES_PER_RUN; sequence += 1) {
        globalSequence += 1;
        vi.setSystemTime(FIXED_TIME + globalSequence);
        await controller.applyRunProgressUpdate(
          taskRun.id,
          syntheticProgress(assignment.runId!, assignment.id, sequence),
          undefined,
        );
      }
    }

    const progressOnlyAppendCount = entries.length - beforeProgress;
    const entryBytes = entries.map((entry) => entry.bytes);
    const totalPointerBytes = entryBytes.reduce((total, bytes) => total + bytes, 0);
    const versions = new Set(entries.map((entry) => entryVersion(entry.data)));

    // Target v5 invariants: compact pointers only, durable-projection deduplication,
    // and no append for display-only progress updates.
    expect.soft(versions).toEqual(new Set([5]));
    expect.soft(Math.max(...entryBytes)).toBeLessThanOrEqual(MAX_POINTER_BYTES);
    expect.soft(unchangedProjectionAppendCount).toBe(0);
    expect.soft(progressOnlyAppendCount).toBe(0);
    expect.soft(totalPointerBytes).toBeLessThan(
      TASK_RUN_COUNT * PROGRESS_UPDATES_PER_RUN * MAX_POINTER_BYTES,
    );
  }, 30_000);

  test("demonstrates cumulative full snapshots grow faster than bounded pointers", () => {
    const fullSnapshotBytes = Array.from({ length: TASK_RUN_COUNT }, (_, index) =>
      Buffer.byteLength(JSON.stringify(syntheticState(index + 1)), "utf8"));
    const cumulativeFullSnapshotBytes = fullSnapshotBytes.reduce((total, bytes) => total + bytes, 0);
    const cumulativePointerBudget = TASK_RUN_COUNT * MAX_POINTER_BYTES;

    expect(fullSnapshotBytes.at(-1)).toBeGreaterThan(fullSnapshotBytes[0] * 90);
    expect(cumulativeFullSnapshotBytes).toBeGreaterThan(cumulativePointerBudget * 10);
  });
});
