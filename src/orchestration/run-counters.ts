// ──────────────────────────────────────────────
// Counter seeding helpers for restored task-run state
// ──────────────────────────────────────────────

import type { TaskRunRecord } from "../types.js";

export function maxTaskRunCounter(taskRuns: TaskRunRecord[]): number {
  return taskRuns.reduce((max, taskRun) => {
    const match = /^task-run-(\d+)$/u.exec(taskRun.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

export function maxDispatchRunCounter(taskRuns: TaskRunRecord[]): number {
  let max = 0;
  for (const taskRun of taskRuns) {
    for (const assignment of taskRun.assignments) {
      const match = /-(\d+)$/u.exec(assignment.runId ?? assignment.launchRef?.runId ?? "");
      if (match) max = Math.max(max, Number(match[1]));
    }
  }
  return max;
}
