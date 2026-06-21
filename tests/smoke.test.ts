import { describe, expect, test } from "vitest";

import { ASSIGNMENT_STATUSES, PHASE_STATUSES, PLAN_STATUSES, TASK_STATUSES } from "../src/types.js";

describe("public model smoke", () => {
  test("exports plan-first status constants", () => {
    expect(PLAN_STATUSES).toContain("running");
    expect(PHASE_STATUSES).toContain("ready");
    expect(TASK_STATUSES).toContain("completed");
    expect(ASSIGNMENT_STATUSES).toContain("paused");
  });
});
