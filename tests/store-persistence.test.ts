import { describe, expect, test } from "vitest";

import { ENTRY_TYPE_STATE } from "../src/defaults.js";
import { buildStateEntryData, restoreStateFromSessionEntries, stateFromEntryData } from "../src/state/persistence.js";
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
