import { describe, expect, test } from "vitest";

import { ENTRY_TYPE_STATE } from "../src/defaults.js";
import { buildStateEntryData, restoreStateFromSessionEntries, stateFromEntryData } from "../src/state/persistence.js";
import { createEmptyState, deserializeState, ensureState, serializeState } from "../src/state/store.js";

const v2State = {
  version: 2 as const,
  plans: [{
    id: "plan-1",
    title: "Plan",
    request: "Do it",
    spec: "Do it",
    status: "running" as const,
    phases: [],
    assignments: [],
    artifacts: [],
    createdAt: 1,
    updatedAt: 1,
  }],
  currentPlanId: "plan-1",
  updatedAt: 1,
};

describe("plan-first state store", () => {
  test("creates empty v2 state", () => {
    const state = createEmptyState();
    expect(state.version).toBe(2);
    expect(state.plans).toEqual([]);
  });

  test("resets old ask/run state instead of migrating", () => {
    const state = ensureState({ version: 1, asks: [{ id: "ask-1" }], runRegistry: { runs: [] }, updatedAt: 1 });
    expect(state).toMatchObject({ version: 2, plans: [] });
  });

  test("round-trips valid v2 state", () => {
    const serialized = serializeState(v2State);
    expect(deserializeState(serialized).plans[0].id).toBe("plan-1");
  });

  test("restores last custom state entry", () => {
    const restored = restoreStateFromSessionEntries([
      { type: "custom", customType: ENTRY_TYPE_STATE, data: createEmptyState() },
      { type: "custom", customType: ENTRY_TYPE_STATE, data: v2State },
    ]);
    expect(restored.currentPlanId).toBe("plan-1");
  });

  test("builds appendEntry data with plans only", () => {
    expect(buildStateEntryData(v2State)).toEqual(v2State);
    expect(stateFromEntryData(JSON.stringify(v2State)).plans).toHaveLength(1);
  });

  test("malformed JSON string input throws a clear error", () => {
    expect(() => deserializeState("{not json")).toThrow("Cannot deserialize state: invalid JSON");
  });

  test("currentPlanId falls back to the last valid plan when stored id is missing", () => {
    const restored = ensureState({
      version: 2,
      currentPlanId: "missing",
      updatedAt: 1,
      plans: [
        { ...v2State.plans[0], id: "plan-1" },
        { ...v2State.plans[0], id: "plan-2" },
      ],
    });

    expect(restored.currentPlanId).toBe("plan-2");
  });

  test("invalid nested assignment and evidence entries are dropped without crashing", () => {
    const restored = ensureState({
      version: 2,
      currentPlanId: "plan-1",
      updatedAt: 1,
      plans: [{
        ...v2State.plans[0],
        phases: [{
          id: "phase",
          title: "Phase",
          status: "running",
          tasks: [{
            id: "task",
            text: "Do task",
            status: "running",
            criteria: [{ id: "C1", text: "Done", satisfied: true, evidence: [{}, { criterionId: "C1", assignmentId: "a1", summary: "done" }] }],
            dependsOn: [],
            assignmentIds: ["a1"],
            createdAt: 1,
            updatedAt: 1,
          }],
          dependsOn: [],
          createdAt: 1,
          updatedAt: 1,
        }],
        assignments: [{}, { id: "a1", planId: "plan-1", phaseId: "phase", taskId: "task", agent: "delegate", prompt: "Do task", status: "running", createdAt: 1, updatedAt: 1 }],
      }],
    });

    expect(restored.plans[0].assignments).toHaveLength(1);
    expect(restored.plans[0].phases[0].tasks[0].criteria[0].evidence).toHaveLength(1);
  });
});
