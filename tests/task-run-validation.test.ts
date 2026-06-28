import { describe, expect, test } from "vitest";

import { normalizeTaskRunInput, validateTaskRunInput } from "../src/state/task-run-validation.js";
import type { SetTasksInput, TaskGroupInput, TaskInput } from "../src/types.js";

const minimalTaskRun = {
  title: "Ship task-run validation",
  tasks: [
    {
      id: "write-tests",
      text: "Write failing task-run validation tests.",
      criteria: ["Tests describe flat tasks and optional groups."],
    },
  ],
};

const validTask = (overrides: Partial<TaskInput> = {}): TaskInput => ({
  id: "task-1",
  text: "Do task.",
  criteria: ["Done."],
  ...overrides,
});

const validInput = (overrides: Partial<SetTasksInput> = {}): SetTasksInput => ({
  title: overrides.title ?? "Validate task run",
  request: overrides.request,
  context: overrides.context,
  taskRunId: overrides.taskRunId,
  groups: overrides.groups,
  tasks: overrides.tasks ?? [validTask()],
  maxConcurrency: overrides.maxConcurrency,
});

const expectValidationError = (input: unknown, error: string): void => {
  expect(validateTaskRunInput(input)).toContain(error);
};

describe("task-run validation", () => {
  test("accepts a minimal set_tasks input with one ungrouped task", () => {
    expect(validateTaskRunInput(minimalTaskRun)).toEqual([]);

    const normalized = normalizeTaskRunInput(minimalTaskRun, { taskRunId: "run-1", now: 1 });

    expect(normalized.errors).toEqual([]);
    expect(normalized.taskRun?.id).toBe("run-1");
    expect(normalized.taskRun?.title).toBe("Ship task-run validation");
    expect(normalized.taskRun?.groups).toEqual([]);
    expect(normalized.taskRun?.tasks[0]?.id).toBe("write-tests");
    expect(normalized.taskRun?.tasks[0]?.groupId).toBeUndefined();
    expect(normalized.taskRun?.tasks[0]?.criteria[0]?.satisfied).toBe(false);
  });

  test("prefers explicit taskRunId over normalization fallback id", () => {
    const normalized = normalizeTaskRunInput({ ...minimalTaskRun, taskRunId: "external-run" }, { taskRunId: "fallback-run", now: 1 });

    expect(normalized.errors).toEqual([]);
    expect(normalized.taskRun?.id).toBe("external-run");
  });

  test("defaults explicit group concurrency and stores task group as groupId", () => {
    const input = {
      request: "Implement the grouped task run.",
      groups: [{ id: "implementation", title: "Implementation" }],
      tasks: [
        {
          id: "model",
          group: "implementation",
          text: "Define task-run records.",
          criteria: ["Records use groupId instead of group."],
        },
      ],
    };

    expect(validateTaskRunInput(input)).toEqual([]);

    const normalized = normalizeTaskRunInput(input, { taskRunId: "run-1", now: 1 });

    expect(normalized.errors).toEqual([]);
    expect(normalized.taskRun?.groups[0]).toMatchObject({
      id: "implementation",
      title: "Implementation",
      dependsOn: [],
      maxConcurrency: 1,
    });
    expect(normalized.taskRun?.tasks[0]).toMatchObject({
      id: "model",
      groupId: "implementation",
      text: "Define task-run records.",
    });
    expect(normalized.taskRun?.tasks[0]).not.toHaveProperty("group");
    expect(normalized.taskRun?.groups[0]).not.toHaveProperty("taskIds");
    expect(normalized.taskRun?.groups[0]).not.toHaveProperty("goal");
    expect(normalized.taskRun?.groups[0]).not.toHaveProperty("brief");
  });

  test("infers groups from task group values when groups are omitted", () => {
    const input = {
      context: "Coordinate independent tracks.",
      tasks: [
        {
          id: "types",
          group: "model",
          text: "Define task-run domain types.",
          criteria: ["Task records include optional groupId."],
        },
        {
          id: "scheduler",
          group: "runtime",
          text: "Schedule task groups safely.",
          criteria: ["Inferred groups default to sequential execution."],
        },
      ],
    };

    expect(validateTaskRunInput(input)).toEqual([]);

    const normalized = normalizeTaskRunInput(input, { taskRunId: "run-1", now: 1 });

    expect(normalized.errors).toEqual([]);
    expect(normalized.taskRun?.groups).toEqual([
      expect.objectContaining({ id: "model", title: "model", dependsOn: [], maxConcurrency: 1 }),
      expect.objectContaining({ id: "runtime", title: "runtime", dependsOn: [], maxConcurrency: 1 }),
    ]);
    expect(normalized.taskRun?.tasks[0]).toMatchObject({ id: "types", groupId: "model" });
    expect(normalized.taskRun?.tasks[1]).toMatchObject({ id: "scheduler", groupId: "runtime" });
  });

  test("rejects task runs without a title, request, or context", () => {
    expectValidationError({ tasks: [validTask()] }, "Task run title, request, or context is required");
  });

  test("rejects task runs without tasks", () => {
    expectValidationError(validInput({ tasks: [] }), "Task run must contain at least one task");
  });

  test.each([0, 1.5])("rejects invalid taskRun maxConcurrency %s", (maxConcurrency) => {
    expectValidationError(validInput({ maxConcurrency }), "Task run maxConcurrency must be a positive integer");
  });

  test.each([0, 1.5])("rejects invalid group maxConcurrency %s", (maxConcurrency) => {
    expectValidationError(
      validInput({ groups: [{ id: "api", maxConcurrency }], tasks: [validTask({ group: "api" })] }),
      "Group api maxConcurrency must be a positive integer",
    );
  });

  test.each([null, "tasks", 42, [minimalTaskRun]])(
    "returns validation errors for malformed top-level input %#",
    (input) => {
      expect(validateTaskRunInput(input)).toEqual(["Task run input must be an object"]);
      expect(normalizeTaskRunInput(input, { taskRunId: "run-1", now: 1 })).toEqual({
        errors: ["Task run input must be an object"],
      });
    },
  );
  test.each(["bad id", " "])(
    "rejects invalid explicit taskRunId %s",
    (taskRunId) => {
      expectValidationError(validInput({ taskRunId }), taskRunId.trim() ? `Task run id must be a valid identifier: ${taskRunId}` : "Task run id must be a valid identifier");
    },
  );

  test("accepts broad safe identifier characters", () => {
    const normalized = normalizeTaskRunInput({
      title: "Use broad ids",
      taskRunId: "TaskRun.1",
      groups: [{ id: "Group.1" }],
      tasks: [validTask({ id: "Task.1", group: "Group.1" })],
    }, { taskRunId: "fallback-run", now: 1 });

    expect(normalized.errors).toEqual([]);
    expect(normalized.taskRun?.id).toBe("TaskRun.1");
    expect(normalized.taskRun?.groups[0]?.id).toBe("Group.1");
    expect(normalized.taskRun?.tasks[0]?.id).toBe("Task.1");
  });

  test("rejects invalid task outputMode", () => {
    expectValidationError(
      validInput({ tasks: [validTask({ outputMode: "yaml" as unknown as TaskInput["outputMode"] })] }),
      "Task task-1 outputMode must be text or json",
    );
  });

  test("returns validation errors for malformed list values instead of throwing", () => {
    const input = validInput({
      tasks: [
        validTask({
          criteria: "Done." as unknown as string[],
          dependsOn: "upstream" as unknown as string[],
          filesHint: ["src/types.ts", 42] as unknown as string[],
        }),
      ],
    });

    expect(validateTaskRunInput(input)).toEqual(expect.arrayContaining([
      "Task task-1 criteria must be a list",
      "Task task-1 dependencies must be a list",
      "Task task-1 filesHint contains an invalid entry at index 2",
    ]));
  });

  test("returns validation errors for malformed group and task entries instead of throwing", () => {
    const input = {
      title: "Malformed entries",
      groups: [null],
      tasks: [null],
    } as unknown as SetTasksInput;

    expect(validateTaskRunInput(input)).toEqual(expect.arrayContaining([
      "Group 1 must be an object",
      "Task 1 must be an object",
    ]));
  });

  test("rejects duplicate task ids", () => {
    expectValidationError(
      validInput({ tasks: [validTask({ id: "duplicate" }), validTask({ id: "duplicate", text: "Do another task." })] }),
      "Duplicate task id: duplicate",
    );
  });

  test("rejects duplicate group ids", () => {
    expectValidationError(
      validInput({ groups: [{ id: "duplicate" }, { id: "duplicate" }], tasks: [validTask({ group: "duplicate" })] }),
      "Duplicate group id: duplicate",
    );
  });

  test("rejects missing or invalid explicit group ids", () => {
    expectValidationError(
      validInput({ groups: [{} as TaskGroupInput], tasks: [validTask({ group: "missing" })] }),
      "Group 1 id is required",
    );
    expectValidationError(
      validInput({ groups: [{ id: "bad group" }], tasks: [validTask({ group: "bad group" })] }),
      "Group 1 id must be a valid identifier: bad group",
    );
    expectValidationError(
      validInput({ groups: [{ id: "  " }], tasks: [validTask({ group: "missing" })] }),
      "Group 1 id must be a valid identifier",
    );

  });

  test("rejects invalid explicit task ids and generated ids only for omitted task ids", () => {
    expectValidationError(
      validInput({ tasks: [validTask({ id: "bad task" })] }),
      "Task 1 id must be a valid identifier: bad task",
    );
    expectValidationError(
      validInput({ tasks: [validTask({ id: "  " })] }),
      "Task 1 id must be a valid identifier",
    );


    const normalized = normalizeTaskRunInput(validInput({ tasks: [{ text: "Generated id task.", criteria: ["Done."] }] }), {
      taskRunId: "run-1",
      now: 1,
    });

    expect(normalized.errors).toEqual([]);
    expect(normalized.taskRun?.tasks[0]?.id).toBe("task-1");
  });

  test("rejects tasks with empty text or missing criteria", () => {
    expectValidationError(validInput({ tasks: [validTask({ text: "  " })] }), "Task task-1 text is required");
    expectValidationError(
      validInput({ tasks: [{ id: "task-1", text: "Do task." } as TaskInput] }),
      "Task task-1 must have at least one criterion",
    );
  });

  test("rejects tasks that reference an unknown declared group", () => {
    expectValidationError(
      validInput({
        groups: [{ id: "known" }],
        tasks: [validTask({ id: "known-task", group: "known" }), validTask({ id: "orphan", group: "missing" })],
      }),
      "Task orphan references unknown group missing",
    );
  });

  test("rejects invalid group references when inferring groups", () => {
    expectValidationError(
      validInput({ tasks: [validTask({ group: "bad group" })] }),
      "Task task-1 group reference must be a valid identifier: bad group",
    );

  });

  test("rejects declared groups with no tasks", () => {
    expectValidationError(
      validInput({ groups: [{ id: "empty" }], tasks: [validTask()] }),
      "Group empty must contain at least one task",
    );
  });

  test("rejects group unknown and self dependencies", () => {
    expectValidationError(
      validInput({ groups: [{ id: "api", dependsOn: ["missing"] }], tasks: [validTask({ group: "api" })] }),
      "Group api depends on unknown group missing",
    );
    expectValidationError(
      validInput({ groups: [{ id: "api", dependsOn: ["api"] }], tasks: [validTask({ group: "api" })] }),
      "Group api cannot depend on itself",
    );
  });

  test("rejects malformed group and task dependency identifiers", () => {
    expectValidationError(
      validInput({ groups: [{ id: "api", dependsOn: ["bad dep"] }], tasks: [validTask({ group: "api" })] }),
      "Group api dependency must be a valid identifier: bad dep",
    );
    expectValidationError(
      validInput({ tasks: [validTask({ id: "api", dependsOn: ["bad dep"] })] }),
      "Task api dependency must be a valid identifier: bad dep",
    );
  });

  test("rejects task unknown and self dependencies", () => {
    expectValidationError(
      validInput({ tasks: [validTask({ id: "api", dependsOn: ["missing"] })] }),
      "Task api depends on unknown task missing",
    );
    expectValidationError(
      validInput({ tasks: [validTask({ id: "api", dependsOn: ["api"] })] }),
      "Task api cannot depend on itself",
    );
  });

  test("rejects group dependency cycles", () => {
    expectValidationError(
      validInput({
        groups: [
          { id: "api", dependsOn: ["ui"] },
          { id: "ui", dependsOn: ["api"] },
        ],
        tasks: [validTask({ id: "api-task", group: "api" }), validTask({ id: "ui-task", group: "ui" })],
      }),
      "Group dependency cycle detected: api -> ui -> api",
    );
  });

  test("rejects task dependency cycles", () => {
    expectValidationError(
      validInput({
        tasks: [validTask({ id: "api", dependsOn: ["ui"] }), validTask({ id: "ui", dependsOn: ["api"] })],
      }),
      "Task dependency cycle detected: api -> ui -> api",
    );
  });

  test.each([-1, 1.5])("rejects invalid task retries %s", (retries) => {
    expectValidationError(validInput({ tasks: [validTask({ retries })] }), "Task task-1 retries must be a non-negative integer");
  });
});
