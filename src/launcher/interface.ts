// ──────────────────────────────────────────────
// Task-assignment launcher request/result types
// ──────────────────────────────────────────────

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LaunchTaskGraphRequest, OutputMode } from "../types.js";

export type { LaunchTaskEntry, LaunchTaskGraphRequest } from "../types.js";

export interface RunnerRuntimeContext {
  pi: ExtensionAPI;
  cwd: string;
  sessionId: string;
  currentModelProvider?: string;
}

/** @deprecated Use RunnerRuntimeContext. */
export type LauncherRuntimeContext = RunnerRuntimeContext;

export interface LaunchResult {
  runId: string;
  asyncId: string;
  asyncDir: string;
  resultId: string;
  resultPath: string;
  resultReservationPath: string;
  sessionFile?: string;
  artifactPath?: string;
  model?: string;
}

export interface RunnerAgentProfileConfig {
  name: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  thinking?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
}

export interface RunnerChildConfig {
  id: string;
  dependsOn?: string[];
  agent: string;
  taskSummary: string;
  prompt: string;
  cwd: string;
  sessionDir: string;
  outputFile: string;
  retries?: number;
  outputMode?: OutputMode;
  outputSchema?: string;
  when?: string;
  resolvedModel?: string;
  resolvedThinking?: string;
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
  tools?: string[];
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  profileByAgent?: Record<string, RunnerAgentProfileConfig>;
}

/**
 * Internal direct-runner configuration. The public launcher boundary is
 * task-graph oriented; the runner may still schedule the graph as a DAG.
 */
export interface RunnerConfig {
  runId: string;
  /** Identity scope established by the adapter before the child starts. */
  sessionId: string;
  mode: "task_graph";
  maxConcurrency?: number;
  piBin: string;
  asyncDir: string;
  resultsDir: string;
  resultId: string;
  resultPath: string;
  resultReservationPath: string;
  statusPath: string;
  eventsPath: string;
  children: RunnerChildConfig[];
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function ensureTaskGraphRequest(request: LaunchTaskGraphRequest): void {
  if (!nonEmptyString(request.runId)) throw new Error("Task graph runId is required");
  if (!nonEmptyString(request.title)) throw new Error("Task graph title is required");
  if (!Array.isArray(request.tasks) || request.tasks.length === 0) {
    throw new Error("Task graph requires at least one task assignment");
  }

  const ids = new Set<string>();
  const normalizedIds: string[] = [];
  for (const task of request.tasks) {
    if (!nonEmptyString(task.assignmentId)) throw new Error("Task assignment id is required");
    const assignmentId = task.assignmentId.trim();
    if (ids.has(assignmentId)) throw new Error(`Duplicate task assignment id: ${assignmentId}`);
    ids.add(assignmentId);
    normalizedIds.push(assignmentId);
    if (!nonEmptyString(task.taskRunId)) throw new Error(`Task assignment ${assignmentId} missing taskRunId`);
    if (task.groupId !== undefined && !nonEmptyString(task.groupId)) throw new Error(`Task assignment ${assignmentId} has invalid groupId`);
    if (!nonEmptyString(task.taskId)) throw new Error(`Task assignment ${assignmentId} missing taskId`);
    if (!nonEmptyString(task.agent)) throw new Error(`Task assignment ${assignmentId} missing agent`);
    if (!nonEmptyString(task.prompt)) throw new Error(`Task assignment ${assignmentId} missing prompt`);
  }

  const dependenciesById = new Map<string, string[]>();
  for (const [index, task] of request.tasks.entries()) {
    const assignmentId = normalizedIds[index];
    const dependencies: string[] = [];
    for (const dependencyId of task.dependsOn ?? []) {
      if (!nonEmptyString(dependencyId)) throw new Error(`Task assignment ${assignmentId} has invalid dependency id`);
      const normalizedDependencyId = dependencyId.trim();
      if (normalizedDependencyId === assignmentId) throw new Error(`Task assignment ${assignmentId} cannot depend on itself`);
      if (!ids.has(normalizedDependencyId)) throw new Error(`Task assignment ${assignmentId} depends on unknown assignment ${normalizedDependencyId}`);
      dependencies.push(normalizedDependencyId);
    }
    dependenciesById.set(assignmentId, dependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (assignmentId: string, path: string[]): void => {
    if (visited.has(assignmentId)) return;
    if (visiting.has(assignmentId)) {
      throw new Error(`Task assignment dependency cycle detected: ${[...path, assignmentId].join(" -> ")}`);
    }
    visiting.add(assignmentId);
    for (const dependencyId of dependenciesById.get(assignmentId) ?? []) visit(dependencyId, [...path, assignmentId]);
    visiting.delete(assignmentId);
    visited.add(assignmentId);
  };
  for (const assignmentId of normalizedIds) visit(assignmentId, []);
}
