// ──────────────────────────────────────────────
// Command parsing and formatting for plan-first tasked subagents
// ──────────────────────────────────────────────

import type { AgentProfile } from "../launcher/agent-profiles.js";
import type { PlanRecord, TaskAssignmentRecord, TaskedSubagentsState } from "../types.js";
import { statusLabel } from "../ui/messages.js";
import { shortTitle } from "../utils/text.js";

export type CommandAction =
  | "help"
  | "status"
  | "inspect"
  | "result"
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

function findPlan(state: TaskedSubagentsState, id: string): PlanRecord | undefined {
  return state.plans.find((plan) => plan.id === id);
}

function findPhase(state: TaskedSubagentsState, id: string) {
  for (const plan of state.plans) {
    const phase = plan.phases.find((candidate) => candidate.id === id);
    if (phase) return { plan, phase };
  }
  return undefined;
}

function findTask(state: TaskedSubagentsState, id: string) {
  for (const plan of state.plans) {
    for (const phase of plan.phases) {
      const task = phase.tasks.find((candidate) => candidate.id === id);
      if (task) return { plan, phase, task };
    }
  }
  return undefined;
}

function findAssignment(state: TaskedSubagentsState, id: string): { plan: PlanRecord; assignment: TaskAssignmentRecord } | undefined {
  for (const plan of state.plans) {
    const assignment = plan.assignments.find((candidate) => candidate.id === id);
    if (assignment) return { plan, assignment };
  }
  return undefined;
}

export function formatStatusReport(state: TaskedSubagentsState, targetId?: string): string {
  if (state.plans.length === 0) return "No tracked plans.";
  if (targetId) {
    const plan = findPlan(state, targetId);
    if (plan) return formatPlanStatus(plan);
    const phase = findPhase(state, targetId);
    if (phase) return formatPhaseStatus(phase.plan, phase.phase);
    const task = findTask(state, targetId);
    if (task) return formatTaskStatus(task.plan, task.phase, task.task);
    const assignment = findAssignment(state, targetId);
    if (assignment) return formatAssignmentDetail(assignment.plan, assignment.assignment);
    return `Not found: ${targetId}. Use a valid plan, phase, task, or assignment id.`;
  }

  const active = state.plans.filter((plan) => plan.status === "pending" || plan.status === "running").length;
  const attention = state.plans.filter((plan) => plan.status === "attention" || plan.status === "failed").length;
  const completed = state.plans.filter((plan) => plan.status === "completed").length;
  const lines = [`Plans: ${state.plans.length} total`];
  if (active) lines.push(`  Active: ${active}`);
  if (attention) lines.push(`  Attention: ${attention}`);
  if (completed) lines.push(`  Completed: ${completed}`);
  lines.push("");
  for (const plan of state.plans) lines.push(...formatPlanStatusLines(plan), "");
  return lines.join("\n").trimEnd();
}

function formatPlanStatusLines(plan: PlanRecord): string[] {
  const tasks = plan.phases.flatMap((phase) => phase.tasks);
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const runningAssignments = plan.assignments.filter((assignment) => assignment.status === "running" || assignment.status === "queued").length;
  const attentionTasks = tasks.filter((task) => task.status === "attention" || task.status === "failed" || task.status === "blocked").length;
  return [
    `${plan.id} · ${statusLabel(plan.status)} · ${plan.title}`,
    `  request: ${shortTitle(plan.request, 80)}`,
    `  phases: ${plan.phases.length}`,
    `  tasks: ${completedTasks}/${tasks.length} completed`,
    runningAssignments ? `  assignments: ${runningAssignments} active` : undefined,
    attentionTasks ? `  attention tasks: ${attentionTasks}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function formatPlanStatus(plan: PlanRecord): string {
  return formatPlanStatusLines(plan).join("\n");
}

function formatPhaseStatus(plan: PlanRecord, phase: PlanRecord["phases"][number]): string {
  const done = phase.tasks.filter((task) => task.status === "completed").length;
  return [`${phase.id} · ${statusLabel(phase.status)} · ${phase.title}`, `  plan: ${plan.id} · ${plan.title}`, `  tasks: ${done}/${phase.tasks.length} completed`].join("\n");
}

function formatTaskStatus(plan: PlanRecord, phase: PlanRecord["phases"][number], task: PlanRecord["phases"][number]["tasks"][number]): string {
  const evidence = task.criteria.filter((criterion) => criterion.satisfied).length;
  return [`${task.id} · ${statusLabel(task.status)} · ${task.text}`, `  plan: ${plan.id}`, `  phase: ${phase.id} · ${phase.title}`, `  criteria: ${evidence}/${task.criteria.length} satisfied`].join("\n");
}

export function formatInspectReport(state: TaskedSubagentsState, targetId: string): string {
  const plan = findPlan(state, targetId);
  if (plan) return formatPlanDetail(plan);
  const phase = findPhase(state, targetId);
  if (phase) return formatPhaseDetail(phase.plan, phase.phase);
  const task = findTask(state, targetId);
  if (task) return formatTaskDetail(task.plan, task.phase, task.task);
  const assignment = findAssignment(state, targetId);
  if (assignment) return formatAssignmentDetail(assignment.plan, assignment.assignment);
  return `Not found: ${targetId}. Use a valid plan, phase, task, or assignment id.`;
}

function formatPlanDetail(plan: PlanRecord): string {
  const lines = [`Plan: ${plan.id}`, `  title: ${plan.title}`, `  status: ${statusLabel(plan.status)}`, `  request: ${plan.request}`, `  spec: ${plan.spec}`, "", `Phases (${plan.phases.length}):`];
  for (const phase of plan.phases) lines.push(`  ${phase.id} · ${statusLabel(phase.status)} · ${phase.title}`);
  if (plan.assignments.length > 0) lines.push("", `Assignments: ${plan.assignments.length}`);
  if (plan.artifacts.length > 0) lines.push(`Artifacts: ${plan.artifacts.length}`);
  return lines.join("\n");
}

function formatPhaseDetail(plan: PlanRecord, phase: PlanRecord["phases"][number]): string {
  const lines = [`Phase: ${phase.id}`, `  title: ${phase.title}`, `  status: ${statusLabel(phase.status)}`, `  plan: ${plan.id} · ${plan.title}`];
  if (phase.goal) lines.push(`  goal: ${phase.goal}`);
  if (phase.dependsOn.length) lines.push(`  depends on: ${phase.dependsOn.join(", ")}`);
  lines.push("", `Tasks (${phase.tasks.length}):`);
  for (const task of phase.tasks) lines.push(`  ${task.id} · ${statusLabel(task.status)} · ${task.text}`);
  return lines.join("\n");
}

function formatTaskDetail(plan: PlanRecord, phase: PlanRecord["phases"][number], task: PlanRecord["phases"][number]["tasks"][number]): string {
  const lines = [`Task: ${task.id}`, `  text: ${task.text}`, `  status: ${statusLabel(task.status)}`, `  plan: ${plan.id}`, `  phase: ${phase.id} · ${phase.title}`, "", "Criteria:"];
  for (const criterion of task.criteria) {
    lines.push(`  ${criterion.satisfied ? "✓" : "·"} ${criterion.text}`);
    for (const evidence of criterion.evidence) lines.push(`    evidence: ${shortTitle(evidence.summary, 120)} (${evidence.assignmentId})`);
  }
  if (task.assignmentIds.length > 0) lines.push("", `Assignments: ${task.assignmentIds.join(", ")}`);
  return lines.join("\n");
}

function formatAssignmentDetail(plan: PlanRecord, assignment: TaskAssignmentRecord): string {
  const lines = [`Assignment: ${assignment.id}`, `  status: ${statusLabel(assignment.status)}`, `  plan: ${plan.id} · ${plan.title}`, `  phase: ${assignment.phaseId}`, `  task: ${assignment.taskId}`, `  agent: ${assignment.agent}`];
  if (assignment.result?.summary) lines.push(`  result: ${assignment.result.summary}`);
  if (assignment.launchRef?.resultPath) lines.push(`  result path: ${assignment.launchRef.resultPath}`);
  return lines.join("\n");
}

export function formatResultReport(state: TaskedSubagentsState, assignmentId: string): string {
  const assignment = findAssignment(state, assignmentId);
  if (!assignment) return `Assignment not found: ${assignmentId}. Use /tasked-subagents status to list active assignments.`;
  return formatAssignmentDetail(assignment.plan, assignment.assignment);
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
  return count > 0 ? `Cleared ${count} plan(s).` : "Nothing to clear.";
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
    "Use with replace_plan: assign an agentHint to a concrete task inside a phase.",
  ];
  return lines.join("\n");
}

export function formatDispatchReport(args?: Record<string, unknown>, result?: string): string {
  const lines = ["[INTERNAL DISPATCH]", "Schedules ready task assignments for the current plan."];
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
    "  /tasked-subagents status [planId|phaseId|taskId|assignmentId]",
    "  /tasked-subagents inspect <planId|phaseId|taskId|assignmentId>",
    "  /tasked-subagents result <assignmentId>",
    "  /tasked-subagents dispatch",
    "  /tasked-subagents stop <assignmentId>",
    "  /tasked-subagents continue <taskId|assignmentId|phaseId> <prompt>",
    "  /tasked-subagents resolve <taskId|assignmentId|phaseId|planId> <fix-summary>",
    "  /tasked-subagents cancel <assignmentId>",
    "  /tasked-subagents clear [completed|all]",
    "  /tasked-subagents agents [--details]",
    "",
    "Tool usage:",
    "  tasked_subagents action=replace_plan spec=<spec> phases=<phases>",
    "  tasked_subagents action=edit_plan targetId=<phaseId|taskId> phase=<patch> task=<patch>",
    "  tasked_subagents action=dispatch [planId=<planId>]",
    "  tasked_subagents action=status [targetId=<id>]",
    "  tasked_subagents action=inspect targetId=<id>",
    "  tasked_subagents action=result assignmentId=<assignmentId>",
    "  tasked_subagents action=continue targetId=<taskId|assignmentId|phaseId> prompt=<prompt>",
    "  tasked_subagents action=resolve targetId=<taskId|assignmentId|phaseId|planId> prompt=<fix-summary>",
    "  tasked_subagents action=stop assignmentId=<assignmentId>",
    "  tasked_subagents action=cancel assignmentId=<assignmentId>",
    "  tasked_subagents action=list_agents [details=true]",
    "",
    "Model:",
    "  Plans contain phases; phases contain tasks; every subagent assignment executes exactly one task.",
    "  One-off work is a one-phase, one-task plan.",
  ].join("\n");
}
