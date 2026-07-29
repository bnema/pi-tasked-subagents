// ──────────────────────────────────────────────
// Task-run/group/task/assignment widget rendering
// ──────────────────────────────────────────────

import { truncateToWidth } from "@earendil-works/pi-tui";

import { DEFAULT_WIDGET_LINES } from "../defaults.js";
import type { TaskAssignmentRecord, TaskRecord, TaskRunRecord, TaskedSubagentsState } from "../types.js";
import { assignmentsForTask, authoritativeAssignment, isSupersededAssignment } from "../orchestration/assignment-attempts.js";
import { formatCompactDuration, shortTitle } from "../utils/text.js";
import {
  GLYPH_ATTENTION,
  GLYPH_DONE,
  GLYPH_FAILED,
  GLYPH_PAUSED,
  GLYPH_GROUP,
  GLYPH_QUEUED,
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
const GROUP_PREFIX_WIDTH = 18;
const TASK_TITLE_WIDTH = 46;
const ACTIVITY_TEXT_WIDTH = 50;
const ASSIGNMENT_ID_WIDTH = 24;
const MAX_ACTIVITY_LINES = 3;
/** Only annotate a completed action with its age once it reads as idle, not in-progress. */
const IDLE_AGE_THRESHOLD_MS = 60_000;
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
    case "queued":
      return "accent";
    case "completed":
    case "skipped":
      return "success";
    case "attention":
    case "paused":
    case "failed":
    case "cancelled":
      return "warning";
    case "ready":
    case "blocked":
    case "pending":
    default:
      return "muted";
  }
}

function statusGlyph(status: string): string {
  switch (status) {
    case "running":
    case "queued":
      return GLYPH_RUNNING;
    case "completed":
    case "skipped":
      return GLYPH_DONE;
    case "attention":
      return GLYPH_ATTENTION;
    case "failed":
    case "cancelled":
      return GLYPH_FAILED;
    case "paused":
      return GLYPH_PAUSED;
    case "ready":
    case "blocked":
    case "pending":
    default:
      return GLYPH_QUEUED;
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

function criteriaProgressCounter(task: TaskRecord, theme?: WidgetThemeLike): string | undefined {
  const progress = taskCriteriaProgress(task);
  if (progress.total === 0 || progress.done === 0 || progress.done === progress.total) return undefined;
  return muted(`${progress.done}/${progress.total}`, theme);
}

function assignmentForTask(taskRun: TaskRunRecord, task: TaskRecord): TaskAssignmentRecord | undefined {
  return authoritativeAssignment(taskRun, task);
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

function buildSummaryLine(taskRun: TaskRunRecord, theme?: WidgetThemeLike, options: WidgetBuildOptions = {}): string {
  const progress = taskRunTaskProgress(taskRun);
  return joinParts([
    `${color(GLYPH_TASKED_SUBAGENTS, "accent", theme)} ${bold("Tasked", theme)}`,
    statusProgressLabel(taskRun.status, progress, theme),
    taskRun.status === "running" && options.runningDots ? color(options.runningDots, "accent", theme) : undefined,
    bold(shortTitle(taskRun.title || taskRun.request, SUMMARY_TITLE_WIDTH), theme),
  ]);
}

function groupTitleForTask(taskRun: TaskRunRecord, task: TaskRecord): string | undefined {
  return taskRun.groups.find((group) => group.id === task.groupId)?.title;
}

function triageTaskTitle(taskRun: TaskRunRecord, task: TaskRecord, theme?: WidgetThemeLike): string {
  const groupTitle = groupTitleForTask(taskRun, task);
  const title = shortTitle(task.text, TASK_TITLE_WIDTH);
  return groupTitle ? `${muted(`${shortTitle(groupTitle, GROUP_PREFIX_WIDTH)} · `, theme)}${title}` : title;
}

function taskNeedsAttention(taskRun: TaskRunRecord, task: TaskRecord): boolean {
  if (taskDisplaysDone(taskRun, task) || task.status === "cancelled") return false;
  const assignment = assignmentForTask(taskRun, task);
  return task.status === "attention" || task.status === "failed"
    || assignment?.status === "attention" || assignment?.status === "failed" || assignment?.status === "paused";
}

function attentionReason(assignment: TaskAssignmentRecord | undefined, now: number): string | undefined {
  if (!assignment) return undefined;
  if (assignment.result && assignment.result.status !== "completed" && assignment.result.summary) {
    return compactActivityText(assignment.result.summary);
  }
  if (assignment.staleEscalatedAt !== undefined && assignment.lastActionAt !== undefined) {
    return `no activity for ${formatCompactDuration(now - assignment.lastActionAt)}`;
  }
  return assignment.lastActionSummary ? compactActivityText(`last: ${assignment.lastActionSummary}`) : undefined;
}

function buildTailLine(taskRun: TaskRunRecord, shownTaskIds: Set<string>, theme?: WidgetThemeLike): string | undefined {
  const done = taskRun.tasks.filter((task) => taskDisplaysDone(taskRun, task)).length;
  const waitingTasks = taskRun.tasks.filter((task) =>
    !taskDisplaysDone(taskRun, task) && task.status !== "cancelled" && !shownTaskIds.has(task.id));
  const waitingGroupCount = taskRun.groups.filter((group) => {
    const tasks = tasksForGroup(taskRun, group.id);
    const waitingInGroup = tasks.filter((task) =>
      !taskDisplaysDone(taskRun, task) && task.status !== "cancelled");
    return waitingInGroup.length > 0 && !waitingInGroup.some((task) => shownTaskIds.has(task.id));
  }).length;
  const parts: string[] = [];
  if (waitingGroupCount > 0) parts.push(`${waitingGroupCount} ${waitingGroupCount === 1 ? "group" : "groups"} waiting`);
  if (waitingTasks.length > 0) {
    const plural = waitingTasks.length === 1 ? "task" : "tasks";
    parts.push(waitingGroupCount === 0
      ? `${waitingTasks.length} ${plural} waiting`
      : `${waitingTasks.length} ${plural}`);
  }
  if (done > 0 || parts.length > 0) parts.push(`${done} done`);
  return parts.length > 0 ? `${color(GLYPH_TREE_LAST, "muted", theme)} ${muted(parts.join(" · "), theme)}` : undefined;
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

function assignmentActivityItems(assignment: TaskAssignmentRecord, now: number): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  const add = (text: string | undefined, key = text): void => {
    const value = text?.trim();
    const normalizedKey = key ? activityKey(key) : "";
    if (!value || !normalizedKey || seen.has(normalizedKey) || items.length >= MAX_ACTIVITY_LINES) return;
    seen.add(normalizedKey);
    items.push(compactActivityText(value));
  };

  // A completed action with no active tool is idle, not running: show its age so
  // "last: tool end: bash" no longer reads as though bash were still executing.
  const idleAge = !assignment.currentTool && assignment.lastActionAt !== undefined && now - assignment.lastActionAt >= IDLE_AGE_THRESHOLD_MS
    ? ` (${formatCompactDuration(now - assignment.lastActionAt)} ago)`
    : "";

  add(assignment.currentTool ? `tool: ${assignment.currentTool}` : undefined);
  if (assignment.lastActionSummary) {
    // Reserve room for the idle-age suffix so summary truncation never eats it.
    const base = `last: ${assignment.lastActionSummary}`;
    const line = idleAge ? `${shortTitle(base, ACTIVITY_TEXT_WIDTH - idleAge.length)}${idleAge}` : base;
    add(line, assignment.lastActionSummary);
  }

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

function pushLimited(lines: string[], line: string, limit: number): boolean {
  if (lines.length >= limit) return false;
  lines.push(line);
  return true;
}

function checklistAssignmentSummary(assignment: TaskAssignmentRecord | undefined): string | undefined {
  return assignment ? `${assignment.agent} ${shortAssignmentId(assignment.id)} ${assignment.status}` : undefined;
}

function checklistTaskLine(taskRun: TaskRunRecord, task: TaskRecord, groupLast: boolean, taskLast: boolean, current: boolean): string {
  const assignment = assignmentForTask(taskRun, task);
  const criteria = taskCriteriaProgress(task);
  const currentMarker = current ? "→ " : "  ";
  const details = [
    `${criteria.done}/${criteria.total} criteria`,
    task.dependsOn.length > 0 ? `depends on: ${task.dependsOn.join(", ")}` : undefined,
    checklistAssignmentSummary(assignment),
  ].filter(Boolean).join(" · ");
  return `${childPrefix(groupLast)}${linePrefix(taskLast)}${currentMarker}${statusGlyph(task.status)} ${shortTitle(task.text, TASK_TITLE_WIDTH)}${details ? ` ${details}` : ""}`;
}

function checklistTaskPriority(taskRun: TaskRunRecord, task: TaskRecord): number | undefined {
  if (task.status === "cancelled" || taskDisplaysDone(taskRun, task)) return undefined;
  const assignment = assignmentForTask(taskRun, task);
  if (task.status === "attention" || task.status === "failed" || assignment?.status === "attention" || assignment?.status === "failed") return 0;
  if (task.status === "blocked") return 1;
  if (task.status === "running" || assignment?.status === "running" || assignment?.status === "queued") return 2;
  if (task.status === "ready") return 3;
  if (task.status === "pending") return 4;
  return 4;
}

function currentChecklistTaskId(taskRun: TaskRunRecord): string | undefined {
  let current: { id: string; priority: number } | undefined;
  for (const task of taskRun.tasks) {
    const priority = checklistTaskPriority(taskRun, task);
    if (priority === undefined) continue;
    if (!current || priority < current.priority) current = { id: task.id, priority };
  }
  return current?.id;
}

function checklistAssignmentLine(assignment: TaskAssignmentRecord, groupLast: boolean, taskLast: boolean, assignmentLast: boolean): string {
  const taskChildPrefix = `${childPrefix(groupLast)}${childPrefix(taskLast)}`;
  return `${taskChildPrefix}${linePrefix(assignmentLast)}${statusGlyph(assignment.status)} ${assignment.agent} ${shortAssignmentId(assignment.id)}`;
}

function checklistHistoryLine(count: number, groupLast: boolean, taskLast: boolean): string {
  const taskChildPrefix = `${childPrefix(groupLast)}${childPrefix(taskLast)}`;
  return `${taskChildPrefix}${linePrefix(true)}${count} previous ${count === 1 ? "attempt" : "attempts"}`;
}

export function buildTaskRunChecklistLines(taskRun: TaskRunRecord, limit = 100): string[] {
  if (limit <= 0) return [];
  const rawLines: string[] = [];
  const append = (line: string): boolean => pushLimited(rawLines, line, limit);
  let totalLineCount = 1;
  const progress = taskRunTaskProgress(taskRun);
  append(`${GLYPH_TASKED_SUBAGENTS} TaskRun ${taskRun.id} ${statusGlyph(taskRun.status)} ${progress.done}/${progress.total} ${shortTitle(taskRun.title || taskRun.request, SUMMARY_TITLE_WIDTH)}`);

  const currentTaskId = currentChecklistTaskId(taskRun);
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
      append(checklistTaskLine(taskRun, task, groupLast, taskLast, task.id === currentTaskId));
      const assignments = assignmentsForTask(taskRun, task);
      const assignment = authoritativeAssignment(taskRun, task);
      const historicalCount = assignments.filter(isSupersededAssignment).length;
      if (assignment) {
        totalLineCount += 1;
        append(checklistAssignmentLine(assignment, groupLast, taskLast, historicalCount === 0));
      }
      if (historicalCount > 0) {
        totalLineCount += 1;
        append(checklistHistoryLine(historicalCount, groupLast, taskLast));
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

  const now = options.now ?? Date.now();
  const summary = buildSummaryLine(taskRun, theme, options);
  const needsYou = taskRun.tasks.filter((task) => taskNeedsAttention(taskRun, task));
  const active = taskRun.tasks.filter((task) => {
    if (taskNeedsAttention(taskRun, task) || taskDisplaysDone(taskRun, task)) return false;
    const assignment = assignmentForTask(taskRun, task);
    return assignment?.status === "running" || assignment?.status === "queued";
  });
  const nextUp = taskRun.tasks.find((task) =>
    task.status === "ready" && !needsYou.includes(task) && !active.includes(task));
  interface TriageSection {
    tier: "needs-you" | "active" | "next-up";
    taskId: string;
    head: string;
    children: string[];
  }
  const sections: TriageSection[] = [];

  for (const task of needsYou) {
    const assignment = assignmentForTask(taskRun, task);
    const displayStatus = assignment?.status === "paused"
      ? "paused"
      : (assignment?.status === "failed" || task.status === "failed")
        ? "failed"
        : "attention";
    const children: string[] = [];
    const reason = attentionReason(assignment, now);
    if (reason) children.push(muted(reason, theme));
    sections.push({
      tier: "needs-you",
      taskId: task.id,
      head: joinParts([colorStatus(displayStatus, theme), triageTaskTitle(taskRun, task, theme)]),
      children,
    });
  }

  for (const task of active) {
    const assignment = assignmentForTask(taskRun, task)!;
    const elapsed = formatElapsed(assignment.createdAt, now);
    sections.push({
      tier: "active",
      taskId: task.id,
      head: joinParts([
        colorStatus(assignment.status, theme),
        triageTaskTitle(taskRun, task, theme),
        muted(assignment.agent, theme),
        elapsed ? muted(elapsed, theme) : undefined,
        criteriaProgressCounter(task, theme),
      ]),
      children: assignmentActivityItems(assignment, now).map((item) => muted(item, theme)),
    });
  }

  if (nextUp) {
    const dependencyTitles = nextUp.dependsOn.map((dependencyId) => {
      const dependency = taskRun.tasks.find((task) => task.id === dependencyId);
      return dependency ? shortTitle(dependency.text, TASK_TITLE_WIDTH) : dependencyId;
    });
    const after = dependencyTitles.length > 0 ? ` · after ${dependencyTitles.join(", ")}` : "";
    sections.push({
      tier: "next-up",
      taskId: nextUp.id,
      head: joinParts([
        colorStatus("ready", theme),
        muted("next:", theme),
        `${triageTaskTitle(taskRun, nextUp, theme)}${muted(after, theme)}`,
      ]),
      children: [],
    });
  }

  const tierOrder: Array<TriageSection["tier"]> = ["needs-you", "active", "next-up"];

  function sectionLineCount(section: TriageSection): number {
    return 1 + section.children.length;
  }

  function shownTaskIdsFrom(included: TriageSection[]): Set<string> {
    return new Set(included.map((section) => section.taskId));
  }

  /** Prefer higher tiers; within a tier admit heads before optional children; never admit lower tiers past an unfit higher head. */
  function allocateBodyLines(bodyBudget: number): TriageSection[] {
    const included: TriageSection[] = [];
    let budget = bodyBudget;
    for (const tier of tierOrder) {
      const tierSections = sections.filter((candidate) => candidate.tier === tier);
      if (tierSections.length === 0) continue;
      if (budget <= 0) return included;

      const admitted: TriageSection[] = [];
      for (const section of tierSections) {
        if (budget < 1) break;
        admitted.push({ ...section, children: [] });
        budget -= 1;
      }

      for (let index = 0; index < admitted.length; index += 1) {
        const children: string[] = [];
        for (const child of tierSections[index].children) {
          if (budget < 1) break;
          children.push(child);
          budget -= 1;
        }
        admitted[index] = { ...admitted[index], children };
      }

      included.push(...admitted);
      if (admitted.length < tierSections.length) return included;
    }
    return included;
  }

  function renderBodyLines(included: TriageSection[], hasTail: boolean): string[] {
    const body: string[] = [];
    for (let index = 0; index < included.length; index += 1) {
      const section = included[index];
      const sectionLast = index === included.length - 1 && !hasTail;
      body.push(`${linePrefix(sectionLast, theme)}${section.head}`);
      for (let childIndex = 0; childIndex < section.children.length; childIndex += 1) {
        const childLast = childIndex === section.children.length - 1;
        body.push(`${childPrefix(sectionLast, theme)}${linePrefix(childLast, theme)}${section.children[childIndex]}`);
      }
    }
    return body;
  }

  // Summary always consumes the first line; never append a tail when limit leaves no body slot.
  if (limit === 1) {
    return [truncateToWidth(summary, COMPACT_WIDGET_MAX_WIDTH, "…")];
  }

  const bodyBudget = limit - 1;
  let included = allocateBodyLines(bodyBudget);
  let shownTaskIds = shownTaskIdsFrom(included);
  let tail = buildTailLine(taskRun, shownTaskIds, theme);
  const remainingBudget = bodyBudget - included.reduce((sum, section) => sum + sectionLineCount(section), 0);

  if (tail && remainingBudget === 0) {
    const reservedBudget = bodyBudget - 1;
    if (reservedBudget > 0) {
      const reserved = allocateBodyLines(reservedBudget);
      const reservedShown = shownTaskIdsFrom(reserved);
      const reservedTail = buildTailLine(taskRun, reservedShown, theme);
      if (reservedTail) {
        included = reserved;
        tail = reservedTail;
      }
    } else {
      tail = undefined;
    }
  }

  const lines = [summary, ...renderBodyLines(included, Boolean(tail))];
  if (tail && lines.length < limit) lines.push(tail);
  return lines.slice(0, limit).map((line) => truncateToWidth(line, COMPACT_WIDGET_MAX_WIDTH, "…"));
}

function hasActiveAssignment(state: TaskedSubagentsState): boolean {
  return state.taskRuns.some((taskRun) => taskRun.assignments.some(
    (assignment) => !isSupersededAssignment(assignment) && (assignment.status === "queued" || assignment.status === "running"),
  ));
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
