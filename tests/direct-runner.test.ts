import { describe, expect, test } from "vitest";

import {
  evaluateTaskGraphCondition,
  getReadyTaskGraphStepIds,
  parseStructuredStepOutput,
  renderTaskGraphTemplate,
  renderTerminationSignal,
} from "../src/launcher/direct-runner.mjs";

describe("direct runner task graph internals", () => {
  test("renders dependency outputs into task prompts", () => {
    expect(renderTaskGraphTemplate("Use {{scan.summary}}", {
      scan: { summary: "found issue", output: "details", success: true },
    })).toBe("Use found issue");
  });

  test("parses structured JSON output", () => {
    expect(parseStructuredStepOutput("```json\n{\"summary\":\"ok\"}\n```", "json")).toEqual({ summary: "ok" });
  });

  test("evaluates conditions from structured outputs", () => {
    expect(evaluateTaskGraphCondition("{{triage.structured.runReview}}", {
      triage: { structuredOutput: { runReview: true } },
    })).toBe(true);
  });

  test("derives ready task ids from dependency completion", () => {
    expect(getReadyTaskGraphStepIds([
      { id: "a", status: "completed" },
      { id: "b", status: "pending", dependsOn: ["a"] },
      { id: "c", status: "pending", dependsOn: ["b"] },
    ], 2)).toEqual(["b"]);
  });

  test("preserves terminal step statuses on cancellation", () => {
    const signal = renderTerminationSignal({ state: "cancelled", steps: [
      { id: "done", status: "completed" },
      { id: "live", status: "running" },
    ] }, {}, 1);

    const status = signal.status as { steps?: Array<{ status?: string }> };
    expect(status.steps?.map((step) => step.status)).toEqual(["completed", "cancelled"]);
    expect(signal.result.state).toBe("cancelled");
  });
});
