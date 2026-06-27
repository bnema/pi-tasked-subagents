// ──────────────────────────────────────────────
// Task-run input validation and normalization
// ──────────────────────────────────────────────

import type {
  SetTasksInput,
  TaskGroupInput,
  TaskGroupRecord,
  TaskInput,
  TaskRecord,
  TaskRunRecord,
} from "../types.js";

type IdentifierResult = { value?: string; error?: string };

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function identifierError(label: string, value: unknown): string {
  const text = typeof value === "string" ? value.trim() : String(value);
  return `${label} must be a valid identifier${text ? `: ${text}` : ""}`;
}

function cleanIdentifier(
  value: unknown,
  label: string,
  options: { fallback?: string; required?: boolean } = {},
): IdentifierResult {
  if (value === undefined) {
    if (options.fallback !== undefined) return cleanIdentifier(options.fallback, label);
    if (options.required) return { error: `${label} is required` };
    return {};
  }
  if (typeof value !== "string") return { error: identifierError(label, value) };
  const cleaned = value.trim();
  if (!cleaned || !/^[A-Za-z0-9_.-]+$/u.test(cleaned)) return { error: identifierError(label, value) };
  return { value: cleaned };
}

function cleanTextList(values: unknown, label?: string, errors?: string[]): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    if (label && errors) errors.push(`${label} must be a list`);
    return [];
  }

  const cleaned: string[] = [];
  for (const [index, value] of values.entries()) {
    const text = cleanText(value);
    if (!text) {
      if (label && errors) errors.push(`${label} contains an invalid entry at index ${index + 1}`);
      continue;
    }
    cleaned.push(text);
  }
  return cleaned;
}

function cleanIdentifierList(values: unknown, entryLabel: string, listLabel: string, errors: string[]): string[] {
  const cleaned = cleanTextList(values, listLabel, errors);
  const identifiers: string[] = [];
  for (const value of cleaned) {
    const result = cleanIdentifier(value, entryLabel);
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    if (result.value) identifiers.push(result.value);
  }
  return identifiers;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function generatedTaskId(index: number): string {
  return `task-${index + 1}`;
}

function addUnique(errors: string[], error: string): void {
  if (!errors.includes(error)) errors.push(error);
}

function detectCycle(ids: string[], depsFor: (id: string) => string[], label: string): string | undefined {
  const known = new Set(ids);
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, path: string[]): string | undefined => {
    if (!known.has(id) || visited.has(id)) return undefined;
    if (visiting.has(id)) return `${label} dependency cycle detected: ${[...path, id].join(" -> ")}`;
    visiting.add(id);
    for (const dep of depsFor(id)) {
      const result = visit(dep, [...path, id]);
      if (result) return result;
    }
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };

  for (const id of ids) {
    const result = visit(id, []);
    if (result) return result;
  }
  return undefined;
}

function inferredGroupIds(input: SetTasksInput): string[] {
  const ids: string[] = [];
  for (const task of input.tasks ?? []) {
    const groupId = cleanIdentifier(task.group, "Task group reference").value;
    if (groupId && !ids.includes(groupId)) ids.push(groupId);
  }
  return ids;
}

export function validateTaskRunInput(input: unknown): string[] {
  const errors: string[] = [];
  const taskRunInput = objectRecord(input);
  if (!taskRunInput) return ["Task run input must be an object"];
  if (!cleanText(taskRunInput.title) && !cleanText(taskRunInput.request) && !cleanText(taskRunInput.context)) {
    errors.push("Task run title, request, or context is required");
  }
  if (taskRunInput.taskRunId !== undefined) {
    const taskRunId = cleanIdentifier(taskRunInput.taskRunId, "Task run id");
    if (taskRunId.error) errors.push(taskRunId.error);
  }
  if (
    taskRunInput.maxConcurrency !== undefined
    && (typeof taskRunInput.maxConcurrency !== "number"
      || !Number.isInteger(taskRunInput.maxConcurrency)
      || taskRunInput.maxConcurrency < 1)
  ) {
    errors.push("Task run maxConcurrency must be a positive integer");
  }
  if (taskRunInput.groups !== undefined && !Array.isArray(taskRunInput.groups)) errors.push("Task groups must be a list");
  if (!Array.isArray(taskRunInput.tasks) || taskRunInput.tasks.length === 0) errors.push("Task run must contain at least one task");

  const hasExplicitGroups = Array.isArray(taskRunInput.groups);
  const groupIds: string[] = [];
  const groupDeps = new Map<string, string[]>();
  const taskIds: string[] = [];
  const taskDeps = new Map<string, string[]>();
  const taskCountsByGroup = new Map<string, number>();

  for (const [groupIndex, rawGroup] of (Array.isArray(taskRunInput.groups) ? taskRunInput.groups : []).entries()) {
    const group = objectRecord(rawGroup);
    if (!group) {
      errors.push(`Group ${groupIndex + 1} must be an object`);
      continue;
    }
    const groupIdResult = cleanIdentifier(group.id, `Group ${groupIndex + 1} id`, { required: true });
    const groupLabel = groupIdResult.value ?? `${groupIndex + 1}`;
    if (groupIdResult.error) errors.push(groupIdResult.error);
    const maxConcurrency = group.maxConcurrency;
    if (maxConcurrency !== undefined && (typeof maxConcurrency !== "number" || !Number.isInteger(maxConcurrency) || maxConcurrency < 1)) {
      errors.push(`Group ${groupLabel} maxConcurrency must be a positive integer`);
    }
    const dependsOn = cleanIdentifierList(group.dependsOn, `Group ${groupLabel} dependency`, `Group ${groupLabel} dependencies`, errors);
    cleanTextList(group.filesHint, `Group ${groupLabel} filesHint`, errors);
    if (!groupIdResult.value) continue;
    if (groupIds.includes(groupIdResult.value)) addUnique(errors, `Duplicate group id: ${groupIdResult.value}`);
    groupIds.push(groupIdResult.value);
    groupDeps.set(groupIdResult.value, dependsOn);
    taskCountsByGroup.set(groupIdResult.value, 0);
  }

  const knownGroupIds = new Set(groupIds);
  for (const [taskIndex, rawTask] of (Array.isArray(taskRunInput.tasks) ? taskRunInput.tasks : []).entries()) {
    const task = objectRecord(rawTask);
    if (!task) {
      errors.push(`Task ${taskIndex + 1} must be an object`);
      continue;
    }
    const taskIdResult = cleanIdentifier(task.id, `Task ${taskIndex + 1} id`, { fallback: generatedTaskId(taskIndex) });
    const taskId = taskIdResult.value ?? `task ${taskIndex + 1}`;
    if (taskIdResult.error) errors.push(taskIdResult.error);
    if (taskIdResult.value) {
      if (taskIds.includes(taskIdResult.value)) addUnique(errors, `Duplicate task id: ${taskIdResult.value}`);
      taskIds.push(taskIdResult.value);
    }
    if (!cleanText(task.text)) errors.push(`Task ${taskId} text is required`);
    const criteria = cleanTextList(task.criteria, `Task ${taskId} criteria`, errors);
    if (criteria.length === 0) errors.push(`Task ${taskId} must have at least one criterion`);
    const dependsOn = cleanIdentifierList(task.dependsOn, `Task ${taskId} dependency`, `Task ${taskId} dependencies`, errors);
    if (taskIdResult.value) taskDeps.set(taskIdResult.value, dependsOn);
    cleanTextList(task.filesHint, `Task ${taskId} filesHint`, errors);
    const retries = task.retries;
    if (retries !== undefined && (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0)) {
      errors.push(`Task ${taskId} retries must be a non-negative integer`);
    }
    if (task.outputMode !== undefined && task.outputMode !== "text" && task.outputMode !== "json") {
      errors.push(`Task ${taskId} outputMode must be text or json`);
    }

    const groupIdResult = cleanIdentifier(task.group, `Task ${taskId} group reference`);
    if (groupIdResult.error) {
      errors.push(groupIdResult.error);
      continue;
    }
    const groupId = groupIdResult.value;
    if (!groupId) continue;
    if (hasExplicitGroups && !knownGroupIds.has(groupId)) errors.push(`Task ${taskId} references unknown group ${groupId}`);
    if (!hasExplicitGroups && !knownGroupIds.has(groupId)) {
      knownGroupIds.add(groupId);
      groupIds.push(groupId);
      groupDeps.set(groupId, []);
      taskCountsByGroup.set(groupId, 0);
    }
    taskCountsByGroup.set(groupId, (taskCountsByGroup.get(groupId) ?? 0) + 1);
  }

  if (hasExplicitGroups) {
    for (const groupId of groupIds) {
      if ((taskCountsByGroup.get(groupId) ?? 0) === 0) errors.push(`Group ${groupId} must contain at least one task`);
    }
  }

  for (const [groupId, deps] of groupDeps) {
    for (const dep of deps) {
      if (!knownGroupIds.has(dep)) errors.push(`Group ${groupId} depends on unknown group ${dep}`);
      if (dep === groupId) errors.push(`Group ${groupId} cannot depend on itself`);
    }
  }

  const knownTaskIds = new Set(taskIds);
  for (const [taskId, deps] of taskDeps) {
    for (const dep of deps) {
      if (!knownTaskIds.has(dep)) errors.push(`Task ${taskId} depends on unknown task ${dep}`);
      if (dep === taskId) errors.push(`Task ${taskId} cannot depend on itself`);
    }
  }

  const groupCycle = detectCycle(groupIds, (id) => groupDeps.get(id) ?? [], "Group");
  if (groupCycle) errors.push(groupCycle);
  const taskCycle = detectCycle(taskIds, (id) => taskDeps.get(id) ?? [], "Task");
  if (taskCycle) errors.push(taskCycle);

  return errors;
}

function normalizeTask(taskIndex: number, input: TaskInput, now: number): TaskRecord {
  const filesHint = cleanTextList(input.filesHint);
  return {
    id: cleanIdentifier(input.id, `Task ${taskIndex + 1} id`, { fallback: generatedTaskId(taskIndex) }).value ?? generatedTaskId(taskIndex),
    groupId: cleanIdentifier(input.group, "Task group reference").value,
    text: cleanText(input.text),
    status: "pending",
    criteria: cleanTextList(input.criteria).map((criterion, criterionIndex) => ({
      id: `C${criterionIndex + 1}`,
      text: criterion,
      satisfied: false,
      evidence: [],
    })),
    dependsOn: cleanIdentifierList(input.dependsOn, "Task dependency", "Task dependencies", []),
    assignmentIds: [],
    agentHint: cleanText(input.agentHint) || undefined,
    filesHint: filesHint.length > 0 ? filesHint : undefined,
    cwd: cleanText(input.cwd) || undefined,
    retries: input.retries,
    outputMode: input.outputMode === "text" || input.outputMode === "json" ? input.outputMode : undefined,
    outputSchema: cleanText(input.outputSchema) || undefined,
    when: cleanText(input.when) || undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeExplicitGroup(groupIndex: number, input: TaskGroupInput, now: number): TaskGroupRecord {
  const groupId = cleanIdentifier(input.id, `Group ${groupIndex + 1} id`, { required: true }).value ?? "";
  const filesHint = cleanTextList(input.filesHint);
  const dependsOn = cleanIdentifierList(input.dependsOn, "Group dependency", "Group dependencies", []);
  return {
    id: groupId,
    title: cleanText(input.title) || groupId,
    status: dependsOn.length === 0 ? "ready" : "pending",
    dependsOn,
    maxConcurrency: input.maxConcurrency ?? 1,
    agentHint: cleanText(input.agentHint) || undefined,
    filesHint: filesHint.length > 0 ? filesHint : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeInferredGroup(groupId: string, now: number): TaskGroupRecord {
  return {
    id: groupId,
    title: groupId,
    status: "ready",
    dependsOn: [],
    maxConcurrency: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeTaskRunInput(
  input: unknown,
  options: { taskRunId: string; now?: number },
): { taskRun?: TaskRunRecord; errors: string[] } {
  const errors = validateTaskRunInput(input);
  if (errors.length > 0) return { errors };
  const taskRunInput = input as SetTasksInput;

  const timestamp = options.now ?? Date.now();
  const request = cleanText(taskRunInput.request) || cleanText(taskRunInput.context) || cleanText(taskRunInput.title);
  const context = cleanText(taskRunInput.context) || cleanText(taskRunInput.request) || cleanText(taskRunInput.title);
  const title = cleanText(taskRunInput.title) || cleanText(taskRunInput.request) || cleanText(taskRunInput.context).slice(0, 80);
  const tasks = taskRunInput.tasks.map((task, taskIndex) => normalizeTask(taskIndex, task, timestamp));
  const groupIds = Array.isArray(taskRunInput.groups)
    ? taskRunInput.groups.map((group, groupIndex) => cleanIdentifier(group.id, `Group ${groupIndex + 1} id`, { required: true }).value ?? "")
    : inferredGroupIds(taskRunInput);
  const groups = Array.isArray(taskRunInput.groups)
    ? taskRunInput.groups.map((group, groupIndex) => normalizeExplicitGroup(groupIndex, group, timestamp))
    : groupIds.map((groupId) => normalizeInferredGroup(groupId, timestamp));
  const taskRunIdResult = cleanIdentifier(taskRunInput.taskRunId, "Task run id", { fallback: options.taskRunId });
  if (taskRunIdResult.error) return { errors: [taskRunIdResult.error] };
  const taskRunId = taskRunIdResult.value ?? options.taskRunId;

  return {
    errors: [],
    taskRun: {
      id: taskRunId,
      title,
      request,
      context,
      status: "running",
      groups,
      tasks,
      assignments: [],
      artifacts: [],
      maxConcurrency: taskRunInput.maxConcurrency,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}
