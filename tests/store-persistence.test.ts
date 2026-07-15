import { mkdtemp, rm } from "node:fs/promises";
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

  test("restores partial persisted launchRef with assignment fallbacks", () => {
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

    const assignment = restored.taskRuns[0].assignments[0];

    expect(assignment.runId).toBe("async-stored");
    expect(assignment.launchRef).toMatchObject({
      runId: "async-stored",
      asyncId: "async-stored",
      resultPath: "local://results/assignment-1.json",
      assignments: [{
        assignmentId: "assignment-1",
        runId: "async-stored",
        resultPath: "local://results/assignment-1.json",
      }],
    });
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
      resultId: "result-completed",
      completedAt: 4,
      summary: "completed summary",
      criteriaEvidence: [{ criteriaIndex: 0, criterionId: "C1", evidence: "proof" }],
      artifacts: [{ label: "Report", path: "local://report", assignmentId: "assignment-completed", taskRunId: "completed-run", groupId: "completed-group", taskId: "completed-task" }],
      followUps: ["none"],
    };
    const cases: Array<[string, (archive: Record<string, unknown>) => void]> = [
      ["assignment id", (archive) => { archive.assignmentId = ""; }],
      ["run id", (archive) => { archive.runId = 1; }],
      ["terminal status", (archive) => { archive.status = "running"; }],
      ["group id", (archive) => { archive.groupId = 1; }],
      ["summary", (archive) => { archive.summary = 1; }],
      ["criteria array", (archive) => { archive.criteriaEvidence = [{ criteriaIndex: "0", criterionId: "C1", evidence: "proof" }]; }],
      ["artifact shape", (archive) => { archive.artifacts = [{ label: "Report", path: "local://report", assignmentId: "other", taskRunId: "completed-run", taskId: "completed-task" }]; }],
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
        recentAssignmentRefs: [{ assignmentId: "assignment-completed", assignmentIdHash: sha256Hex("assignment-completed"), archiveId, resultId: "result-completed" }],
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
      recentAssignmentRefs: [{ assignmentId: "assignment-completed", assignmentIdHash: "f".repeat(64), archiveId, resultId: "result-completed" }],
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

  test("synthesizes launchRef for runId-only persisted assignments", () => {
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

    const assignment = restored.taskRuns[0].assignments[0];

    expect(assignment.runId).toBe("run-stored");
    expect(assignment.launchRef).toMatchObject({
      runId: "run-stored",
      asyncId: "run-stored",
      resultPath: "local://results/assignment-1.json",
      assignments: [{
        assignmentId: "assignment-1",
        runId: "run-stored",
        resultPath: "local://results/assignment-1.json",
      }],
    });
  });
});
