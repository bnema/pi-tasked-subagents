// ──────────────────────────────────────────────
// Task-run patch application helpers
// ──────────────────────────────────────────────

import type { PatchTaskRunInput, SetTasksInput, TaskGroupRecord, TaskInput, TaskRecord, TaskRunRecord } from "../types.js";
import { normalizeTaskRunInput, validateTaskRunInput } from "../state/task-run-validation.js";
import { normalizeTargetId } from "./ids.js";
import { deriveTaskRunStatus } from "./task-scheduler.js";

export interface ApplyTaskRunPatchResult {
  patched: boolean;
  errors: string[];
  dispatchScheduled: boolean;
}

function taskToInput(task: TaskRecord): TaskInput {
  return {
    id: task.id,
    group: task.groupId,
    text: task.text,
    criteria: task.criteria.map((criterion) => criterion.text),
    dependsOn: task.dependsOn,
    agentHint: task.agentHint,
    filesHint: task.filesHint,
    cwd: task.cwd,
    retries: task.retries,
    outputMode: task.outputMode,
    outputSchema: task.outputSchema,
    when: task.when,
    expansionMode: task.expansionMode,
  };
}

function groupToInput(group: TaskGroupRecord): NonNullable<SetTasksInput["groups"]>[number] {
  return {
    id: group.id,
    title: group.title,
    dependsOn: group.dependsOn,
    maxConcurrency: group.maxConcurrency,
    agentHint: group.agentHint,
    filesHint: group.filesHint,
  };
}

export function taskRunToInput(taskRun: TaskRunRecord): SetTasksInput {
  return {
    taskRunId: taskRun.id,
    title: taskRun.title,
    request: taskRun.request,
    context: taskRun.context,
    groups: taskRun.groups.map(groupToInput),
    tasks: taskRun.tasks.map(taskToInput),
    maxConcurrency: taskRun.maxConcurrency,
  };
}

export function applyTaskRunPatchMutable(
  taskRun: TaskRunRecord,
  input: Pick<PatchTaskRunInput, "groups" | "tasks">,
  timestamp: number,
): ApplyTaskRunPatchResult {
  if ((!input.groups || input.groups.length === 0) && (!input.tasks || input.tasks.length === 0)) {
    return { patched: false, errors: ["Patch requires groups or tasks"], dispatchScheduled: false };
  }

  const errors: string[] = [];
  const existingTaskIds = new Set(taskRun.tasks.map((task) => task.id));
  const newTaskIds = new Set<string>();
  for (const [index, task] of (input.tasks ?? []).entries()) {
    const taskId = normalizeTargetId(task.id);
    if (!taskId) {
      errors.push(`Patch task ${index + 1} id is required`);
      continue;
    }
    if (existingTaskIds.has(taskId)) errors.push(`Task ${taskId} already exists; use edit_task to modify existing tasks`);
    if (newTaskIds.has(taskId)) errors.push(`Duplicate patch task id: ${taskId}`);
    newTaskIds.add(taskId);
  }
  if (errors.length > 0) return { patched: false, errors, dispatchScheduled: false };

  const candidate = taskRunToInput(taskRun);
  candidate.groups ??= [];
  for (const groupPatch of input.groups ?? []) {
    const groupId = normalizeTargetId(groupPatch.id);
    const existingIndex = groupId ? candidate.groups.findIndex((group) => group.id === groupId) : -1;
    if (existingIndex >= 0) candidate.groups[existingIndex] = { ...candidate.groups[existingIndex], ...groupPatch, id: candidate.groups[existingIndex].id };
    else candidate.groups.push(groupPatch);
  }
  candidate.tasks.push(...(input.tasks ?? []));

  const validationErrors = validateTaskRunInput(candidate);
  if (validationErrors.length > 0) return { patched: false, errors: validationErrors, dispatchScheduled: false };

  const normalized = normalizeTaskRunInput(candidate, { taskRunId: taskRun.id, now: timestamp });
  if (!normalized.taskRun) return { patched: false, errors: normalized.errors, dispatchScheduled: false };

  const normalizedGroupsById = new Map(normalized.taskRun.groups.map((group) => [group.id, group]));
  for (const normalizedGroup of normalized.taskRun.groups) {
    const existing = taskRun.groups.find((group) => group.id === normalizedGroup.id);
    if (existing) {
      existing.title = normalizedGroup.title;
      existing.dependsOn = normalizedGroup.dependsOn;
      existing.maxConcurrency = normalizedGroup.maxConcurrency;
      existing.agentHint = normalizedGroup.agentHint;
      existing.filesHint = normalizedGroup.filesHint;
      existing.updatedAt = timestamp;
    } else taskRun.groups.push(normalizedGroup);
  }
  taskRun.groups = taskRun.groups.filter((group) => normalizedGroupsById.has(group.id));

  for (const normalizedTask of normalized.taskRun.tasks) {
    if (!newTaskIds.has(normalizedTask.id)) continue;
    taskRun.tasks.push(normalizedTask);
  }

  if (newTaskIds.size > 0) {
    taskRun.status = "running";
    taskRun.completedAt = undefined;
  }
  taskRun.updatedAt = timestamp;
  deriveTaskRunStatus(taskRun, timestamp);
  return { patched: true, errors: [], dispatchScheduled: newTaskIds.size > 0 };
}
