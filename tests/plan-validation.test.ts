import { describe, expect, test } from "vitest";

import { normalizePlanInput, validatePlanInput } from "../src/state/plan-validation.js";

const validPlan = {
  title: "Refactor controller",
  spec: "Make orchestration plan first.",
  phases: [
    {
      id: "model",
      title: "Model",
      tasks: [
        {
          id: "types",
          text: "Define plan-first types.",
          criteria: ["Types include plans, phases, tasks, assignments, and evidence."],
        },
      ],
    },
  ],
};

describe("plan validation", () => {
  test("accepts a one-phase one-task plan", () => {
    expect(validatePlanInput(validPlan)).toEqual([]);
    const normalized = normalizePlanInput(validPlan, { planId: "plan-1", now: 1 });

    expect(normalized.plan?.id).toBe("plan-1");
    expect(normalized.plan?.phases[0]?.id).toBe("model");
    expect(normalized.plan?.phases[0]?.tasks[0]?.id).toBe("types");
    expect(normalized.plan?.phases[0]?.tasks[0]?.criteria[0]?.satisfied).toBe(false);
  });

  test("accepts spec-only plans because normalization derives title and request", () => {
    const input = { spec: "Implement the feature.", phases: validPlan.phases };

    expect(validatePlanInput(input)).toEqual([]);
    const normalized = normalizePlanInput(input, { planId: "plan-1", now: 1 });

    expect(normalized.plan?.title).toBe("Implement the feature.");
    expect(normalized.plan?.request).toBe("Implement the feature.");
  });

  test("rejects tasks without criteria", () => {
    expect(validatePlanInput({
      ...validPlan,
      phases: [{ id: "model", title: "Model", tasks: [{ id: "task", text: "No evidence target", criteria: [] }] }],
    })).toContain("Task task must have at least one criterion");
  });

  test("rejects unknown phase dependencies", () => {
    expect(validatePlanInput({
      ...validPlan,
      phases: [{ id: "model", title: "Model", dependsOn: ["missing"], tasks: validPlan.phases[0].tasks }],
    })).toContain("Phase model depends on unknown phase missing");
  });

  test("rejects invalid concurrency limits", () => {
    expect(validatePlanInput({
      ...validPlan,
      maxConcurrency: 0,
      phases: validPlan.phases,
    })).toContain("Plan maxConcurrency must be a positive integer");
    expect(validatePlanInput({
      ...validPlan,
      phases: [{ ...validPlan.phases[0], maxConcurrency: 0 }],
    })).toContain("Phase model maxConcurrency must be a positive integer");
  });

  test("rejects task dependency cycles", () => {
    const errors = validatePlanInput({
      ...validPlan,
      phases: [{
        id: "model",
        title: "Model",
        tasks: [
          { id: "a", text: "A", dependsOn: ["b"], criteria: ["A done"] },
          { id: "b", text: "B", dependsOn: ["a"], criteria: ["B done"] },
        ],
      }],
    });

    expect(errors.some((error: string) => error.includes("Task dependency cycle"))).toBe(true);
  });

  test.each([
    ["empty spec", { ...validPlan, spec: " " }, "Plan spec is required"],
    ["no phases", { ...validPlan, phases: [] }, "Plan must contain at least one phase"],
    ["phase without tasks", { ...validPlan, phases: [{ id: "model", title: "Model", tasks: [] }] }, "Phase model must contain at least one task"],
    ["duplicate phase ids", { ...validPlan, phases: [validPlan.phases[0], validPlan.phases[0]] }, "Duplicate phase id: model"],
    ["duplicate task ids", { ...validPlan, phases: [{ id: "model", title: "Model", tasks: [validPlan.phases[0].tasks[0], validPlan.phases[0].tasks[0]] }] }, "Duplicate task id: types"],
    ["missing task text", { ...validPlan, phases: [{ id: "model", title: "Model", tasks: [{ id: "task", text: " ", criteria: ["Done"] }] }] }, "Task task text is required"],
    ["unknown task dependency", { ...validPlan, phases: [{ id: "model", title: "Model", tasks: [{ id: "task", text: "Do", dependsOn: ["missing"], criteria: ["Done"] }] }] }, "Task task depends on unknown task missing"],
    ["phase self-dependency", { ...validPlan, phases: [{ id: "model", title: "Model", dependsOn: ["model"], tasks: validPlan.phases[0].tasks }] }, "Phase model cannot depend on itself"],
    ["task self-dependency", { ...validPlan, phases: [{ id: "model", title: "Model", tasks: [{ id: "task", text: "Do", dependsOn: ["task"], criteria: ["Done"] }] }] }, "Task task cannot depend on itself"],
    ["invalid negative retries", { ...validPlan, phases: [{ id: "model", title: "Model", tasks: [{ id: "task", text: "Do", retries: -1, criteria: ["Done"] }] }] }, "Task task retries must be a non-negative integer"],
  ] as const)("rejects %s", (_name, input, expected) => {
    expect(validatePlanInput(input as Parameters<typeof validatePlanInput>[0])).toContain(expected);
  });

  test("rejects phase dependency cycles", () => {
    const errors = validatePlanInput({
      ...validPlan,
      phases: [
        { id: "a", title: "A", dependsOn: ["b"], tasks: [{ id: "ta", text: "A", criteria: ["A done"] }] },
        { id: "b", title: "B", dependsOn: ["a"], tasks: [{ id: "tb", text: "B", criteria: ["B done"] }] },
      ],
    });

    expect(errors.some((error) => error.includes("Phase dependency cycle"))).toBe(true);
  });
});
