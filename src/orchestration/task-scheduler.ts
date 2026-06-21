// ──────────────────────────────────────────────
// Task scheduler: derive ready task assignments from plan state
// ──────────────────────────────────────────────

import type {
  AssignmentStatus,
  LaunchTaskEntry,
  PhaseRecord,
  PlanRecord,
  RunProgressSnapshot,
  TaskAssignmentRecord,
  TaskRecord,
} from "../types.js";

export interface SchedulerOptions {
  defaultAgent: string;
  defaultCwd: string;
  now?: number;
}

export interface SchedulerResult {
  assignments: TaskAssignmentRecord[];
  hasBlockingIssue: boolean;
}

function now(options?: { now?: number }): number {
  return options?.now ?? Date.now();
}

function taskById(plan: PlanRecord): Map<string, { phase: PhaseRecord; task: TaskRecord }> {
  const map = new Map<string, { phase: PhaseRecord; task: TaskRecord }>();
  for (const phase of plan.phases) {
    for (const task of phase.tasks) map.set(task.id, { phase, task });
  }
  return map;
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

function isActiveAssignmentStatus(status: AssignmentStatus): boolean {
  return status === "queued" || status === "running";
}

function latestAssignment(plan: PlanRecord, task: TaskRecord): TaskAssignmentRecord | undefined {
  for (let index = task.assignmentIds.length - 1; index >= 0; index -= 1) {
    const assignment = plan.assignments.find((candidate) => candidate.id === task.assignmentIds[index]);
    if (assignment) return assignment;
  }
  return undefined;
}

function dependencyIdsForTask(phase: PhaseRecord, task: TaskRecord): string[] {
  if (task.dependsOn.length > 0) return task.dependsOn;
  const index = phase.tasks.findIndex((candidate) => candidate.id === task.id);
  const maxConcurrency = phase.maxConcurrency ?? 1;
  if (maxConcurrency > 1 || index <= 0) return [];
  return [phase.tasks[index - 1].id];
}

function phaseDependenciesComplete(plan: PlanRecord, phase: PhaseRecord): boolean {
  return phase.dependsOn.every((depId) => plan.phases.find((candidate) => candidate.id === depId)?.status === "completed");
}

function phaseDependenciesBlocked(plan: PlanRecord, phase: PhaseRecord): boolean {
  return phase.dependsOn.some((depId) => {
    const dependency = plan.phases.find((candidate) => candidate.id === depId);
    return dependency ? isBlockingStatus(dependency.status) : true;
  });
}

function taskDependenciesComplete(plan: PlanRecord, phase: PhaseRecord, task: TaskRecord): boolean {
  const tasks = taskById(plan);
  return dependencyIdsForTask(phase, task).every((depId) => {
    const dependency = tasks.get(depId)?.task;
    return dependency ? dependency.status === "completed" : false;
  });
}

function taskDependenciesBlocked(plan: PlanRecord, phase: PhaseRecord, task: TaskRecord): boolean {
  const tasks = taskById(plan);
  return dependencyIdsForTask(phase, task).some((depId) => {
    const dependency = tasks.get(depId)?.task;
    return dependency ? isBlockingStatus(dependency.status) : true;
  });
}

function activeCountForPhase(plan: PlanRecord, phase: PhaseRecord): number {
  const ids = new Set(phase.tasks.flatMap((task) => task.assignmentIds));
  return plan.assignments.filter((assignment) => ids.has(assignment.id) && isActiveAssignmentStatus(assignment.status)).length;
}

function phaseCanDispatchReadyTasks(phase: PhaseRecord): boolean {
  return phase.status === "ready"
    || phase.status === "running"
    || (phase.status === "attention" && phase.tasks.some((task) => task.status === "ready"));
}

function buildAssignmentId(plan: PlanRecord, phase: PhaseRecord, task: TaskRecord): string {
  return `${plan.id}-${phase.id}-${task.id}-a${task.assignmentIds.length + 1}`;
}

export function buildTaskAssignmentPrompt(plan: PlanRecord, phase: PhaseRecord, task: TaskRecord): string {
  const upstreamOutputs = dependencyIdsForTask(phase, task)
    .map((taskId) => {
      const dependency = taskById(plan).get(taskId)?.task;
      const assignment = dependency ? latestAssignment(plan, dependency) : undefined;
      const summary = assignment?.result?.summary;
      return summary ? `Task ${taskId}: ${summary}` : undefined;
    })
    .filter((line): line is string => Boolean(line));

  return [
    "You are a subagent assigned one task by pi-tasked-subagents.",
    "Complete only this task. Report evidence for each criterion.",
    "Output ONLY valid JSON matching the SubagentTaskReport shape described below.",
    "",
    `Plan id: ${plan.id}`,
    `Plan title: ${plan.title}`,
    `Plan request: ${plan.request}`,
    `Plan spec: ${plan.spec}`,
    `Phase id: ${phase.id}`,
    `Phase title: ${phase.title}`,
    phase.goal ? `Phase goal: ${phase.goal}` : undefined,
    phase.brief ? `Phase brief: ${phase.brief}` : undefined,
    phase.filesHint?.length ? `Phase files: ${phase.filesHint.join(", ")}` : undefined,
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
      planId: plan.id,
      phaseId: phase.id,
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
    "- Use the exact planId, phaseId, taskId, and assignmentId provided by the launcher prompt.",
    "- criteriaEvidence must use zero-based criteriaIndex values from this task only.",
    "- Evidence must be concrete and non-empty.",
    "- Use status=attention when blocked or evidence is insufficient.",
    "- Use status=failed only for unrecoverable failure.",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function derivePlanStatus(plan: PlanRecord, timestamp = Date.now()): void {
  for (const phase of plan.phases) {
    if (phaseDependenciesBlocked(plan, phase)) phase.status = "blocked";
    else if ((phase.status === "pending" || phase.status === "blocked" || phase.status === "attention") && phaseDependenciesComplete(plan, phase)) phase.status = "ready";

    for (const task of phase.tasks) {
      const assignment = latestAssignment(plan, task);
      const hasContinuation = Boolean(task.continuation?.trim());
      if (!hasContinuation && taskComplete(task, assignment)) {
        task.status = "completed";
        task.completedAt ??= timestamp;
        continue;
      }
      if (!hasContinuation && assignment) {
        if (assignment.status === "completed" && !assignment.result && !taskCriteriaSatisfied(task)) {
          task.status = "running";
          continue;
        }
        if (assignment.status !== "completed") {
          if (assignment.status === "paused") task.status = "attention";
          else if (assignment.status === "skipped") task.status = "blocked";
          else task.status = assignment.status === "queued" ? "running" : assignment.status;
          continue;
        }
      }
      if (!hasContinuation && (task.status === "failed" || task.status === "attention" || task.status === "cancelled")) continue;
      if (taskDependenciesBlocked(plan, phase, task)) task.status = "blocked";
      else if (phase.status === "ready" || phase.status === "running") {
        task.status = taskDependenciesComplete(plan, phase, task) ? "ready" : "pending";
      }
    }

    const taskStatuses = phase.tasks.map((task) => task.status);
    if (taskStatuses.length > 0 && taskStatuses.every((status) => status === "completed")) {
      phase.status = "completed";
      phase.completedAt ??= timestamp;
    } else if (taskStatuses.some((status) => status === "failed")) phase.status = "failed";
    else if (taskStatuses.some((status) => status === "attention")) phase.status = "attention";
    else if (taskStatuses.some((status) => status === "cancelled")) phase.status = "cancelled";
    else if (taskStatuses.some((status) => status === "blocked")) phase.status = "blocked";
    else if (phase.status !== "blocked" && taskStatuses.some((status) => status === "running")) phase.status = "running";
    phase.updatedAt = timestamp;
  }

  const phaseStatuses = plan.phases.map((phase) => phase.status);
  if (phaseStatuses.length > 0 && phaseStatuses.every((status) => status === "completed")) {
    plan.status = "completed";
    plan.completedAt ??= timestamp;
  } else if (phaseStatuses.some((status) => status === "failed")) plan.status = "failed";
  else if (phaseStatuses.some((status) => status === "attention" || status === "blocked")) plan.status = "attention";
  else if (phaseStatuses.some((status) => status === "cancelled")) plan.status = "cancelled";
  else plan.status = "running";
  plan.updatedAt = timestamp;
}

export function createReadyAssignments(plan: PlanRecord, options: SchedulerOptions): SchedulerResult {
  const timestamp = now(options);
  derivePlanStatus(plan, timestamp);

  const created: TaskAssignmentRecord[] = [];
  for (const phase of plan.phases) {
    if (!phaseCanDispatchReadyTasks(phase)) continue;
    const maxConcurrency = phase.maxConcurrency ?? 1;
    let availableSlots = Math.max(0, maxConcurrency - activeCountForPhase(plan, phase));
    if (availableSlots <= 0) continue;

    for (const task of phase.tasks) {
      if (availableSlots <= 0) break;
      if (task.status !== "ready") continue;
      const activeAssignment = task.assignmentIds
        .map((assignmentId) => plan.assignments.find((assignment) => assignment.id === assignmentId))
        .some((assignment) => assignment && isActiveAssignmentStatus(assignment.status));
      if (activeAssignment) continue;

      const assignmentId = buildAssignmentId(plan, phase, task);
      const prompt = buildTaskAssignmentPrompt(plan, phase, task).replace("ASSIGNMENT_ID", assignmentId);
      const assignment: TaskAssignmentRecord = {
        id: assignmentId,
        planId: plan.id,
        phaseId: phase.id,
        taskId: task.id,
        agent: task.agentHint ?? phase.agentHint ?? options.defaultAgent,
        prompt,
        status: "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      task.assignmentIds.push(assignment.id);
      task.continuation = undefined;
      task.status = "running";
      task.updatedAt = timestamp;
      phase.status = "running";
      plan.assignments.push(assignment);
      created.push(assignment);
      availableSlots -= 1;
    }
  }

  plan.updatedAt = timestamp;
  return {
    assignments: created,
    hasBlockingIssue: plan.status === "attention" || plan.status === "failed" || plan.status === "cancelled",
  };
}

export function toLaunchTaskEntries(assignments: TaskAssignmentRecord[], plan: PlanRecord): LaunchTaskEntry[] {
  const assignmentIdsInLaunch = new Set(assignments.map((assignment) => assignment.id));
  const latestAssignmentIdByTaskId = new Map<string, string>();
  for (const assignment of plan.assignments) latestAssignmentIdByTaskId.set(assignment.taskId, assignment.id);

  return assignments.map((assignment) => {
    const phase = plan.phases.find((candidate) => candidate.id === assignment.phaseId);
    const task = phase?.tasks.find((candidate) => candidate.id === assignment.taskId);
    const dependsOn = task?.dependsOn
      .map((taskId) => latestAssignmentIdByTaskId.get(taskId))
      .filter((assignmentId): assignmentId is string => typeof assignmentId === "string" && assignmentIdsInLaunch.has(assignmentId));
    return {
      assignmentId: assignment.id,
      phaseId: assignment.phaseId,
      taskId: assignment.taskId,
      agent: assignment.agent,
      prompt: assignment.prompt,
      taskSummary: task?.text ?? assignment.taskId,
      dependsOn: dependsOn && dependsOn.length > 0 ? dependsOn : undefined,
      retries: task?.retries,
      outputMode: "json",
      outputSchema: "SubagentTaskReport JSON object",
      when: task?.when,
      cwd: task?.cwd,
    };
  });
}

export function applyAssignmentProgress(plan: PlanRecord, snapshot: RunProgressSnapshot, timestamp = Date.now()): boolean {
  let changed = false;
  for (const step of snapshot.steps) {
    if (!step.id) continue;
    const assignment = plan.assignments.find((candidate) => candidate.id === step.id);
    if (!assignment) continue;
    if (step.status === "running") assignment.status = "running";
    else if (step.status === "completed") assignment.status = "completed";
    else if (step.status === "failed") assignment.status = "failed";
    else if (step.status === "skipped") assignment.status = "skipped";
    else if (step.status === "cancelled") assignment.status = "cancelled";
    assignment.currentTool = step.currentTool;
    assignment.lastActionAt = step.lastActionAt ?? assignment.lastActionAt;
    assignment.lastActionSummary = step.lastActionSummary ?? assignment.lastActionSummary;
    assignment.recentActivity = step.recentActivity?.slice(-3) ?? assignment.recentActivity;
    assignment.updatedAt = timestamp;
    changed = true;
  }
  if (changed) derivePlanStatus(plan, timestamp);
  return changed;
}
