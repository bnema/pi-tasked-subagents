// ──────────────────────────────────────────────
// Task scheduler: derive ready task assignments from task-run state
// ──────────────────────────────────────────────

import {
  ASSIGNMENT_STATUSES,
  type AssignmentStatus,
  type LaunchTaskEntry,
  type RunProgressSnapshot,
  type TaskAssignmentRecord,
  type TaskGroupRecord,
  type TaskRecord,
  type TaskRunRecord,
} from "../types.js";

export interface SchedulerOptions {
  defaultAgent: string;
  defaultCwd: string;
  now?: number;
}

type TaskAssignmentWithLaunchDefaults = TaskAssignmentRecord & {
  cwd?: string;
};

export interface SchedulerResult {
  assignments: TaskAssignmentRecord[];
  hasBlockingIssue: boolean;
}

function now(options?: { now?: number }): number {
  return options?.now ?? Date.now();
}

function taskById(taskRun: TaskRunRecord): Map<string, TaskRecord> {
  return new Map(taskRun.tasks.map((task) => [task.id, task]));
}

function groupById(taskRun: TaskRunRecord): Map<string, TaskGroupRecord> {
  return new Map(taskRun.groups.map((group) => [group.id, group]));
}

function tasksForGroup(taskRun: TaskRunRecord, groupId: string | undefined): TaskRecord[] {
  return taskRun.tasks.filter((task) => task.groupId === groupId);
}

function taskCriteriaSatisfied(task: TaskRecord): boolean {
  return task.criteria.length > 0 && task.criteria.every((criterion) => criterion.satisfied);
}

function taskComplete(task: TaskRecord, assignment: TaskAssignmentRecord | undefined): boolean {
  return taskCriteriaSatisfied(task) && (assignment ? assignment.status === "completed" : task.status === "completed");
}

function isBlockingStatus(status: string): boolean {
  return status === "failed" || status === "attention" || status === "cancelled" || status === "blocked";
}

function isAssignmentStatus(status: string | undefined): status is AssignmentStatus {
  return typeof status === "string" && (ASSIGNMENT_STATUSES as readonly string[]).includes(status);
}

function isActiveAssignmentStatus(status: AssignmentStatus): boolean {
  return status === "queued" || status === "running";
}

function latestAssignment(taskRun: TaskRunRecord, task: TaskRecord): TaskAssignmentRecord | undefined {
  for (let index = task.assignmentIds.length - 1; index >= 0; index -= 1) {
    const assignment = taskRun.assignments.find((candidate) => candidate.id === task.assignmentIds[index]);
    if (assignment) return assignment;
  }
  return undefined;
}

function dependencyIdsForTask(taskRun: TaskRunRecord, task: TaskRecord): string[] {
  const dependencyIds = [...task.dependsOn];
  const addImplicitDependency = (taskId: string): void => {
    if (!dependencyIds.includes(taskId)) dependencyIds.push(taskId);
  };

  if (!task.groupId) {
    if (taskRun.maxConcurrency === undefined) {
      const ungroupedTasks = tasksForGroup(taskRun, undefined);
      const index = ungroupedTasks.findIndex((candidate) => candidate.id === task.id);
      if (index > 0) addImplicitDependency(ungroupedTasks[index - 1].id);
    }
    return dependencyIds;
  }

  const group = groupById(taskRun).get(task.groupId);
  const groupMaxConcurrency = group?.maxConcurrency ?? 1;
  if (groupMaxConcurrency > 1) return dependencyIds;

  const groupTasks = tasksForGroup(taskRun, task.groupId);
  const index = groupTasks.findIndex((candidate) => candidate.id === task.id);
  if (index > 0) addImplicitDependency(groupTasks[index - 1].id);
  return dependencyIds;
}

function groupDependenciesComplete(taskRun: TaskRunRecord, group: TaskGroupRecord): boolean {
  const groups = groupById(taskRun);
  return group.dependsOn.every((depId) => groups.get(depId)?.status === "completed");
}

function groupDependenciesBlocked(taskRun: TaskRunRecord, group: TaskGroupRecord): boolean {
  const groups = groupById(taskRun);
  return group.dependsOn.some((depId) => {
    const dependency = groups.get(depId);
    return dependency ? isBlockingStatus(dependency.status) : true;
  });
}

function taskDependenciesComplete(taskRun: TaskRunRecord, task: TaskRecord): boolean {
  const tasks = taskById(taskRun);
  return dependencyIdsForTask(taskRun, task).every((depId) => {
    const dependency = tasks.get(depId);
    return dependency ? dependency.status === "completed" : false;
  });
}

function taskDependenciesBlocked(taskRun: TaskRunRecord, task: TaskRecord): boolean {
  const tasks = taskById(taskRun);
  return dependencyIdsForTask(taskRun, task).some((depId) => {
    const dependency = tasks.get(depId);
    return dependency ? isBlockingStatus(dependency.status) : true;
  });
}

function activeCountForTaskRun(taskRun: TaskRunRecord): number {
  return taskRun.assignments.filter((assignment) => isActiveAssignmentStatus(assignment.status)).length;
}

function activeCountForGroup(taskRun: TaskRunRecord, group: TaskGroupRecord): number {
  const ids = new Set(tasksForGroup(taskRun, group.id).flatMap((task) => task.assignmentIds));
  return taskRun.assignments.filter((assignment) => ids.has(assignment.id) && isActiveAssignmentStatus(assignment.status)).length;
}

function taskHasActiveAssignment(taskRun: TaskRunRecord, task: TaskRecord): boolean {
  return task.assignmentIds
    .map((assignmentId) => taskRun.assignments.find((assignment) => assignment.id === assignmentId))
    .some((assignment) => assignment && isActiveAssignmentStatus(assignment.status));
}

function groupCanDispatchReadyTasks(taskRun: TaskRunRecord, group: TaskGroupRecord): boolean {
  if (groupDependenciesBlocked(taskRun, group) || !groupDependenciesComplete(taskRun, group)) return false;
  if (group.status === "ready" || group.status === "running") return true;
  const readyTasks = tasksForGroup(taskRun, group.id).filter((task) => task.status === "ready");
  if (group.status === "attention") return readyTasks.length > 0;
  return (group.status === "failed" || group.status === "cancelled" || group.status === "blocked")
    && readyTasks.some((task) => task.continuation?.trim());
}

function taskRunAvailableSlots(taskRun: TaskRunRecord): number {
  if (!taskRun.maxConcurrency) return Number.POSITIVE_INFINITY;
  return Math.max(0, taskRun.maxConcurrency - activeCountForTaskRun(taskRun));
}

function buildAssignmentId(taskRun: TaskRunRecord, group: TaskGroupRecord | undefined, task: TaskRecord): string {
  const groupPart = group ? `group-${group.id}` : "ungrouped";
  return `${taskRun.id}-${groupPart}-task-${task.id}-assignment-${task.assignmentIds.length + 1}`;
}

export function buildTaskAssignmentPrompt(taskRun: TaskRunRecord, group: TaskGroupRecord | undefined, task: TaskRecord): string {
  const upstreamOutputs = dependencyIdsForTask(taskRun, task)
    .map((taskId) => {
      const dependency = taskById(taskRun).get(taskId);
      const assignment = dependency ? latestAssignment(taskRun, dependency) : undefined;
      const summary = assignment?.result?.summary;
      return summary ? `Task ${taskId}: ${summary}` : undefined;
    })
    .filter((line): line is string => Boolean(line));

  return [
    "You are a subagent assigned one task by pi-tasked-subagents.",
    "Complete only this task. Report evidence for each criterion.",
    "Output ONLY valid JSON matching the SubagentTaskReport shape described below.",
    "",
    `TaskRun id: ${taskRun.id}`,
    `TaskRun title: ${taskRun.title}`,
    `TaskRun request: ${taskRun.request}`,
    `TaskRun context: ${taskRun.context}`,
    group ? `Group id: ${group.id}` : undefined,
    group ? `Group title: ${group.title}` : undefined,
    group?.filesHint?.length ? `Group files: ${group.filesHint.join(", ")}` : undefined,
    task.filesHint?.length ? `Task files: ${task.filesHint.join(", ")}` : undefined,
    "",
    `Task id: ${task.id}`,
    `Task: ${task.text}`,
    task.continuation ? `Continuation instructions: ${task.continuation}` : undefined,
    "Criteria:",
    ...task.criteria.map((criterion, index) => `  ${index}. ${criterion.text}`),
    upstreamOutputs.length > 0 ? "" : undefined,
    upstreamOutputs.length > 0 ? "Upstream task outputs:" : undefined,
    ...upstreamOutputs,
    "",
    "Required JSON:",
    JSON.stringify({
      taskRunId: taskRun.id,
      groupId: group?.id ?? "OMIT_FOR_UNGROUPED_TASK",
      taskId: task.id,
      assignmentId: "ASSIGNMENT_ID",
      status: "completed | attention | failed",
      summary: "short summary",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "specific evidence" }],
      artifacts: [{ label: "optional", path: "optional/path" }],
      followUps: ["optional blocker or follow-up"],
    }, null, 2),
    "",
    "Rules:",
    "- Use the exact taskRunId, groupId, taskId, and assignmentId provided by the launcher prompt.",
    "- Omit groupId only when this prompt has no Group id line.",
    "- criteriaEvidence must use zero-based criteriaIndex values from this task only.",
    "- Evidence must be concrete and non-empty.",
    "- Use status=attention when blocked or evidence is insufficient.",
    "- Use status=failed only for unrecoverable failure.",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function deriveTaskStatus(taskRun: TaskRunRecord, task: TaskRecord, group: TaskGroupRecord | undefined, timestamp: number): void {
  const assignment = latestAssignment(taskRun, task);
  const hasContinuation = Boolean(task.continuation?.trim());
  if (!hasContinuation && taskComplete(task, assignment)) {
    task.status = "completed";
    task.completedAt ??= timestamp;
    return;
  }
  if (!hasContinuation && assignment) {
    if (assignment.status === "completed" && !assignment.result && !taskCriteriaSatisfied(task)) {
      task.status = "running";
      return;
    }
    if (assignment.status !== "completed") {
      if (assignment.status === "paused") task.status = "attention";
      else if (assignment.status === "skipped") task.status = "blocked";
      else task.status = assignment.status === "queued" ? "running" : assignment.status;
      return;
    }
  }
  if (!hasContinuation && (task.status === "failed" || task.status === "attention" || task.status === "cancelled")) return;
  if (taskDependenciesBlocked(taskRun, task)) task.status = "blocked";
  else if (group) {
    if (groupDependenciesBlocked(taskRun, group)) task.status = task.status === "blocked" ? "blocked" : "pending";
    else if (groupDependenciesComplete(taskRun, group) && (group.status === "ready" || group.status === "running" || group.status === "attention")) {
      task.status = taskDependenciesComplete(taskRun, task) ? "ready" : "pending";
    }
  } else {
    task.status = taskDependenciesComplete(taskRun, task) ? "ready" : "pending";
  }
}

function deriveGroupStatus(taskRun: TaskRunRecord, group: TaskGroupRecord, timestamp: number): void {
  const depsBlocked = groupDependenciesBlocked(taskRun, group);
  const depsComplete = groupDependenciesComplete(taskRun, group);
  const groupTasks = tasksForGroup(taskRun, group.id);

  if (depsBlocked) group.status = "blocked";
  else if ((group.status === "pending" || group.status === "blocked" || group.status === "attention") && depsComplete) group.status = "ready";

  for (const task of groupTasks) deriveTaskStatus(taskRun, task, group, timestamp);

  const taskStatuses = groupTasks.map((task) => task.status);
  if (taskStatuses.length > 0 && taskStatuses.every((status) => status === "completed")) {
    group.status = "completed";
    group.completedAt ??= timestamp;
  } else if (taskStatuses.some((status) => status === "failed")) group.status = "failed";
  else if (taskStatuses.some((status) => status === "attention")) group.status = "attention";
  else if (taskStatuses.some((status) => status === "cancelled")) group.status = "cancelled";
  else if (taskStatuses.some((status) => status === "blocked") || depsBlocked) group.status = "blocked";
  else if (!depsComplete) group.status = "pending";
  else if (taskStatuses.some((status) => status === "running")) group.status = "running";
  else group.status = "ready";

  group.updatedAt = timestamp;
}

export function deriveTaskRunStatus(taskRun: TaskRunRecord, timestamp = Date.now()): void {
  const groups = groupById(taskRun);
  const maxPasses = Math.max(1, taskRun.groups.length + 1);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const before = [
      ...taskRun.groups.map((group) => `${group.id}:${group.status}`),
      ...taskRun.tasks.map((task) => `${task.id}:${task.status}`),
    ].join("|");
    for (const group of taskRun.groups) deriveGroupStatus(taskRun, group, timestamp);
    for (const task of taskRun.tasks) {
      if (!task.groupId || !groups.has(task.groupId)) deriveTaskStatus(taskRun, task, undefined, timestamp);
    }
    const after = [
      ...taskRun.groups.map((group) => `${group.id}:${group.status}`),
      ...taskRun.tasks.map((task) => `${task.id}:${task.status}`),
    ].join("|");
    if (after === before) break;
  }

  const groupStatuses = taskRun.groups.map((group) => group.status);
  const ungroupedStatuses = taskRun.tasks.filter((task) => !task.groupId || !groups.has(task.groupId)).map((task) => task.status);
  const statuses = [...groupStatuses, ...ungroupedStatuses];
  if (statuses.length > 0 && statuses.every((status) => status === "completed")) {
    taskRun.status = "completed";
    taskRun.completedAt ??= timestamp;
  } else if (statuses.some((status) => status === "failed")) taskRun.status = "failed";
  else if (statuses.some((status) => status === "attention" || status === "blocked")) taskRun.status = "attention";
  else if (statuses.some((status) => status === "cancelled")) taskRun.status = "cancelled";
  else taskRun.status = "running";
  taskRun.updatedAt = timestamp;
}


function createAssignment(taskRun: TaskRunRecord, group: TaskGroupRecord | undefined, task: TaskRecord, options: SchedulerOptions, timestamp: number): TaskAssignmentRecord {
  const assignmentId = buildAssignmentId(taskRun, group, task);
  const prompt = buildTaskAssignmentPrompt(taskRun, group, task).replace("ASSIGNMENT_ID", assignmentId);
  const assignment: TaskAssignmentWithLaunchDefaults = {
    id: assignmentId,
    taskRunId: taskRun.id,
    groupId: group?.id,
    taskId: task.id,
    agent: task.agentHint ?? group?.agentHint ?? options.defaultAgent,
    prompt,
    status: "queued",
    cwd: task.cwd ?? options.defaultCwd,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  task.assignmentIds.push(assignment.id);
  task.continuation = undefined;
  task.status = "running";
  task.updatedAt = timestamp;
  if (group) {
    group.status = "running";
    group.updatedAt = timestamp;
  }
  taskRun.assignments.push(assignment);
  return assignment;
}

export function createReadyAssignments(taskRun: TaskRunRecord, options: SchedulerOptions): SchedulerResult {
  const timestamp = now(options);
  deriveTaskRunStatus(taskRun, timestamp);

  const created: TaskAssignmentRecord[] = [];
  for (const group of taskRun.groups) {
    if (taskRunAvailableSlots(taskRun) <= 0) break;
    if (!groupCanDispatchReadyTasks(taskRun, group)) continue;
    const groupAvailableSlots = Math.max(0, (group.maxConcurrency ?? 1) - activeCountForGroup(taskRun, group));
    let availableSlots = Math.min(groupAvailableSlots, taskRunAvailableSlots(taskRun));
    if (availableSlots <= 0) continue;

    for (const task of tasksForGroup(taskRun, group.id)) {
      if (availableSlots <= 0 || taskRunAvailableSlots(taskRun) <= 0) break;
      if (task.status !== "ready" || taskHasActiveAssignment(taskRun, task)) continue;
      created.push(createAssignment(taskRun, group, task, options, timestamp));
      availableSlots -= 1;
    }
  }

  for (const task of taskRun.tasks) {
    if (taskRunAvailableSlots(taskRun) <= 0) break;
    if (task.groupId) continue;
    if (task.status !== "ready" || taskHasActiveAssignment(taskRun, task)) continue;
    created.push(createAssignment(taskRun, undefined, task, options, timestamp));
  }

  taskRun.updatedAt = timestamp;
  return {
    assignments: created,
    hasBlockingIssue: taskRun.status === "attention" || taskRun.status === "failed" || taskRun.status === "cancelled",
  };
}

export function toLaunchTaskEntries(assignments: TaskAssignmentRecord[], taskRun: TaskRunRecord, options: { defaultCwd?: string } = {}): LaunchTaskEntry[] {
  const assignmentIdsInLaunch = new Set(assignments.map((assignment) => assignment.id));
  const latestAssignmentIdByTaskId = new Map<string, string>();
  for (const assignment of taskRun.assignments) latestAssignmentIdByTaskId.set(assignment.taskId, assignment.id);

  return assignments.map((assignment) => {
    const task = taskRun.tasks.find((candidate) => candidate.id === assignment.taskId);
    const dependsOn = task ? dependencyIdsForTask(taskRun, task)
      .map((taskId) => latestAssignmentIdByTaskId.get(taskId))
      .filter((assignmentId): assignmentId is string => typeof assignmentId === "string" && assignmentIdsInLaunch.has(assignmentId)) : [];
    return {
      assignmentId: assignment.id,
      taskRunId: assignment.taskRunId,
      groupId: assignment.groupId,
      taskId: assignment.taskId,
      agent: assignment.agent,
      prompt: assignment.prompt,
      taskSummary: task?.text ?? assignment.taskId,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      retries: task?.retries,
      outputMode: task?.outputMode ?? "json",
      outputSchema: task?.outputSchema ?? "SubagentTaskReport JSON object",
      when: task?.when,
      cwd: task?.cwd ?? (assignment as TaskAssignmentWithLaunchDefaults).cwd ?? options.defaultCwd,
    } satisfies LaunchTaskEntry;
  });
}

export function applyAssignmentProgress(taskRun: TaskRunRecord, snapshot: RunProgressSnapshot, timestamp = Date.now()): boolean {
  let changed = false;
  for (const step of snapshot.steps) {
    if (!step.id) continue;
    const assignment = taskRun.assignments.find((candidate) => candidate.id === step.id);
    if (!assignment) continue;
    if (assignment.runId !== snapshot.runId) continue;
    if (isAssignmentStatus(step.status)) assignment.status = step.status;
    assignment.currentTool = step.currentTool;
    assignment.lastActionAt = step.lastActionAt ?? assignment.lastActionAt;
    assignment.lastActionSummary = step.lastActionSummary ?? assignment.lastActionSummary;
    assignment.recentActivity = step.recentActivity?.slice(-3) ?? assignment.recentActivity;
    assignment.updatedAt = timestamp;
    changed = true;
  }
  if (changed) deriveTaskRunStatus(taskRun, timestamp);
  return changed;
}
