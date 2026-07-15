import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ENTRY_TYPE_STATE } from "../src/defaults.js";
import type { CheckpointManifestV1, StatePointerV5 } from "../src/state/durable-types.js";
import { DurableObjectStore } from "../src/state/object-store.js";
import { sha256Hex } from "../src/state/canonical-json.js";
import { buildStateEntryData, restoreStateFromSessionEntries, stateFromEntryData } from "../src/state/persistence.js";
import { restoreBranchState } from "../src/state/restore.js";
import { createEmptyState, deserializeState, ensureState, serializeState } from "../src/state/store.js";
import { sessionStoragePaths } from "../src/state/storage-paths.js";
import type { TaskRunRecord, TaskedSubagentsState } from "../src/types.js";

const taskRun = {
  id: "task-run-1",
  title: "Task run",
  request: "Do it",
  context: "Shared context",
  status: "running",
  groups: [{
    id: "group-1",
    title: "Group",
    status: "running",
    dependsOn: [],
    maxConcurrency: 2,
    createdAt: 1,
    updatedAt: 1,
  }],
  tasks: [{
    id: "task-1",
    groupId: "group-1",
    text: "Do task",
    status: "running",
    criteria: [{
      id: "C1",
      text: "Done",
      satisfied: true,
      evidence: [{
        criterionId: "C1",
        assignmentId: "assignment-1",
        summary: "done",
        createdAt: 1,
      }],
    }],
    dependsOn: [],
    assignmentIds: ["assignment-1"],
    createdAt: 1,
    updatedAt: 1,
  }],
  assignments: [{
    id: "assignment-1",
    taskRunId: "task-run-1",
    groupId: "group-1",
    taskId: "task-1",
    agent: "delegate",
    prompt: "Do task",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
  }],
  artifacts: [{
    label: "Report",
    path: "local://report.md",
    assignmentId: "assignment-1",
    taskRunId: "task-run-1",
    groupId: "group-1",
    taskId: "task-1",
  }],
  maxConcurrency: 2,
  createdAt: 1,
  updatedAt: 1,
} satisfies TaskRunRecord;

const currentState = {
  version: 4,
  taskRuns: [taskRun],
  currentTaskRunId: "task-run-1",
  updatedAt: 1,
} satisfies TaskedSubagentsState;

function taskRunWithId(id: string): TaskRunRecord {
  return {
    ...taskRun,
    id,
    title: `Task run ${id}`,
    tasks: [],
    assignments: [],
    artifacts: [],
  };
}

let storageRoots: string[] = [];
afterEach(async () => {
  await Promise.all(storageRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function v5Checkpoint(store: DurableObjectStore, state: TaskedSubagentsState, sequence: number): Promise<StatePointerV5> {
  const recoverableRuns = await Promise.all(state.taskRuns.map(async (run) => ({
    taskRunId: run.id,
    status: run.status as "pending" | "running" | "attention" | "failed",
    objectId: await store.put("task-run", run, 2 * 1024 * 1024),
    updatedAt: run.updatedAt,
  })));
  const manifest: CheckpointManifestV1 = {
    checkpointVersion: 1,
    sessionId: "generic-session",
    sequence,
    ...(state.currentTaskRunId === undefined ? {} : { currentTaskRunId: state.currentTaskRunId }),
    recoverableRuns,
    recentCompleted: [],
    recentAssignmentRefs: [],
    updatedAt: state.updatedAt,
  };
  return {
    version: 5,
    checkpointId: await store.put("checkpoint", manifest, 256 * 1024),
    ...(state.currentTaskRunId === undefined ? {} : { currentTaskRunId: state.currentTaskRunId }),
    sequence,
    writtenAt: sequence,
  };
}

function v5Entry(pointer: StatePointerV5) {
  return { type: "custom", customType: ENTRY_TYPE_STATE, data: pointer };
}

describe("task-run state store", () => {
  test("creates empty v4 task-run state", () => {
    const state = createEmptyState();

    expect(state).toMatchObject({ version: 4, taskRuns: [] });
    expect(state.currentTaskRunId).toBeUndefined();
    expect("plans" in state).toBe(false);
  });

  test("resets v1, v2, and v3 state instead of migrating plans", () => {
    for (const version of [1, 2, 3]) {
      const state = ensureState({ version, plans: [{ id: "plan-1" }], currentPlanId: "plan-1", updatedAt: 1 });

      expect(state).toMatchObject({ version: 4, taskRuns: [] });
      expect(state.currentTaskRunId).toBeUndefined();
    }
  });

  test("round-trips valid v4 task-run state", () => {
    const serialized = serializeState(currentState);

    expect(deserializeState(serialized)).toEqual(currentState);
  });

  test("preserves expansion mode when restoring task-run state", () => {
    const expandableState: TaskedSubagentsState = structuredClone(currentState);
    expandableState.taskRuns[0].tasks[0].expansionMode = "append_tasks";

    const restored = deserializeState(serializeState(expandableState));

    expect(restored.taskRuns[0].tasks[0].expansionMode).toBe("append_tasks");
  });

  test("preserves valid assignment supersession metadata when restoring state", () => {
    const supersededState: TaskedSubagentsState = structuredClone(currentState);
    const old = supersededState.taskRuns[0].assignments[0];
    old.supersededAt = 2;
    old.supersededByAssignmentId = "assignment-2";
    const replacement = { ...old, id: "assignment-2", status: "completed" as const, createdAt: 2, updatedAt: 2 };
    delete replacement.supersededAt;
    delete replacement.supersededByAssignmentId;
    supersededState.taskRuns[0].assignments.push(replacement);
    supersededState.taskRuns[0].tasks[0].assignmentIds.push(replacement.id);

    const restored = deserializeState(serializeState(supersededState));

    expect(restored.taskRuns[0].assignments[0]).toMatchObject({
      supersededAt: 2,
      supersededByAssignmentId: "assignment-2",
    });
  });

  test("repairs contradictory assignment supersession metadata when restoring state", () => {
    const supersededState: TaskedSubagentsState = structuredClone(currentState);
    const old = supersededState.taskRuns[0].assignments[0];
    old.supersededAt = 99;
    old.supersededByAssignmentId = "missing";
    const replacement = { ...old, id: "assignment-2", status: "completed" as const, createdAt: 2, updatedAt: 2 };
    replacement.supersededAt = 100;
    replacement.supersededByAssignmentId = replacement.id;
    supersededState.taskRuns[0].assignments.push(replacement);
    supersededState.taskRuns[0].tasks[0].assignmentIds.push(replacement.id);

    const restored = deserializeState(serializeState(supersededState));

    expect(restored.taskRuns[0].assignments[0]).toMatchObject({
      supersededAt: 2,
      supersededByAssignmentId: "assignment-2",
    });
    expect(restored.taskRuns[0].assignments[1].supersededAt).toBeUndefined();
    expect(restored.taskRuns[0].assignments[1].supersededByAssignmentId).toBeUndefined();
  });

  test("infers supersession for historical attempts restored without metadata", () => {
    const historicalState: TaskedSubagentsState = structuredClone(currentState);
    const old = historicalState.taskRuns[0].assignments[0];
    old.status = "failed";
    const replacement = { ...old, id: "assignment-2", status: "completed" as const, createdAt: 2, updatedAt: 2 };
    historicalState.taskRuns[0].assignments.push(replacement);
    historicalState.taskRuns[0].tasks[0].assignmentIds.push(replacement.id);

    const restored = deserializeState(serializeState(historicalState));

    expect(restored.taskRuns[0].assignments[0]).toMatchObject({
      supersededAt: 2,
      supersededByAssignmentId: "assignment-2",
    });
    expect(restored.taskRuns[0].assignments[1].supersededAt).toBeUndefined();
  });

  test("resets serialized v3 state to empty current-version state", () => {
    const serialized = JSON.stringify({ version: 3, plans: [{ id: "plan-1" }], currentPlanId: "plan-1", updatedAt: 1 });

    expect(deserializeState(serialized)).toMatchObject({ version: 4, taskRuns: [] });
  });

  test("restores the last valid custom state entry and currentTaskRunId", () => {
    const newerState = {
      ...currentState,
      taskRuns: [taskRunWithId("task-run-2")],
      currentTaskRunId: "task-run-2",
      updatedAt: 2,
    } satisfies TaskedSubagentsState;

    const restored = restoreStateFromSessionEntries([
      { type: "custom", customType: ENTRY_TYPE_STATE, data: currentState },
      { type: "custom", customType: ENTRY_TYPE_STATE, data: JSON.stringify(newerState) },
      { type: "custom", customType: ENTRY_TYPE_STATE, data: { version: 3, plans: [{ id: "plan-1" }], currentPlanId: "plan-1" } },
    ]);

    expect(restored.currentTaskRunId).toBe("task-run-2");
    expect(restored.taskRuns.map((run) => run.id)).toEqual(["task-run-2"]);
  });

  test("skips later malformed non-empty v4 state entries without replacing an earlier valid state", () => {
    const restored = restoreStateFromSessionEntries([
      { type: "custom", customType: ENTRY_TYPE_STATE, data: currentState },
      {
        type: "custom",
        customType: ENTRY_TYPE_STATE,
        data: {
          version: 4,
          taskRuns: [{ id: "invalid-task-run" }],
          updatedAt: 2,
        },
      },
    ]);

    expect(restored.currentTaskRunId).toBe("task-run-1");
    expect(restored.taskRuns.map((run) => run.id)).toEqual(["task-run-1"]);
  });

  test("skips later partially malformed non-empty v4 state entries without replacing an earlier valid state", () => {
    const restored = restoreStateFromSessionEntries([
      { type: "custom", customType: ENTRY_TYPE_STATE, data: currentState },
      {
        type: "custom",
        customType: ENTRY_TYPE_STATE,
        data: {
          version: 4,
          taskRuns: [
            taskRunWithId("task-run-2"),
            { id: "invalid-task-run" },
          ],
          currentTaskRunId: "task-run-2",
          updatedAt: 2,
        },
      },
    ]);

    expect(restored.currentTaskRunId).toBe("task-run-1");
    expect(restored.taskRuns.map((run) => run.id)).toEqual(["task-run-1"]);
  });

  test("skips later v4 entries when nested arrays lose records during normalization", () => {
    const validResultArtifact = {
      label: "Nested report",
      path: "local://nested-report.md",
      assignmentId: "assignment-1",
      taskRunId: "task-run-2",
      groupId: "group-1",
      taskId: "task-1",
    };
    const validCriteriaEvidence = { criteriaIndex: 0, criterionId: "C1", evidence: "done" };
    const cases: Array<[string, (rawTaskRun: Record<string, unknown>) => void]> = [
      ["group", (rawTaskRun) => { rawTaskRun.groups = [taskRun.groups[0], {}]; }],
      ["task", (rawTaskRun) => { rawTaskRun.tasks = [taskRun.tasks[0], {}]; }],
      ["assignment", (rawTaskRun) => { rawTaskRun.assignments = [taskRun.assignments[0], {}]; }],
      ["artifact", (rawTaskRun) => { rawTaskRun.artifacts = [taskRun.artifacts[0], {}]; }],
      ["task criterion", (rawTaskRun) => {
        rawTaskRun.tasks = [{
          ...taskRun.tasks[0],
          criteria: [taskRun.tasks[0].criteria[0], { id: "C2", text: "" }],
        }];
      }],
      ["task evidence", (rawTaskRun) => {
        rawTaskRun.tasks = [{
          ...taskRun.tasks[0],
          criteria: [{
            ...taskRun.tasks[0].criteria[0],
            evidence: [taskRun.tasks[0].criteria[0].evidence[0], {}],
          }],
        }];
      }],
      ["result criteria evidence", (rawTaskRun) => {
        rawTaskRun.assignments = [{
          ...taskRun.assignments[0],
          result: {
            assignmentId: "assignment-1",
            status: "completed",
            summary: "done",
            criteriaEvidence: [validCriteriaEvidence, {}],
            artifacts: [],
            followUps: [],
            createdAt: 1,
          },
        }];
      }],
      ["result artifact", (rawTaskRun) => {
        rawTaskRun.assignments = [{
          ...taskRun.assignments[0],
          result: {
            assignmentId: "assignment-1",
            status: "completed",
            summary: "done",
            criteriaEvidence: [],
            artifacts: [validResultArtifact, {}],
            followUps: [],
            createdAt: 1,
          },
        }];
      }],
      ["result follow-up", (rawTaskRun) => {
        rawTaskRun.assignments = [{
          ...taskRun.assignments[0],
          result: {
            assignmentId: "assignment-1",
            status: "completed",
            summary: "done",
            criteriaEvidence: [],
            artifacts: [],
            followUps: ["next", {}],
            createdAt: 1,
          },
        }];
      }],
    ];

    for (const [name, corrupt] of cases) {
      const laterTaskRun: Record<string, unknown> = {
        ...taskRun,
        id: "task-run-2",
        title: `Task run 2 with invalid nested ${name}`,
      };
      corrupt(laterTaskRun);

      const restored = restoreStateFromSessionEntries([
        { type: "custom", customType: ENTRY_TYPE_STATE, data: currentState },
        {
          type: "custom",
          customType: ENTRY_TYPE_STATE,
          data: {
            version: 4,
            taskRuns: [laterTaskRun],
            currentTaskRunId: "task-run-2",
            updatedAt: 2,
          },
        },
      ]);

      expect(restored.currentTaskRunId).toBe("task-run-1");
      expect(restored.taskRuns.map((run) => run.id)).toEqual(["task-run-1"]);
    }
  });

  test("skips later v4 entries when malformed assignment result would drop persisted content", () => {
    const laterTaskRun: Record<string, unknown> = {
      ...taskRun,
      id: "task-run-2",
      title: "Task run 2 with malformed assignment result",
      assignments: [{
        ...taskRun.assignments[0],
        result: {
          assignmentId: "assignment-1",
          status: "completed",
          criteriaEvidence: [{ criteriaIndex: 0, criterionId: "C1", evidence: "done" }],
          artifacts: [],
          followUps: ["check logs"],
          rawResultPath: "local://results/assignment-1.json",
          createdAt: 2,
        },
      }],
    };

    const restored = restoreStateFromSessionEntries([
      { type: "custom", customType: ENTRY_TYPE_STATE, data: currentState },
      {
        type: "custom",
        customType: ENTRY_TYPE_STATE,
        data: {
          version: 4,
          taskRuns: [laterTaskRun],
          currentTaskRunId: "task-run-2",
          updatedAt: 2,
        },
      },
    ]);

    expect(restored.currentTaskRunId).toBe("task-run-1");
    expect(restored.taskRuns.map((run) => run.id)).toEqual(["task-run-1"]);
  });

  test("skips later v4 entries when malformed launchRef would drop assignment handles", () => {
    const laterTaskRun: Record<string, unknown> = {
      ...taskRun,
      id: "task-run-2",
      title: "Task run 2 with malformed launchRef",
      assignments: [{
        ...taskRun.assignments[0],
        launchRef: {
          assignments: [{
            assignmentId: "assignment-1",
            runId: "async-stored",
            resultPath: "local://results/assignment-1.json",
          }],
        },
      }],
    };

    const restored = restoreStateFromSessionEntries([
      { type: "custom", customType: ENTRY_TYPE_STATE, data: currentState },
      {
        type: "custom",
        customType: ENTRY_TYPE_STATE,
        data: {
          version: 4,
          taskRuns: [laterTaskRun],
          currentTaskRunId: "task-run-2",
          updatedAt: 2,
        },
      },
    ]);

    expect(restored.currentTaskRunId).toBe("task-run-1");
    expect(restored.taskRuns.map((run) => run.id)).toEqual(["task-run-1"]);
  });

  test("allows a later legitimately empty v4 state entry to replace earlier task runs", () => {
    const restored = restoreStateFromSessionEntries([
      { type: "custom", customType: ENTRY_TYPE_STATE, data: currentState },
      {
        type: "custom",
        customType: ENTRY_TYPE_STATE,
        data: { version: 4, taskRuns: [], updatedAt: 2 },
      },
    ]);

    expect(restored.taskRuns).toEqual([]);
    expect(restored.currentTaskRunId).toBeUndefined();
    expect(restored.updatedAt).toBe(2);
  });

  test("builds and restores custom entry data with taskRuns and currentTaskRunId", () => {
    const entryData = buildStateEntryData(currentState);

    expect(entryData).toEqual(currentState);
    expect(entryData).not.toHaveProperty("plans");
    expect(entryData).not.toHaveProperty("currentPlanId");
    expect(stateFromEntryData(entryData)).toEqual(currentState);
    expect(stateFromEntryData(JSON.stringify(entryData))).toEqual(currentState);
  });

  test("malformed JSON string input throws a clear error", () => {
    expect(() => deserializeState("{not json")).toThrow("Cannot deserialize state: invalid JSON");
  });

  test("currentTaskRunId falls back to the last valid task run when stored id is missing", () => {
    const restored = ensureState({
      version: 4,
      currentTaskRunId: "missing",
      updatedAt: 1,
      taskRuns: [
        taskRunWithId("task-run-1"),
        {},
        taskRunWithId("task-run-2"),
        { id: "invalid-task-run" },
      ],
    });

    expect(restored.taskRuns.map((run) => run.id)).toEqual(["task-run-1", "task-run-2"]);
    expect(restored.currentTaskRunId).toBe("task-run-2");
  });

  test("invalid nested group, task, assignment, evidence, and artifact entries are dropped without crashing", () => {
    const restored = ensureState({
      version: 4,
      currentTaskRunId: "task-run-1",
      updatedAt: 1,
      taskRuns: [{
        ...taskRun,
        groups: [
          {},
          taskRun.groups[0],
        ],
        tasks: [
          {},
          {
            ...taskRun.tasks[0],
            criteria: [{
              ...taskRun.tasks[0].criteria[0],
              evidence: [
                {},
                { criterionId: "C1", assignmentId: "assignment-1", summary: "done", createdAt: 1 },
              ],
            }],
          },
        ],
        assignments: [
          {},
          {
            id: "assignment-1",
            taskRunId: "task-run-1",
            groupId: "group-1",
            taskId: "task-1",
            agent: "delegate",
            prompt: "Do task",
            status: "completed",
            result: {
              assignmentId: "assignment-1",
              status: "completed",
              summary: "done",
              criteriaEvidence: [],
              artifacts: [
                {},
                {
                  label: "Nested report",
                  path: "local://nested-report.md",
                  assignmentId: "assignment-1",
                  taskRunId: "task-run-1",
                  groupId: "group-1",
                  taskId: "task-1",
                },
              ],
              followUps: [],
              createdAt: 1,
            },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        artifacts: [
          {},
          {
            label: "Report",
            path: "local://report.md",
            assignmentId: "assignment-1",
            taskRunId: "task-run-1",
            groupId: "group-1",
            taskId: "task-1",
          },
        ],
      }],
    });

    expect(restored.taskRuns[0].groups.map((group) => group.id)).toEqual(["group-1"]);
    expect(restored.taskRuns[0].tasks.map((task) => task.id)).toEqual(["task-1"]);
    expect(restored.taskRuns[0].assignments).toHaveLength(1);
    expect(restored.taskRuns[0].assignments[0].taskRunId).toBe("task-run-1");
    expect(restored.taskRuns[0].assignments[0].groupId).toBe("group-1");
    expect(restored.taskRuns[0].assignments[0].taskId).toBe("task-1");
    expect(restored.taskRuns[0].tasks[0].criteria[0].evidence).toHaveLength(1);
    expect(restored.taskRuns[0].artifacts).toHaveLength(1);
    expect(restored.taskRuns[0].artifacts[0]).toMatchObject({
      taskRunId: "task-run-1",
      groupId: "group-1",
      taskId: "task-1",
    });
    expect(restored.taskRuns[0].assignments[0].result?.artifacts).toHaveLength(1);
  });

  test("drops incomplete unmarked launchRefs instead of downgrading them to legacy", () => {
    const restored = ensureState({
      version: 4,
      currentTaskRunId: "task-run-1",
      updatedAt: 1,
      taskRuns: [{
        ...taskRun,
        assignments: [{
          ...taskRun.assignments[0],
          launchRef: {
            asyncId: "async-stored",
            resultPath: "local://results/assignment-1.json",
            assignments: [{}],
          },
        }],
      }],
    });

    expect(restored.taskRuns[0].assignments[0]).toMatchObject({ runId: "async-stored" });
    expect(restored.taskRuns[0].assignments[0].launchRef).toBeUndefined();
  });

  test("preserves only session-bound durable launch handles and explicit legacy handles", () => {
    const durable = ensureState({
      version: 4,
      currentTaskRunId: "task-run-1",
      updatedAt: 1,
      taskRuns: [{
        ...taskRun,
        assignments: [{
          ...taskRun.assignments[0],
          launchRef: {
            runId: "run-1",
            asyncId: "run-1",
            sessionId: "session-a",
            asyncDir: "/untrusted/runs/session-a/0123456789abcdef0123456789abcdef",
            resultId: "0123456789abcdef0123456789abcdef",
            resultPath: "/untrusted/results/session-a/0123456789abcdef0123456789abcdef.json",
            resultReservationPath: "/untrusted/results/session-a/0123456789abcdef0123456789abcdef.json.reservation",
            assignments: [{ assignmentId: "assignment-1", runId: "run-1" }],
          },
        }],
      }],
    });
    const legacy = ensureState({
      version: 4,
      currentTaskRunId: "task-run-1",
      updatedAt: 1,
      taskRuns: [{
        ...taskRun,
        assignments: [{
          ...taskRun.assignments[0],
          launchRef: { legacy: true, runId: "legacy-run", asyncId: "legacy-run", resultPath: "/legacy/result.json", assignments: [] },
        }],
      }],
    });

    expect(durable.taskRuns[0].assignments[0].launchRef).toMatchObject({ sessionId: "session-a", resultId: "0123456789abcdef0123456789abcdef" });
    expect(legacy.taskRuns[0].assignments[0].launchRef).toMatchObject({ legacy: true, resultPath: "/legacy/result.json" });
  });

  test("rejects launch handles whose resultId violates the shared lowercase 32-or-64-hex contract", () => {
    const restored = ensureState({
      version: 4,
      currentTaskRunId: "task-run-1",
      updatedAt: 1,
      taskRuns: [{
        ...taskRun,
        assignments: [{
          ...taskRun.assignments[0],
          launchRef: {
            runId: "run-1", asyncId: "run-1", sessionId: "session-a", asyncDir: "/runs/session-a/bad",
            resultId: "A".repeat(32), resultPath: "/results/session-a/bad.json", resultReservationPath: "/results/session-a/bad.json.reservation",
            assignments: [{ assignmentId: "assignment-1", runId: "run-1" }],
          },
        }],
      }],
    });

    expect(restored.taskRuns[0].assignments[0].launchRef).toBeUndefined();
  });

  test("restores the newest fully valid v5 checkpoint and falls back only to an earlier complete graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-restore-"));
    storageRoots.push(root);
    const store = new DurableObjectStore(root);
    const earlier = { ...currentState, taskRuns: [{ ...taskRun, title: "earlier branch" }], updatedAt: 1 } satisfies TaskedSubagentsState;
    const latest = {
      ...currentState,
      taskRuns: [{ ...taskRun, id: "task-run-2", title: "latest branch", assignments: [], tasks: [], artifacts: [] }],
      currentTaskRunId: "task-run-2",
      updatedAt: 2,
    } satisfies TaskedSubagentsState;
    const earlierPointer = await v5Checkpoint(store, earlier, 1);
    const latestPointer = await v5Checkpoint(store, latest, 2);
    const result = await restoreBranchState(
      [v5Entry(earlierPointer), v5Entry(latestPointer)], store,
      { sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => undefined },
    );

    expect(result.diagnostics).toEqual([]);
    expect(result).toMatchObject({ restored: true, pointer: latestPointer });
    if (result.restored) expect(result.state.taskRuns).toMatchObject([{ id: "task-run-2", title: "latest branch" }]);
    const divergentBranch = await restoreBranchState(
      [v5Entry(earlierPointer)], store,
      { sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => undefined },
    );
    expect(divergentBranch).toMatchObject({ restored: true, pointer: earlierPointer });
    if (divergentBranch.restored) expect(divergentBranch.state.taskRuns).toMatchObject([{ title: "earlier branch" }]);

    const corruptManifest: CheckpointManifestV1 = {
      checkpointVersion: 1, sessionId: "generic-session", sequence: 3, currentTaskRunId: "missing-run",
      recoverableRuns: [{ taskRunId: "missing-run", status: "running", objectId: "a".repeat(64), updatedAt: 3 }],
      recentCompleted: [], recentAssignmentRefs: [], updatedAt: 3,
    };
    const corruptPointer: StatePointerV5 = {
      version: 5, checkpointId: await store.put("checkpoint", corruptManifest, 256 * 1024), currentTaskRunId: "missing-run", sequence: 3, writtenAt: 3,
    };
    const fallback = await restoreBranchState(
      [v5Entry(earlierPointer), v5Entry(corruptPointer)], store,
      { sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => undefined },
    );

    expect(fallback).toMatchObject({ restored: true, pointer: earlierPointer });
    expect(fallback.diagnostics).toContainEqual(expect.objectContaining({ code: "object_missing", objectId: "a".repeat(64) }));

    const malformedFallback = await restoreBranchState(
      [v5Entry(earlierPointer), { type: "custom", customType: ENTRY_TYPE_STATE, data: { version: 5, checkpointId: "not-a-digest" } }],
      store,
      { sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => undefined },
    );
    expect(malformedFallback).toMatchObject({ restored: true, pointer: earlierPointer });
    expect(malformedFallback.diagnostics).toContainEqual(expect.objectContaining({ code: "pointer_invalid" }));
  });

  test("pins every fully valid v5 checkpoint across branches after restoring the active branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-restore-"));
    storageRoots.push(root);
    const store = new DurableObjectStore(root);
    const activePointer = await v5Checkpoint(store, currentState, 1);
    const inactiveState = { version: 4, taskRuns: [], updatedAt: 2 } satisfies TaskedSubagentsState;
    const inactivePointer = await v5Checkpoint(store, inactiveState, 2);
    const invalidPointer: StatePointerV5 = { version: 5, checkpointId: "f".repeat(64), sequence: 3, writtenAt: 3 };

    await expect(restoreBranchState(
      [v5Entry(activePointer)],
      store,
      { sessionId: "generic-session", allEntries: [v5Entry(activePointer), v5Entry(inactivePointer), v5Entry(invalidPointer)], appendMigratedPointer: () => undefined },
    )).resolves.toMatchObject({ restored: true, pointer: activePointer });

    const refs = JSON.parse(await readFile(sessionStoragePaths(root, "generic-session").refsPath, "utf8")) as { checkpointIds: string[] };
    expect(refs.checkpointIds).toEqual([activePointer.checkpointId, inactivePointer.checkpointId].sort());
  });

  test("rejects a task-run graph whenever durable normalization changes a nested launch handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-restore-"));
    storageRoots.push(root);
    const store = new DurableObjectStore(root);
    const malformed = structuredClone(currentState);
    (malformed.taskRuns[0].assignments[0] as unknown as { launchRef: unknown }).launchRef = {
      runId: "run-1", asyncId: "run-1", sessionId: "generic-session", asyncDir: "/runs/generic-session/bad",
      resultId: "A".repeat(32), resultPath: "/results/generic-session/bad.json", resultReservationPath: "/results/generic-session/bad.json.reservation",
      assignments: [{ assignmentId: "assignment-1", runId: "run-1" }],
    };
    const pointer = await v5Checkpoint(store, malformed, 1);
    const entry = { type: "custom" as const, customType: ENTRY_TYPE_STATE, data: pointer };

    await expect(restoreBranchState([entry], store, {
      sessionId: "generic-session", allEntries: [entry], appendMigratedPointer: () => undefined,
    })).resolves.toMatchObject({ restored: false, diagnostics: [{ code: "object_invalid" }] });
  });

  test("rejects a newest graph with a malformed manifest resultId in favor of its preceding valid pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-restore-"));
    storageRoots.push(root);
    const store = new DurableObjectStore(root);
    const earlierPointer = await v5Checkpoint(store, { version: 4, taskRuns: [], updatedAt: 1 }, 1);
    const resultId = "malformed-result-id";
    const archiveId = await store.put("assignment", {
      assignmentId: "assignment-completed", taskRunId: "completed-run", taskId: "completed-task", status: "completed",
      runId: "run-completed", resultId, completedAt: 2, summary: "completed summary", criteriaEvidence: [], artifacts: [], followUps: [],
    }, 256 * 1024);
    const latestPointer: StatePointerV5 = {
      version: 5,
      checkpointId: await store.put("checkpoint", {
        checkpointVersion: 1, sessionId: "generic-session", sequence: 2, recoverableRuns: [], recentCompleted: [],
        recentAssignmentRefs: [{ assignmentId: "assignment-completed", assignmentIdHash: sha256Hex("assignment-completed"), archiveId, resultId }], updatedAt: 2,
      }, 256 * 1024),
      sequence: 2,
      writtenAt: 2,
    };

    await expect(restoreBranchState([v5Entry(earlierPointer), v5Entry(latestPointer)], store, {
      sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => undefined,
    })).resolves.toMatchObject({ restored: true, pointer: earlierPointer });
  });

  test("rejects a newest graph with a malformed archive resultId in favor of its preceding valid pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-restore-"));
    storageRoots.push(root);
    const store = new DurableObjectStore(root);
    const earlierPointer = await v5Checkpoint(store, { version: 4, taskRuns: [], updatedAt: 1 }, 1);
    const archiveId = await store.put("assignment", {
      assignmentId: "assignment-completed", taskRunId: "completed-run", taskId: "completed-task", status: "completed",
      runId: "run-completed", resultId: "malformed-result-id", completedAt: 2, summary: "completed summary", criteriaEvidence: [], artifacts: [], followUps: [],
    }, 256 * 1024);
    const latestPointer: StatePointerV5 = {
      version: 5,
      checkpointId: await store.put("checkpoint", {
        checkpointVersion: 1, sessionId: "generic-session", sequence: 2, recoverableRuns: [],
        recentCompleted: [{ taskRunId: "completed-run", title: "Completed", status: "completed", createdAt: 1, updatedAt: 2, completedAt: 2, groupCount: 0, taskCount: 0, assignmentCount: 1, assignmentArchiveIds: [archiveId] }],
        recentAssignmentRefs: [], updatedAt: 2,
      }, 256 * 1024),
      sequence: 2,
      writtenAt: 2,
    };

    await expect(restoreBranchState([v5Entry(earlierPointer), v5Entry(latestPointer)], store, {
      sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => undefined,
    })).resolves.toMatchObject({ restored: true, pointer: earlierPointer });
  });

  test("does not silently reset an all-invalid v5 branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-restore-"));
    storageRoots.push(root);
    const result = await restoreBranchState(
      [v5Entry({ version: 5, checkpointId: "f".repeat(64), sequence: 1, writtenAt: 1 })],
      new DurableObjectStore(root),
      { sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => undefined },
    );

    expect(result).toMatchObject({ restored: false, hasV4Candidate: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "object_missing" }));
  });

  test("rejects a checkpoint when archive identities, terminal fields, or nested archive detail are malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-restore-"));
    storageRoots.push(root);
    const store = new DurableObjectStore(root);
    const validArchive = {
      assignmentId: "assignment-completed",
      taskRunId: "completed-run",
      groupId: "completed-group",
      taskId: "completed-task",
      status: "completed",
      runId: "run-completed",
      resultId: "a".repeat(32),
      completedAt: 4,
      summary: "completed summary",
      criteriaEvidence: [{ criteriaIndex: 0, criterionId: "C1", evidence: "proof" }],
      artifacts: [{ label: "Report", path: "local://report", assignmentId: "assignment-completed", taskRunId: "completed-run", groupId: "completed-group", taskId: "completed-task" }],
      followUps: ["none"],
    };
    const cases: Array<[string, (archive: Record<string, unknown>) => void]> = [
      ["assignment id", (archive) => { archive.assignmentId = ""; }],
      ["task run id", (archive) => { archive.taskRunId = 1; }],
      ["task id", (archive) => { archive.taskId = ""; }],
      ["run id", (archive) => { archive.runId = 1; }],
      ["result identity", (archive) => { archive.resultId = ""; }],
      ["completed timestamp", (archive) => { archive.completedAt = -1; }],
      ["terminal status", (archive) => { archive.status = "running"; }],
      ["group id", (archive) => { archive.groupId = 1; }],
      ["summary", (archive) => { archive.summary = "x".repeat(16 * 1024 + 1); }],
      ["unknown detail", (archive) => { archive.untrusted = true; }],
      ["criteria array", (archive) => { archive.criteriaEvidence = [{ criteriaIndex: "0", criterionId: "C1", evidence: "proof" }]; }],
      ["artifact shape", (archive) => { archive.artifacts = [{ label: "Report", path: "local://report", assignmentId: "other", taskRunId: "completed-run", taskId: "completed-task" }]; }],
      ["artifact group", (archive) => { archive.artifacts = [{ label: "Report", path: "local://report", assignmentId: "assignment-completed", taskRunId: "completed-run", groupId: "other", taskId: "completed-task" }]; }],
      ["follow-up shape", (archive) => { archive.followUps = [1]; }],
    ];
    for (const [name, mutate] of cases) {
      const archive = structuredClone(validArchive) as Record<string, unknown>;
      mutate(archive);
      const archiveId = await store.put("assignment", archive, 256 * 1024);
      const manifest: CheckpointManifestV1 = {
        checkpointVersion: 1, sessionId: "generic-session", sequence: 1,
        recoverableRuns: [],
        recentCompleted: [{ taskRunId: "completed-run", title: "Completed", status: "completed", createdAt: 1, updatedAt: 4, completedAt: 4, groupCount: 1, taskCount: 1, assignmentCount: 1, assignmentArchiveIds: [archiveId] }],
        recentAssignmentRefs: [{ assignmentId: "assignment-completed", assignmentIdHash: sha256Hex("assignment-completed"), archiveId, resultId: "a".repeat(32) }],
        updatedAt: 4,
      };
      const pointer: StatePointerV5 = { version: 5, checkpointId: await store.put("checkpoint", manifest, 256 * 1024), sequence: 1, writtenAt: 4 };
      const restored = await restoreBranchState([v5Entry(pointer)], store, { sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => undefined });
      expect(restored, name).toMatchObject({ restored: false });
    }

    const archiveId = await store.put("assignment", validArchive, 256 * 1024);
    const manifest: CheckpointManifestV1 = {
      checkpointVersion: 1, sessionId: "generic-session", sequence: 2,
      recoverableRuns: [],
      recentCompleted: [{ taskRunId: "completed-run", title: "Completed", status: "completed", createdAt: 1, updatedAt: 4, completedAt: 4, groupCount: 3, taskCount: 5, assignmentCount: 7, assignmentArchiveIds: [archiveId] }],
      recentAssignmentRefs: [{ assignmentId: "assignment-completed", assignmentIdHash: "f".repeat(64), archiveId, resultId: "a".repeat(32) }],
      updatedAt: 4,
    };
    const pointer: StatePointerV5 = { version: 5, checkpointId: await store.put("checkpoint", manifest, 256 * 1024), sequence: 2, writtenAt: 4 };
    const rejected = await restoreBranchState([v5Entry(pointer)], store, { sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => undefined });
    expect(rejected).toMatchObject({ restored: false });

    manifest.recentAssignmentRefs[0].assignmentIdHash = sha256Hex("assignment-completed");
    manifest.sequence = 3;
    const validPointer: StatePointerV5 = { version: 5, checkpointId: await store.put("checkpoint", manifest, 256 * 1024), sequence: 3, writtenAt: 4 };
    const restored = await restoreBranchState([v5Entry(validPointer)], store, { sessionId: "generic-session", allEntries: [], appendMigratedPointer: () => undefined });
    expect(restored).toMatchObject({ restored: true });
    if (restored.restored) {
      expect(restored.state.taskRuns).toEqual([]);
      expect(restored.state.completedHistory).toMatchObject([{ groupCount: 3, taskCount: 5, assignmentCount: 7, assignmentArchiveIds: [archiveId] }]);
      expect(restored.archiveRefs).toMatchObject([{ assignmentId: "assignment-completed", archiveId, taskRunId: "completed-run" }]);
    }
  });

  test("does not synthesize a path-trusting launchRef for runId-only persisted assignments", () => {
    const restored = ensureState({
      version: 4,
      currentTaskRunId: "task-run-1",
      updatedAt: 1,
      taskRuns: [{
        ...taskRun,
        assignments: [{
          ...taskRun.assignments[0],
          runId: "run-stored",
          resultPath: "local://results/assignment-1.json",
          launchRef: "missing",
        }],
      }],
    });

    expect(restored.taskRuns[0].assignments[0]).toMatchObject({ runId: "run-stored" });
    expect(restored.taskRuns[0].assignments[0].launchRef).toBeUndefined();
  });
});
