import { describe, expect, test } from "vitest";

import { ASSIGNMENT_STATUSES, TASK_GROUP_STATUSES, TASK_RUN_STATUSES, TASK_STATUSES } from "../src/types.js";

describe("public model smoke", () => {
  test("exports task-run status constants", () => {
    expect(TASK_RUN_STATUSES).toContain("running");
    expect(TASK_GROUP_STATUSES).toContain("ready");
    expect(TASK_STATUSES).toContain("completed");
    expect(ASSIGNMENT_STATUSES).toContain("paused");
  });
});
