// ──────────────────────────────────────────────
// Command parsing and formatting for tasked subagent task runs
// ──────────────────────────────────────────────

import type { AgentProfile } from "../launcher/agent-profiles.js";
import type { TaskAssignmentRecord, TaskGroupRecord, TaskRecord, TaskRunRecord, TaskedSubagentsState } from "../types.js";
import { assignmentsForTask, authoritativeAssignment, authoritativeAssignments, isSupersededAssignment } from "./assignment-attempts.js";
import { statusLabel } from "../ui/messages.js";
import { buildTaskRunChecklistLines } from "../ui/widget.js";
import { shortTitle } from "../utils/text.js";

export type CommandAction =
  | "help"
  | "status"
  | "inspect"
  | "result"
  | "attach"
  | "stop"
  | "continue"
  | "resolve"
  | "cancel"
  | "clear"
  | "agents"
  | "dispatch";

export interface ParsedCommand {
  action: CommandAction;
  targetId?: string;
  assignmentId?: string;
  prompt?: string;
  details?: boolean;
  scope?: "completed" | "all";
  args?: Record<string, unknown>;
}

export interface ParsedDispatchArgs {
  taskRunId?: string;
  maxConcurrency?: number;
  wait?: boolean;
  errors: string[];
}

const DISPATCH_ARG_KEYS = new Set(["taskRunId", "maxConcurrency", "wait"]);

export function parseDispatchArgs(args?: Record<string, unknown>): ParsedDispatchArgs {
  const result: ParsedDispatchArgs = { errors: [] };
  if (!args) return result;

  for (const [key, value] of Object.entries(args)) {
    if (!DISPATCH_ARG_KEYS.has(key)) {
      result.errors.push(`Unsupported dispatch argument: ${key}`);
      continue;
    }

    if (key === "taskRunId") {
      if (typeof value === "string" && value.trim()) result.taskRunId = value.trim();
      else result.errors.push("dispatch taskRunId must be a non-empty string");
      continue;
    }

    if (key === "wait") {
      if (value === true || value === "true") result.wait = true;
      else if (value === false || value === "false") result.wait = false;
      else result.errors.push("dispatch wait must be true or false");
      continue;
    }

    if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value.trim())) {
      result.errors.push("dispatch maxConcurrency must be a positive integer");
      continue;
    }
    const parsed = Number(value.trim());
    if (!Number.isSafeInteger(parsed)) {
      result.errors.push("dispatch maxConcurrency must be a positive integer");
      continue;
    }
    result.maxConcurrency = parsed;
  }

  return result;
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) args.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}

export function parseCommand(input: string, internal = false): ParsedCommand {
  const tokens = splitArgs(input);
  const action = tokens[0]?.toLowerCase();
  if (!action) return { action: "help" };

  if (action === "dispatch" || internal) {
    const argsTokens = internal ? tokens : tokens.slice(1);
    const args: Record<string, unknown> = {};
    for (const token of argsTokens) {
      const index = token.indexOf("=");
      if (index > 0) args[token.slice(0, index)] = token.slice(index + 1);
      else if (token) args[token] = true;
    }
    return { action: "dispatch", args: Object.keys(args).length > 0 ? args : undefined };
  }

  switch (action) {
    case "help":
      return { action: "help" };
    case "status":
      return tokens[1] ? { action: "status", targetId: tokens[1] } : { action: "status" };
    case "inspect":
      return tokens[1] ? { action: "inspect", targetId: tokens[1] } : { action: "help" };
    case "result":
    case "stop":
    case "cancel":
      return tokens[1] ? { action, assignmentId: tokens[1] } : { action: "help" };
    case "attach":
      return tokens[1] ? { action: "attach", targetId: tokens[1] } : { action: "attach" };
    case "continue":
    case "resolve": {
      const targetId = tokens[1];
      const prompt = tokens.slice(2).join(" ").trim();
      return targetId && prompt ? { action, targetId, prompt } : { action: "help" };
    }
    case "clear": {
      const scope = tokens[1]?.toLowerCase();
      if (!scope || scope === "completed") return { action: "clear", scope: "completed" };
      if (scope === "all") return { action: "clear", scope: "all" };
      return { action: "help" };
    }
    case "agents":
    case "list-agents":
    case "list_agents": {
      const rest = tokens.slice(1);
      return rest.every((token) => token === "--details") ? { action: "agents", details: rest.includes("--details") } : { action: "help" };
    }
    default:
      return { action: "help" };
  }
}

function orderedTaskRuns(state: TaskedSubagentsState): TaskRunRecord[] {
  const current = state.currentTaskRunId ? state.taskRuns.find((taskRun) => taskRun.id === state.currentTaskRunId) : undefined;
  return current ? [current, ...state.taskRuns.filter((taskRun) => taskRun.id !== current.id)] : state.taskRuns;
}

function findTaskRun(state: TaskedSubagentsState, id: string): TaskRunRecord | undefined {
  return state.taskRuns.find((taskRun) => taskRun.id === id);
}

function findGroup(state: TaskedSubagentsState, id: string): { taskRun: TaskRunRecord; group: TaskGroupRecord } | undefined {
  for (const taskRun of orderedTaskRuns(state)) {
    const group = taskRun.groups.find((candidate) => candidate.id === id);
    if (group) return { taskRun, group };
  }
  return undefined;
}

function findTask(state: TaskedSubagentsState, id: string): { taskRun: TaskRunRecord; group?: TaskGroupRecord; task: TaskRecord } | undefined {
  for (const taskRun of orderedTaskRuns(state)) {
    const task = taskRun.tasks.find((candidate) => candidate.id === id);
    if (!task) continue;
    const group = task.groupId ? taskRun.groups.find((candidate) => candidate.id === task.groupId) : undefined;
    return { taskRun, group, task };
  }
  return undefined;
}

function findAssignment(state: TaskedSubagentsState, id: string): { taskRun: TaskRunRecord; assignment: TaskAssignmentRecord } | undefined {
  for (const taskRun of orderedTaskRuns(state)) {
    const assignment = taskRun.assignments.find((candidate) => candidate.id === id);
    if (assignment) return { taskRun, assignment };
  }
  return undefined;
}

function assignmentSummaryLine(taskRun: TaskRunRecord, assignment: TaskAssignmentRecord): string {
  const task = taskRun.tasks.find((candidate) => candidate.id === assignment.taskId);
  const summary = assignment.result?.summary ? ` · ${shortTitle(assignment.result.summary, 80)}` : "";
  return `${assignment.id} · ${statusLabel(assignment.status)} · ${assignment.taskId}${task?.text ? ` · ${shortTitle(task.text, 80)}` : ""}${summary}`;
}

function taskAssignmentSummary(taskRun: TaskRunRecord, task: TaskRecord): string {
  const assignment = authoritativeAssignment(taskRun, task);
  const historicalCount = assignmentsForTask(taskRun, task).filter(isSupersededAssignment).length;
  if (!assignment) return "no assignment";
  return historicalCount > 0
    ? `${assignment.id} · ${historicalCount} historical ${historicalCount === 1 ? "attempt" : "attempts"}`
    : assignment.id;
}

function assignmentsForTarget(state: TaskedSubagentsState, targetId: string): TaskAssignmentRecord[] | undefined {
  const assignment = findAssignment(state, targetId);
  if (assignment) return [assignment.assignment];
  const task = findTask(state, targetId);
  if (task) {
    const authoritative = authoritativeAssignment(task.taskRun, task.task);
    return authoritative ? [authoritative] : [];
  }
  const group = findGroup(state, targetId);
  if (group) {
    return group.taskRun.tasks
      .filter((taskRecord) => taskRecord.groupId === group.group.id)
      .map((taskRecord) => authoritativeAssignment(group.taskRun, taskRecord))
      .filter((candidate): candidate is TaskAssignmentRecord => Boolean(candidate));
  }
  const taskRun = findTaskRun(state, targetId);
  if (taskRun) return authoritativeAssignments(taskRun);
  return undefined;
}

export function resolveResultAssignmentId(state: TaskedSubagentsState, targetId: string): string | undefined {
  const assignments = assignmentsForTarget(state, targetId);
  return assignments?.length === 1 ? assignments[0].id : undefined;
}

export function formatStatusReport(state: TaskedSubagentsState, targetId?: string): string {
  if (state.taskRuns.length === 0) return "No tracked task runs.";
  if (targetId) {
    const taskRun = findTaskRun(state, targetId);
    if (taskRun) return formatTaskRunStatus(taskRun);
    const group = findGroup(state, targetId);
    if (group) return formatGroupStatus(group.taskRun, group.group);
    const task = findTask(state, targetId);
    if (task) return formatTaskStatus(task.taskRun, task.group, task.task);
    const assignment = findAssignment(state, targetId);
    if (assignment) return formatAssignmentDetail(assignment.taskRun, assignment.assignment);
    return `Not found: ${targetId}. Use a valid taskRun, group, task, or assignment id.`;
  }

  const active = state.taskRuns.filter((taskRun) => taskRun.status === "pending" || taskRun.status === "running").length;
  const attention = state.taskRuns.filter((taskRun) => taskRun.status === "attention" || taskRun.status === "failed").length;
  const completed = state.taskRuns.filter((taskRun) => taskRun.status === "completed").length;
  const lines = [`Task runs: ${state.taskRuns.length} total`];
  if (active) lines.push(`  Active: ${active}`);
  if (attention) lines.push(`  Attention: ${attention}`);
  if (completed) lines.push(`  Completed: ${completed}`);
  lines.push("");
  for (const taskRun of state.taskRuns) lines.push(...formatTaskRunStatusLines(taskRun), "");
  return lines.join("\n").trimEnd();
}

function formatTaskRunStatusLines(taskRun: TaskRunRecord): string[] {
  const completedTasks = taskRun.tasks.filter((task) => task.status === "completed").length;
  const runningAssignments = taskRun.assignments.filter((assignment) => !isSupersededAssignment(assignment) && (assignment.status === "running" || assignment.status === "queued")).length;
  const attentionTasks = taskRun.tasks.filter((task) => task.status === "attention" || task.status === "failed" || task.status === "blocked").length;
  return [
    `${taskRun.id} · ${statusLabel(taskRun.status)} · ${taskRun.title}`,
    `  request: ${shortTitle(taskRun.request, 80)}`,
    `  groups: ${taskRun.groups.length}`,
    `  tasks: ${completedTasks}/${taskRun.tasks.length} completed`,
    runningAssignments ? `  assignments: ${runningAssignments} active` : undefined,
    attentionTasks ? `  attention tasks: ${attentionTasks}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function formatTaskRunStatus(taskRun: TaskRunRecord): string {
  return formatTaskRunStatusLines(taskRun).join("\n");
}

function formatGroupStatus(taskRun: TaskRunRecord, group: TaskGroupRecord): string {
  const groupTasks = taskRun.tasks.filter((task) => task.groupId === group.id);
  const done = groupTasks.filter((task) => task.status === "completed").length;
  return [`Group: ${group.id} · ${statusLabel(group.status)} · ${group.title}`, `  taskRun: ${taskRun.id} · ${taskRun.title}`, `  tasks: ${done}/${groupTasks.length} completed`].join("\n");
}

function formatTaskStatus(taskRun: TaskRunRecord, group: TaskGroupRecord | undefined, task: TaskRecord): string {
  const evidence = task.criteria.filter((criterion) => criterion.satisfied).length;
  return [`${task.id} · ${statusLabel(task.status)} · ${task.text}`, `  taskRun: ${taskRun.id}`, group ? `  group: ${group.id} · ${group.title}` : undefined, `  criteria: ${evidence}/${task.criteria.length} satisfied`]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function formatInspectReport(state: TaskedSubagentsState, targetId: string): string {
  const taskRun = findTaskRun(state, targetId);
  if (taskRun) return formatTaskRunDetail(taskRun);
  const group = findGroup(state, targetId);
  if (group) return formatGroupDetail(group.taskRun, group.group);
  const task = findTask(state, targetId);
  if (task) return formatTaskDetail(task.taskRun, task.group, task.task);
  const assignment = findAssignment(state, targetId);
  if (assignment) return formatAssignmentDetail(assignment.taskRun, assignment.assignment);
  return `Not found: ${targetId}. Use a valid taskRun, group, task, or assignment id.`;
}

function formatTaskRunDetail(taskRun: TaskRunRecord): string {
  const lines = [`TaskRun: ${taskRun.id}`, `  title: ${taskRun.title}`, `  status: ${statusLabel(taskRun.status)}`, `  request: ${taskRun.request}`, `  context: ${taskRun.context}`, "", "Checklist:"];
  lines.push(...buildTaskRunChecklistLines(taskRun, 200).map((line) => `  ${line}`));
  lines.push("", `Groups (${taskRun.groups.length}):`);
  for (const group of taskRun.groups) lines.push(`  ${group.id} · ${statusLabel(group.status)} · ${group.title}`);
  lines.push("", `Tasks (${taskRun.tasks.length}):`);
  for (const task of taskRun.tasks) lines.push(`  ${task.id} · ${statusLabel(task.status)} · ${taskAssignmentSummary(taskRun, task)} · ${task.text}`);
  const currentAssignments = authoritativeAssignments(taskRun);
  const historicalCount = taskRun.assignments.filter(isSupersededAssignment).length;
  if (currentAssignments.length > 0) {
    lines.push("", `Assignments (${currentAssignments.length} current):`);
    for (const assignment of currentAssignments) lines.push(`  ${assignmentSummaryLine(taskRun, assignment)}`);
  }
  if (historicalCount > 0) lines.push(`  ${historicalCount} historical ${historicalCount === 1 ? "attempt" : "attempts"}`);
  if (taskRun.artifacts.length > 0) lines.push(`Artifacts: ${taskRun.artifacts.length}`);
  return lines.join("\n");
}

function formatGroupDetail(taskRun: TaskRunRecord, group: TaskGroupRecord): string {
  const groupTasks = taskRun.tasks.filter((task) => task.groupId === group.id);
  const lines = [`Group: ${group.id}`, `  title: ${group.title}`, `  status: ${statusLabel(group.status)}`, `  taskRun: ${taskRun.id} · ${taskRun.title}`];
  if (group.dependsOn.length) lines.push(`  depends on: ${group.dependsOn.join(", ")}`);
  lines.push("", `Tasks (${groupTasks.length}):`);
  for (const task of groupTasks) lines.push(`  ${task.id} · ${statusLabel(task.status)} · ${taskAssignmentSummary(taskRun, task)} · ${task.text}`);
  const taskAssignments = groupTasks.flatMap((task) => assignmentsForTask(taskRun, task));
  const assignments = groupTasks
    .map((task) => authoritativeAssignment(taskRun, task))
    .filter((assignment): assignment is TaskAssignmentRecord => Boolean(assignment));
  const historicalCount = taskAssignments.filter(isSupersededAssignment).length;
  if (assignments.length > 0) {
    lines.push("", `Assignments (${assignments.length} current):`);
    for (const assignment of assignments) lines.push(`  ${assignmentSummaryLine(taskRun, assignment)}`);
  }
  if (historicalCount > 0) lines.push(`  ${historicalCount} historical ${historicalCount === 1 ? "attempt" : "attempts"}`);
  return lines.join("\n");
}

function formatTaskDetail(taskRun: TaskRunRecord, group: TaskGroupRecord | undefined, task: TaskRecord): string {
  const lines = [`Task: ${task.id}`, `  text: ${task.text}`, `  status: ${statusLabel(task.status)}`, `  taskRun: ${taskRun.id}`];
  if (group) lines.push(`  group: ${group.id} · ${group.title}`);
  lines.push("", "Criteria:");
  for (const criterion of task.criteria) {
    lines.push(`  ${criterion.satisfied ? "✓" : "·"} ${criterion.text}`);
    for (const evidence of criterion.evidence) lines.push(`    evidence: ${shortTitle(evidence.summary, 120)} (${evidence.assignmentId})`);
  }
  if (task.assignmentIds.length > 0) lines.push("", `Assignments: ${task.assignmentIds.join(", ")}`);
  return lines.join("\n");
}

function formatAssignmentDetail(taskRun: TaskRunRecord, assignment: TaskAssignmentRecord): string {
  const lines = [`Assignment: ${assignment.id}`, `  status: ${statusLabel(assignment.status)}`, assignment.supersededByAssignmentId ? `  historical: superseded by ${assignment.supersededByAssignmentId}` : undefined, `  taskRun: ${taskRun.id} · ${taskRun.title}`, assignment.groupId ? `  group: ${assignment.groupId}` : undefined, `  task: ${assignment.taskId}`, `  agent: ${assignment.agent}`]
    .filter((line): line is string => Boolean(line));
  if (assignment.result?.summary) lines.push(`  result: ${assignment.result.summary}`);
  if (assignment.result?.followUps.length) {
    lines.push("", "Follow-ups:");
    for (const followUp of assignment.result.followUps) lines.push(`- ${followUp}`);
  }
  if (assignment.launchRef?.resultPath) lines.push(`  result path: ${assignment.launchRef.resultPath}`);
  return lines.join("\n");
}

export function formatResultReport(state: TaskedSubagentsState, targetId: string): string {
  const assignments = assignmentsForTarget(state, targetId);
  if (!assignments) return `Result target not found: ${targetId}. Use /tasked-subagents status to list active assignments.`;
  if (assignments.length === 0) return `No assignments for result target: ${targetId}. Use /tasked-subagents inspect ${targetId} for details.`;
  if (assignments.length === 1) {
    const assignment = findAssignment(state, assignments[0].id);
    return assignment ? formatAssignmentDetail(assignment.taskRun, assignment.assignment) : `Assignment not found: ${targetId}.`;
  }
  return [
    `Ambiguous result target: ${targetId}. Use /tasked-subagents result <assignmentId>.`,
    "Assignments:",
    ...assignments.map((assignment) => {
      const taskRun = state.taskRuns.find((candidate) => candidate.id === assignment.taskRunId);
      return `  ${taskRun ? assignmentSummaryLine(taskRun, assignment) : assignment.id}`;
    }),
  ].join("\n");
}

export function formatAttachReport(state: TaskedSubagentsState, targetId?: string): string {
  const target = targetId ?? state.currentTaskRunId ?? state.taskRuns.at(-1)?.id;
  if (!target) return "No tracked task runs.";

  const assignments = assignmentsForTarget(state, target);
  if (!assignments) return `Attach target not found: ${target}.`;

  const lines = [`Attached to ${target}.`, "", formatStatusReport(state, target)];
  if (assignments.length === 0) {
    lines.push("", `No assignments for attach target: ${target}. Use /tasked-subagents inspect ${target} for details.`);
    return lines.join("\n");
  }

  lines.push("", assignments.length === 1 ? "Result:" : "Results:");
  for (const assignment of assignments) {
    const found = findAssignment(state, assignment.id);
    lines.push(found ? formatAssignmentDetail(found.taskRun, found.assignment) : `Assignment not found: ${assignment.id}.`, "");
  }
  return lines.join("\n").trimEnd();
}

export function formatContinueAcknowledgement(targetId: string, prompt: string): string {
  return `Continued ${targetId} with: ${shortTitle(prompt)}`;
}

export function formatResolveAcknowledgement(targetId: string, prompt: string): string {
  return `Resolving ${targetId}; verification assignment is running in the background: ${shortTitle(prompt)}. Do not poll; wait for the completion/attention follow-up signal.`;
}

export function formatStopAcknowledgement(assignmentId: string): string {
  return `Stopped ${assignmentId}. Use /tasked-subagents continue <taskId|assignmentId> <prompt> to resume with task-level instructions.`;
}

export function formatCancelAcknowledgement(assignmentId: string): string {
  return `Cancelled ${assignmentId}.`;
}

export function formatClearAcknowledgement(count: number): string {
  return count > 0 ? `Cleared ${count} task run(s).` : "Nothing to clear.";
}

export function formatAgentsReport(profiles: AgentProfile[], options: { details?: boolean } = {}): string {
  if (profiles.length === 0) return "No subagent profiles are available.";
  const lines = [
    "Available subagent profiles:",
    ...profiles.map((profile) => {
      if (!options.details) return `  - ${profile.name}`;
      const metadata = [
        profile.model ? `model=${profile.model}` : undefined,
        profile.thinking ? `thinking=${profile.thinking}` : undefined,
        profile.tools.length > 0 ? `tools=${profile.tools.join(",")}` : undefined,
      ].filter(Boolean).join(" ");
      return metadata ? `  - ${profile.name} ${metadata}` : `  - ${profile.name}`;
    }),
    "",
    options.details ? "Details omit system prompts." : "Names only by default. Use details=true or --details for non-sensitive metadata.",
    "",
    "Use with set_tasks or edit_task: assign an agentHint to a concrete task.",
  ];
  return lines.join("\n");
}

export function formatDispatchReport(args?: Record<string, unknown>, result?: string): string {
  const lines = ["[INTERNAL DISPATCH]", "Schedules ready task assignments for the current task run."];
  if (args && Object.keys(args).length > 0) {
    lines.push("Dispatch arguments:");
    for (const [key, value] of Object.entries(args)) lines.push(`  ${key}: ${String(value)}`);
  }
  if (result) lines.push("", `Result: ${result}`);
  return lines.join("\n");
}

export function buildHelpText(): string {
  return [
    "Slash command usage:",
    "  /tasked-subagents help",
    "  /tasked-subagents status [taskRunId|groupId|taskId|assignmentId]",
    "  /tasked-subagents inspect <taskRunId|groupId|taskId|assignmentId>",
    "  /tasked-subagents result <taskRunId|groupId|taskId|assignmentId>  (taskRun/group/task must resolve to one assignment)",
    "  /tasked-subagents attach [taskRunId|groupId|taskId|assignmentId]",
    "  /tasked-subagents dispatch [taskRunId=<taskRunId>] [maxConcurrency=<n>] [wait=true|false]", 
    "  /tasked-subagents stop <assignmentId>",
    "  /tasked-subagents continue <taskId|assignmentId|groupId> <prompt>",
    "  /tasked-subagents resolve <taskId|assignmentId|groupId|taskRunId> <fix-summary>",
    "  /tasked-subagents cancel <assignmentId>",
    "  /tasked-subagents clear [completed|all]",
    "  /tasked-subagents agents [--details]",
    "",
    "Tool usage:",
    "  tasked_subagents action=set_tasks context=<context> tasks=<tasks> [groups=<groups>]",
    "  tasked_subagents action=edit_task taskRunId=<taskRunId> targetId=<taskId> task=<patch>",
    "  tasked_subagents action=edit_group taskRunId=<taskRunId> targetId=<groupId> group=<patch>",
    "  tasked_subagents action=patch_task_run taskRunId=<taskRunId> [groups=<groups>] [tasks=<tasks>] [wait=true]",
    "  tasked_subagents action=dispatch [taskRunId=<taskRunId>] [maxConcurrency=<n>] [wait=true]", 
    "  tasked_subagents action=status [targetId=<id>]",
    "  tasked_subagents action=inspect targetId=<id>",
    "  tasked_subagents action=result assignmentId=<assignmentId>",
    "  tasked_subagents action=attach [targetId=<taskRunId|groupId|taskId|assignmentId>]",
    "  Add wait=true to set_tasks/patch_task_run/edit_task/edit_group/dispatch when the main agent should remain locked until launched work finishes.",
    "  tasked_subagents action=continue targetId=<taskId|assignmentId|groupId> prompt=<prompt>",
    "  tasked_subagents action=resolve targetId=<taskId|assignmentId|groupId|taskRunId> prompt=<fix-summary>",
    "  tasked_subagents action=stop assignmentId=<assignmentId>",
    "  tasked_subagents action=cancel assignmentId=<assignmentId>",
    "  tasked_subagents action=list_agents [details=true]",
    "",
    "Model:",
    "  Task runs contain groups and tasks; every subagent assignment executes exactly one task.",
    "  One-off work is a one-task task run.",
    "  Use patch_task_run to append newly discovered tasks to the same visible TaskRun without replacing completed task history.",
  ].join("\n");
}
