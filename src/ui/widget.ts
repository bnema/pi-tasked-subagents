// ──────────────────────────────────────────────
// Plan/phase/task/assignment widget rendering
// ──────────────────────────────────────────────

import { truncateToWidth } from "@earendil-works/pi-tui";

import { DEFAULT_WIDGET_LINES } from "../defaults.js";
import type { PhaseRecord, PlanRecord, TaskAssignmentRecord, TaskRecord, TaskedSubagentsState } from "../types.js";
import { shortTitle } from "../utils/text.js";
import {
  GLYPH_ATTENTION,
  GLYPH_DONE,
  GLYPH_FAILED,
  GLYPH_PAUSED,
  GLYPH_PHASE,
  GLYPH_QUEUED,
  GLYPH_READY,
  GLYPH_RUNNING,
  GLYPH_TASKED_SUBAGENTS,
  GLYPH_TREE_BRANCH,
  GLYPH_TREE_LAST,
  GLYPH_TREE_RAIL,
} from "./glyphs.js";

export interface WidgetThemeLike {
  fg(color: string, text: string): string;
  dim?(text: string): string;
  muted?(text: string): string;
  bold?(text: string): string;
}

export interface WidgetBuildOptions {
  runningDots?: string;
  now?: number;
}

export const COMPACT_WIDGET_MAX_WIDTH = 88;

const SUMMARY_TITLE_WIDTH = 48;
const PHASE_TITLE_WIDTH = 44;
const TASK_TITLE_WIDTH = 46;
const ACTIVITY_TEXT_WIDTH = 50;
const ASSIGNMENT_ID_WIDTH = 24;
const MAX_ACTIVITY_LINES = 3;
const RUNNING_DOT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RUNNING_DOT_INTERVAL_MS = 120;

function muted(text: string, theme?: WidgetThemeLike): string {
  return theme?.muted ? theme.muted(text) : text;
}

function bold(text: string, theme?: WidgetThemeLike): string {
  return theme?.bold ? theme.bold(text) : text;
}

function color(text: string, colorName: string, theme?: WidgetThemeLike): string {
  return theme ? theme.fg(colorName, text) : text;
}

function joinParts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}
function statusColor(status: string): string {
  switch (status) {
    case "running":
    case "ready":
    case "queued":
      return "accent";
    case "completed":
    case "skipped":
      return "success";
    case "attention":
    case "blocked":
    case "paused":
    case "failed":
    case "cancelled":
      return "warning";
    default:
      return "muted";
  }
}

function statusGlyph(status: string): string {
  switch (status) {
    case "running": return GLYPH_RUNNING;
    case "ready": return GLYPH_READY;
    case "completed":
    case "skipped": return GLYPH_DONE;
    case "attention": return GLYPH_ATTENTION;
    case "failed":
    case "cancelled": return GLYPH_FAILED;
    case "blocked":
    case "paused": return GLYPH_PAUSED;
    default: return GLYPH_QUEUED;
  }
}

function colorStatus(status: string, theme?: WidgetThemeLike): string {
  return color(statusGlyph(status), statusColor(status), theme);
}

function treeGlyph(isLast: boolean, theme?: WidgetThemeLike): string {
  return color(isLast ? GLYPH_TREE_LAST : GLYPH_TREE_BRANCH, "muted", theme);
}

function childPrefix(parentLast: boolean, theme?: WidgetThemeLike): string {
  return `${color(parentLast ? " " : GLYPH_TREE_RAIL, "muted", theme)}  `;
}

function linePrefix(isLast: boolean, theme?: WidgetThemeLike): string {
  return `${treeGlyph(isLast, theme)} `;
}

function planVisibleInWidget(plan: PlanRecord): boolean {
  return plan.status !== "completed" && plan.status !== "cancelled";
}

function currentPlan(state: TaskedSubagentsState): PlanRecord | undefined {
  if (state.currentPlanId) {
    const current = state.plans.find((plan) => plan.id === state.currentPlanId);
    if (current && planVisibleInWidget(current)) return current;
  }
  return state.plans.find((plan) => (plan.status === "attention" || plan.status === "failed") && planVisibleInWidget(plan))
    ?? state.plans.find((plan) => (plan.status === "running" || plan.status === "pending") && planVisibleInWidget(plan));
}

function taskDisplaysDone(plan: PlanRecord, task: TaskRecord): boolean {
  return task.status === "completed" || assignmentForTask(plan, task)?.status === "completed";
}

function planTaskProgress(plan: PlanRecord): { done: number; total: number } {
  const tasks = plan.phases.flatMap((phase) => phase.tasks);
  return { done: tasks.filter((task) => taskDisplaysDone(plan, task)).length, total: tasks.length };
}

function taskCriteriaProgress(task: TaskRecord): { done: number; total: number } {
  return { done: task.criteria.filter((criterion) => criterion.satisfied).length, total: task.criteria.length };
}

function phaseProgress(plan: PlanRecord, phase: PhaseRecord): { done: number; total: number } {
  return { done: phase.tasks.filter((task) => taskDisplaysDone(plan, task)).length, total: phase.tasks.length };
}

function statusProgressLabel(
  status: string,
  progress: { done: number; total: number } | undefined,
  theme?: WidgetThemeLike,
  options: { hideZeroProgress?: boolean } = {},
): string {
  const statusGlyphValue = colorStatus(status, theme);
  if (!progress || progress.total === 0 || progress.done === progress.total) return statusGlyphValue;
  if (options.hideZeroProgress && progress.done === 0) return statusGlyphValue;
  return `${statusGlyphValue} ${muted(`${progress.done}/${progress.total}`, theme)}`;
}

function assignmentForTask(plan: PlanRecord, task: TaskRecord): TaskAssignmentRecord | undefined {
  for (let index = task.assignmentIds.length - 1; index >= 0; index -= 1) {
    const assignment = plan.assignments.find((candidate) => candidate.id === task.assignmentIds[index]);
    if (assignment) return assignment;
  }
  return undefined;
}

function phaseHasUnfinishedWork(plan: PlanRecord, phase: PhaseRecord): boolean {
  return phase.tasks.some((task) => !taskDisplaysDone(plan, task));
}

function phaseIsInteresting(phase: PhaseRecord): boolean {
  return phase.status !== "pending" || phase.tasks.some((task) => task.status !== "pending");
}

function visiblePhases(plan: PlanRecord): PhaseRecord[] {
  const unfinished = plan.phases.filter((phase) => phaseHasUnfinishedWork(plan, phase));
  const interestingUnfinished = unfinished.filter(phaseIsInteresting);
  if (interestingUnfinished.length > 0) return interestingUnfinished;
  const interesting = plan.phases.filter(phaseIsInteresting);
  return interesting.length > 0 ? interesting : plan.phases;
}

function visibleTasks(plan: PlanRecord, phase: PhaseRecord): TaskRecord[] {
  const unfinished = phase.tasks.filter((task) => !taskDisplaysDone(plan, task));
  const activeOrNeedsAttention = unfinished.filter((task) => task.status !== "pending");
  if (activeOrNeedsAttention.length > 0) return activeOrNeedsAttention;
  return unfinished;
}

function completedTaskCount(plan: PlanRecord, phase: PhaseRecord): number {
  return phase.tasks.filter((task) => taskDisplaysDone(plan, task)).length;
}

function buildSummaryLine(plan: PlanRecord, theme?: WidgetThemeLike, options: WidgetBuildOptions = {}): string {
  const progress = planTaskProgress(plan);
  return joinParts([
    `${color(GLYPH_TASKED_SUBAGENTS, "accent", theme)} ${bold("Tasked", theme)}`,
    statusProgressLabel(plan.status, progress, theme),
    plan.status === "running" && options.runningDots ? color(options.runningDots, "accent", theme) : undefined,
    bold(shortTitle(plan.title || plan.request, SUMMARY_TITLE_WIDTH), theme),
  ]);
}

function buildPhaseLine(plan: PlanRecord, phase: PhaseRecord, isLast: boolean, theme?: WidgetThemeLike): string {
  return `${linePrefix(isLast, theme)}${color(GLYPH_PHASE, "accent", theme)} ${bold(shortTitle(phase.title, PHASE_TITLE_WIDTH), theme)} ${statusProgressLabel(phase.status, phaseProgress(plan, phase), theme)}`;
}

function formatElapsed(startedAt: number | undefined, currentTime: number): string | undefined {
  if (!startedAt) return undefined;
  const elapsedSeconds = Math.max(0, Math.floor((currentTime - startedAt) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function shortAssignmentId(id: string): string {
  if (id.length <= ASSIGNMENT_ID_WIDTH) return id;
  const head = Math.max(4, Math.floor((ASSIGNMENT_ID_WIDTH - 1) / 2));
  const tail = Math.max(4, ASSIGNMENT_ID_WIDTH - head - 1);
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

function compactActivityText(text: string): string {
  return shortTitle(text, ACTIVITY_TEXT_WIDTH);
}

function activityKey(text: string): string {
  return text.trim().replace(/^last:\s*/iu, "");
}

function assignmentActivityItems(assignment: TaskAssignmentRecord): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  const add = (text: string | undefined, key = text): void => {
    const value = text?.trim();
    const normalizedKey = key ? activityKey(key) : "";
    if (!value || !normalizedKey || seen.has(normalizedKey) || items.length >= MAX_ACTIVITY_LINES) return;
    seen.add(normalizedKey);
    items.push(compactActivityText(value));
  };

  add(assignment.currentTool ? `tool: ${assignment.currentTool}` : undefined);
  add(assignment.lastActionSummary ? `last: ${assignment.lastActionSummary}` : undefined, assignment.lastActionSummary);

  const remainingSlots = MAX_ACTIVITY_LINES - items.length;
  const recentActivity: string[] = [];
  if (remainingSlots > 0) {
    const recentSeen = new Set(seen);
    for (const activity of [...(assignment.recentActivity ?? [])].reverse()) {
      const key = activityKey(activity);
      if (!key || recentSeen.has(key)) continue;
      recentSeen.add(key);
      recentActivity.push(activity);
      if (recentActivity.length >= remainingSlots) break;
    }
    recentActivity.reverse();
  }
  for (const activity of recentActivity) add(activity);
  return items;
}

function taskActivityLines(
  assignment: TaskAssignmentRecord | undefined,
  parentLast: boolean,
  taskLast: boolean,
  theme?: WidgetThemeLike,
  options: WidgetBuildOptions = {},
): string[] {
  if (!assignment || (assignment.status !== "running" && assignment.status !== "queued")) return [];
  const taskChildPrefix = `${childPrefix(parentLast, theme)}${childPrefix(taskLast, theme)}`;
  const activityChildPrefix = `${taskChildPrefix}${childPrefix(true, theme)}`;
  const currentTime = options.now ?? Date.now();
  const elapsed = formatElapsed(assignment.createdAt, currentTime);
  const activityItems = assignmentActivityItems(assignment);
  const assignmentLine = `${taskChildPrefix}${linePrefix(true, theme)}${joinParts([
    colorStatus(assignment.status, theme),
    muted(assignment.agent, theme),
    muted(shortAssignmentId(assignment.id), theme),
    elapsed ? muted(elapsed, theme) : undefined,
  ])}`;

  return [
    assignmentLine,
    ...activityItems.map((item, index) => `${activityChildPrefix}${linePrefix(index === activityItems.length - 1, theme)}${muted(item, theme)}`),
  ];
}

function buildTaskLine(plan: PlanRecord, phase: PhaseRecord, task: TaskRecord, parentLast: boolean, isLast: boolean, theme?: WidgetThemeLike): string {
  const assignment = assignmentForTask(plan, task);
  const criteria = taskCriteriaProgress(task);
  const agent = assignment?.agent ?? task.agentHint ?? phase.agentHint;
  const hasActivityDetails = assignment?.status === "queued" || assignment?.status === "running";
  return `${childPrefix(parentLast, theme)}${linePrefix(isLast, theme)}${shortTitle(task.text, TASK_TITLE_WIDTH)} ${joinParts([
    statusProgressLabel(task.status, criteria, theme, { hideZeroProgress: true }),
    agent && !hasActivityDetails ? muted(agent, theme) : undefined,
  ])}`;
}

function buildCompletedTasksLine(count: number, parentLast: boolean, isLast: boolean, theme?: WidgetThemeLike): string | undefined {
  if (count <= 0) return undefined;
  return `${childPrefix(parentLast, theme)}${linePrefix(isLast, theme)}${color(GLYPH_DONE, "success", theme)} ${muted(`${count} completed`, theme)}`;
}

function hiddenPhaseCounts(plan: PlanRecord, phases: PhaseRecord[]): { completed: number; completedTasks: number; other: number } {
  const visibleIds = new Set(phases.map((phase) => phase.id));
  let completed = 0;
  let completedTasks = 0;
  let other = 0;
  for (const phase of plan.phases) {
    if (visibleIds.has(phase.id)) continue;
    if (phase.status === "completed") {
      completed += 1;
      completedTasks += completedTaskCount(plan, phase);
    } else other += 1;
  }
  return { completed, completedTasks, other };
}

function buildHiddenLine(hidden: { completed: number; completedTasks: number; other: number }, theme?: WidgetThemeLike): string | undefined {
  const parts = [
    hidden.completed > 0 ? `${hidden.completed} ${hidden.completed === 1 ? "phase" : "phases"} completed` : undefined,
    hidden.completedTasks > 0 ? `${hidden.completedTasks} completed` : undefined,
    hidden.other > 0 ? `+${hidden.other}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `${color(GLYPH_TREE_LAST, "muted", theme)} ${muted(parts.join(", "), theme)}` : undefined;
}

export function buildWidgetLines(
  state: TaskedSubagentsState,
  limit: number = DEFAULT_WIDGET_LINES,
  theme?: WidgetThemeLike,
  options: WidgetBuildOptions = {},
): string[] {
  if (limit <= 0) return [];
  const plan = currentPlan(state);
  if (!plan) return [];

  const lines = [buildSummaryLine(plan, theme, options)];
  const phases = visiblePhases(plan);
  const hidden = hiddenPhaseCounts(plan, phases);
  const hasHiddenPhases = hidden.completed > 0 || hidden.other > 0;

  for (let phaseIndex = 0; phaseIndex < phases.length && lines.length < limit; phaseIndex += 1) {
    const phase = phases[phaseIndex];
    const phaseIsLast = phaseIndex === phases.length - 1 && !hasHiddenPhases;
    lines.push(buildPhaseLine(plan, phase, phaseIsLast, theme));
    const tasks = visibleTasks(plan, phase);
    const completedCount = completedTaskCount(plan, phase);
    const hasCompletedSummary = completedCount > 0;
    for (let taskIndex = 0; taskIndex < tasks.length && lines.length < limit; taskIndex += 1) {
      const task = tasks[taskIndex];
      const isLastVisibleTask = taskIndex === tasks.length - 1;
      const reserveCompletedSummary = hasCompletedSummary && isLastVisibleTask && lines.length + 1 < limit;
      const taskIsLast = isLastVisibleTask && !reserveCompletedSummary;
      const activityLimit = reserveCompletedSummary ? limit - 1 : limit;
      lines.push(buildTaskLine(plan, phase, task, phaseIsLast, taskIsLast, theme));
      for (const activityLine of taskActivityLines(assignmentForTask(plan, task), phaseIsLast, taskIsLast, theme, options)) {
        if (lines.length >= activityLimit) break;
        lines.push(activityLine);
      }
    }
    if (lines.length < limit) {
      const completedLine = buildCompletedTasksLine(completedCount, phaseIsLast, true, theme);
      if (completedLine) lines.push(completedLine);
    }
  }

  if (lines.length < limit) {
    const hiddenLine = buildHiddenLine(hidden, theme);
    if (hiddenLine) lines.push(hiddenLine);
  }

  return lines.slice(0, limit).map((line) => truncateToWidth(line, COMPACT_WIDGET_MAX_WIDTH, "…"));
}

function hasActiveAssignment(state: TaskedSubagentsState): boolean {
  return state.plans.some((plan) => plan.assignments.some((assignment) => assignment.status === "queued" || assignment.status === "running"));
}

export function createWidgetContent(
  state: TaskedSubagentsState,
  limit: number = DEFAULT_WIDGET_LINES,
  options: WidgetBuildOptions = {},
) {
  if (buildWidgetLines(state, limit, undefined, options).length === 0) return undefined;
  return (tui: { requestRender?: () => void }, theme: WidgetThemeLike) => {
    let frameIndex = 0;
    const shouldAnimate = hasActiveAssignment(state) && typeof tui.requestRender === "function";
    const interval = shouldAnimate
      ? setInterval(() => {
        frameIndex = (frameIndex + 1) % RUNNING_DOT_FRAMES.length;
        tui.requestRender?.();
      }, RUNNING_DOT_INTERVAL_MS)
      : undefined;
    interval?.unref?.();

    return {
      render(width: number): string[] {
        const runningDots = shouldAnimate ? RUNNING_DOT_FRAMES[frameIndex] : options.runningDots;
        const maxWidth = Math.min(Math.max(1, width), COMPACT_WIDGET_MAX_WIDTH);
        return buildWidgetLines(state, limit, theme, { ...options, runningDots }).map((line) => truncateToWidth(line, maxWidth, "…"));
      },
      invalidate() {},
      dispose() {
        if (interval) clearInterval(interval);
      },
    };
  };
}
