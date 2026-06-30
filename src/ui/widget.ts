// ──────────────────────────────────────────────
// Task-run/group/task/assignment widget rendering
// ──────────────────────────────────────────────

import { truncateToWidth } from "@earendil-works/pi-tui";

import { DEFAULT_WIDGET_LINES } from "../defaults.js";
import type { TaskAssignmentRecord, TaskRecord, TaskRunRecord, TaskedSubagentsState } from "../types.js";
import { shortTitle } from "../utils/text.js";
import {
  GLYPH_ATTENTION,
  GLYPH_DONE,
  GLYPH_FAILED,
  GLYPH_PAUSED,
  GLYPH_GROUP,
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
const GROUP_TITLE_WIDTH = 44;
const TASK_TITLE_WIDTH = 46;
const ACTIVITY_TEXT_WIDTH = 50;
const ASSIGNMENT_ID_WIDTH = 24;
const MAX_ACTIVITY_LINES = 3;
const RUNNING_DOT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RUNNING_DOT_INTERVAL_MS = 120;

interface WidgetGroupView {
  id?: string;
  title: string;
  status: string;
  agentHint?: string;
}

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

function taskRunVisibleInWidget(taskRun: TaskRunRecord): boolean {
  return taskRun.status !== "completed" && taskRun.status !== "cancelled";
}

function currentTaskRun(state: TaskedSubagentsState): TaskRunRecord | undefined {
  if (state.currentTaskRunId) {
    const current = state.taskRuns.find((taskRun) => taskRun.id === state.currentTaskRunId);
    if (current && taskRunVisibleInWidget(current)) return current;
  }
  return state.taskRuns.find((taskRun) => (taskRun.status === "attention" || taskRun.status === "failed") && taskRunVisibleInWidget(taskRun))
    ?? state.taskRuns.find((taskRun) => (taskRun.status === "running" || taskRun.status === "pending") && taskRunVisibleInWidget(taskRun))
    ?? state.taskRuns.find(taskRunVisibleInWidget);
}

function taskDisplaysDone(taskRun: TaskRunRecord, task: TaskRecord): boolean {
  return task.status === "completed" || assignmentForTask(taskRun, task)?.status === "completed";
}

function taskRunTaskProgress(taskRun: TaskRunRecord): { done: number; total: number } {
  return { done: taskRun.tasks.filter((task) => taskDisplaysDone(taskRun, task)).length, total: taskRun.tasks.length };
}

function taskCriteriaProgress(task: TaskRecord): { done: number; total: number } {
  return { done: task.criteria.filter((criterion) => criterion.satisfied).length, total: task.criteria.length };
}

function groupProgress(taskRun: TaskRunRecord, group: WidgetGroupView): { done: number; total: number } {
  const tasks = tasksForGroup(taskRun, group.id);
  return { done: tasks.filter((task) => taskDisplaysDone(taskRun, task)).length, total: tasks.length };
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

function assignmentsForTask(taskRun: TaskRunRecord, task: TaskRecord): TaskAssignmentRecord[] {
  return task.assignmentIds
    .map((assignmentId) => taskRun.assignments.find((candidate) => candidate.id === assignmentId))
    .filter((assignment): assignment is TaskAssignmentRecord => Boolean(assignment));
}

function assignmentForTask(taskRun: TaskRunRecord, task: TaskRecord): TaskAssignmentRecord | undefined {
  return assignmentsForTask(taskRun, task).at(-1);
}

function tasksForGroup(taskRun: TaskRunRecord, groupId: string | undefined): TaskRecord[] {
  return taskRun.tasks.filter((task) => task.groupId === groupId);
}

function taskStatusForWidgetGroup(tasks: TaskRecord[]): string {
  if (tasks.some((task) => task.status === "attention")) return "attention";
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "ready")) return "ready";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.every((task) => task.status === "completed")) return "completed";
  if (tasks.every((task) => task.status === "cancelled")) return "cancelled";
  return "pending";
}

function widgetGroups(taskRun: TaskRunRecord): WidgetGroupView[] {
  const ungroupedTasks = tasksForGroup(taskRun, undefined);
  return ungroupedTasks.length > 0
    ? [...taskRun.groups, { title: "Ungrouped", status: taskStatusForWidgetGroup(ungroupedTasks) }]
    : taskRun.groups;
}

function groupHasUnfinishedWork(taskRun: TaskRunRecord, group: WidgetGroupView): boolean {
  return tasksForGroup(taskRun, group.id).some((task) => !taskDisplaysDone(taskRun, task));
}

function groupIsInteresting(taskRun: TaskRunRecord, group: WidgetGroupView): boolean {
  return group.status !== "pending" || tasksForGroup(taskRun, group.id).some((task) => task.status !== "pending");
}

function visibleGroups(taskRun: TaskRunRecord): WidgetGroupView[] {
  const groups = widgetGroups(taskRun);
  const unfinished = groups.filter((group) => groupHasUnfinishedWork(taskRun, group));
  const interestingUnfinished = unfinished.filter((group) => groupIsInteresting(taskRun, group));
  if (interestingUnfinished.length > 0) return interestingUnfinished;
  const interesting = groups.filter((group) => groupIsInteresting(taskRun, group));
  return interesting.length > 0 ? interesting : groups;
}

function visibleTasks(taskRun: TaskRunRecord, group: WidgetGroupView): TaskRecord[] {
  const unfinished = tasksForGroup(taskRun, group.id).filter((task) => !taskDisplaysDone(taskRun, task));
  const activeOrNeedsAttention = unfinished.filter((task) => task.status !== "pending");
  if (activeOrNeedsAttention.length > 0) return activeOrNeedsAttention;
  return unfinished;
}

function completedTaskCount(taskRun: TaskRunRecord, group: WidgetGroupView): number {
  return tasksForGroup(taskRun, group.id).filter((task) => taskDisplaysDone(taskRun, task)).length;
}

function buildSummaryLine(taskRun: TaskRunRecord, theme?: WidgetThemeLike, options: WidgetBuildOptions = {}): string {
  const progress = taskRunTaskProgress(taskRun);
  return joinParts([
    `${color(GLYPH_TASKED_SUBAGENTS, "accent", theme)} ${bold("Tasked", theme)}`,
    statusProgressLabel(taskRun.status, progress, theme),
    taskRun.status === "running" && options.runningDots ? color(options.runningDots, "accent", theme) : undefined,
    bold(shortTitle(taskRun.title || taskRun.request, SUMMARY_TITLE_WIDTH), theme),
  ]);
}

function buildGroupLine(taskRun: TaskRunRecord, group: WidgetGroupView, isLast: boolean, theme?: WidgetThemeLike): string {
  return `${linePrefix(isLast, theme)}${color(GLYPH_GROUP, "accent", theme)} ${bold(shortTitle(group.title, GROUP_TITLE_WIDTH), theme)} ${statusProgressLabel(group.status, groupProgress(taskRun, group), theme)}`;
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

function buildTaskLine(taskRun: TaskRunRecord, group: WidgetGroupView, task: TaskRecord, parentLast: boolean, isLast: boolean, theme?: WidgetThemeLike): string {
  const assignment = assignmentForTask(taskRun, task);
  const criteria = taskCriteriaProgress(task);
  const agent = assignment?.agent ?? task.agentHint ?? group.agentHint;
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

function groupKey(group: WidgetGroupView): string {
  return group.id === undefined ? "ungrouped" : `group:${group.id}`;
}

function hiddenGroupCounts(taskRun: TaskRunRecord, groups: WidgetGroupView[]): { completed: number; completedTasks: number; other: number } {
  const visibleKeys = new Set(groups.map(groupKey));
  let completed = 0;
  let completedTasks = 0;
  let other = 0;
  for (const group of widgetGroups(taskRun)) {
    if (visibleKeys.has(groupKey(group))) continue;
    if (group.status === "completed") {
      completed += 1;
      completedTasks += completedTaskCount(taskRun, group);
    } else other += 1;
  }
  return { completed, completedTasks, other };
}

function buildHiddenLine(hidden: { completed: number; completedTasks: number; other: number }, theme?: WidgetThemeLike): string | undefined {
  const parts = [
    hidden.completed > 0 ? `${hidden.completed} ${hidden.completed === 1 ? "group" : "groups"} completed` : undefined,
    hidden.completedTasks > 0 ? `${hidden.completedTasks} completed` : undefined,
    hidden.other > 0 ? `+${hidden.other}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `${color(GLYPH_TREE_LAST, "muted", theme)} ${muted(parts.join(", "), theme)}` : undefined;
}

function pushLimited(lines: string[], line: string, limit: number): boolean {
  if (lines.length >= limit) return false;
  lines.push(line);
  return true;
}

function checklistTaskLine(taskRun: TaskRunRecord, task: TaskRecord, groupLast: boolean, taskLast: boolean): string {
  const assignment = assignmentForTask(taskRun, task);
  const criteria = taskCriteriaProgress(task);
  const details = [
    `${criteria.done}/${criteria.total} criteria`,
    task.dependsOn.length > 0 ? `depends on: ${task.dependsOn.join(", ")}` : undefined,
    assignment?.agent,
  ].filter(Boolean).join(" · ");
  return `${childPrefix(groupLast)}${linePrefix(taskLast)}${statusGlyph(task.status)} ${shortTitle(task.text, TASK_TITLE_WIDTH)}${details ? ` ${details}` : ""}`;
}

function checklistAssignmentLine(assignment: TaskAssignmentRecord, groupLast: boolean, taskLast: boolean, assignmentLast: boolean): string {
  const taskChildPrefix = `${childPrefix(groupLast)}${childPrefix(taskLast)}`;
  return `${taskChildPrefix}${linePrefix(assignmentLast)}${statusGlyph(assignment.status)} ${assignment.agent} ${shortAssignmentId(assignment.id)}`;
}

export function buildTaskRunChecklistLines(taskRun: TaskRunRecord, limit = 100): string[] {
  if (limit <= 0) return [];
  const rawLines: string[] = [];
  const append = (line: string): boolean => pushLimited(rawLines, line, limit);
  let totalLineCount = 1;
  const progress = taskRunTaskProgress(taskRun);
  append(`${GLYPH_TASKED_SUBAGENTS} TaskRun ${taskRun.id} ${statusGlyph(taskRun.status)} ${progress.done}/${progress.total} ${shortTitle(taskRun.title || taskRun.request, SUMMARY_TITLE_WIDTH)}`);

  const groups = widgetGroups(taskRun);
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const groupLast = groupIndex === groups.length - 1;
    const progressForGroup = groupProgress(taskRun, group);
    totalLineCount += 1;
    append(`${linePrefix(groupLast)}${GLYPH_GROUP} ${shortTitle(group.title, GROUP_TITLE_WIDTH)} ${statusGlyph(group.status)} ${progressForGroup.done}/${progressForGroup.total}`);
    const groupTasks = tasksForGroup(taskRun, group.id);
    for (let taskIndex = 0; taskIndex < groupTasks.length; taskIndex += 1) {
      const task = groupTasks[taskIndex];
      const taskLast = taskIndex === groupTasks.length - 1;
      totalLineCount += 1;
      append(checklistTaskLine(taskRun, task, groupLast, taskLast));
      const assignments = assignmentsForTask(taskRun, task);
      for (const [assignmentIndex, assignment] of assignments.entries()) {
        const assignmentLast = assignmentIndex === assignments.length - 1;
        totalLineCount += 1;
        append(checklistAssignmentLine(assignment, groupLast, taskLast, assignmentLast));
      }
    }
  }

  if (rawLines.length < totalLineCount && rawLines.length > 0) {
    rawLines.splice(rawLines.length - 1, 1, `${GLYPH_TREE_LAST} ${totalLineCount - rawLines.length + 1} more checklist lines`);
  }

  return rawLines.map((line) => truncateToWidth(line, COMPACT_WIDGET_MAX_WIDTH, "…"));
}

export function buildWidgetLines(
  state: TaskedSubagentsState,
  limit: number = DEFAULT_WIDGET_LINES,
  theme?: WidgetThemeLike,
  options: WidgetBuildOptions = {},
): string[] {
  if (limit <= 0) return [];
  const taskRun = currentTaskRun(state);
  if (!taskRun) return [];

  const lines = [buildSummaryLine(taskRun, theme, options)];
  const groups = visibleGroups(taskRun);
  const hidden = hiddenGroupCounts(taskRun, groups);
  const hasHiddenGroups = hidden.completed > 0 || hidden.other > 0;

  for (let groupIndex = 0; groupIndex < groups.length && lines.length < limit; groupIndex += 1) {
    const group = groups[groupIndex];
    const groupIsLast = groupIndex === groups.length - 1 && !hasHiddenGroups;
    lines.push(buildGroupLine(taskRun, group, groupIsLast, theme));
    const tasks = visibleTasks(taskRun, group);
    const completedCount = completedTaskCount(taskRun, group);
    const hasCompletedSummary = completedCount > 0;
    for (let taskIndex = 0; taskIndex < tasks.length && lines.length < limit; taskIndex += 1) {
      const task = tasks[taskIndex];
      const isLastVisibleTask = taskIndex === tasks.length - 1;
      const reserveCompletedSummary = hasCompletedSummary && isLastVisibleTask && lines.length + 1 < limit;
      const taskIsLast = isLastVisibleTask && !reserveCompletedSummary;
      const activityLimit = reserveCompletedSummary ? limit - 1 : limit;
      lines.push(buildTaskLine(taskRun, group, task, groupIsLast, taskIsLast, theme));
      for (const activityLine of taskActivityLines(assignmentForTask(taskRun, task), groupIsLast, taskIsLast, theme, options)) {
        if (lines.length >= activityLimit) break;
        lines.push(activityLine);
      }
    }
    if (lines.length < limit) {
      const completedLine = buildCompletedTasksLine(completedCount, groupIsLast, true, theme);
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
  return state.taskRuns.some((taskRun) => taskRun.assignments.some((assignment) => assignment.status === "queued" || assignment.status === "running"));
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
