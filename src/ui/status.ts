// ──────────────────────────────────────────────
// Footer status for task-run tasked-subagents
// ──────────────────────────────────────────────

import type { TaskedSubagentsState } from "../types.js";
import { GLYPH_TASKED_SUBAGENTS } from "./glyphs.js";

export interface StatusThemeLike {
  fg(color: string, text: string): string;
  bold?(text: string): string;
  dim?(text: string): string;
}

function colorize(text: string, color: string, theme?: StatusThemeLike): string {
  return theme ? theme.fg(color, text) : text;
}

function bold(text: string, theme?: StatusThemeLike): string {
  return theme?.bold ? theme.bold(text) : text;
}

function dim(text: string, theme?: StatusThemeLike): string {
  return theme?.dim ? theme.dim(text) : text;
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

export function buildFooterStatus(state: TaskedSubagentsState, theme?: StatusThemeLike): string | undefined {
  if (state.taskRuns.length === 0) return undefined;
  const activeTaskRuns = state.taskRuns.filter((taskRun) => taskRun.status === "running" || taskRun.status === "pending").length;
  const attentionTaskRuns = state.taskRuns.filter((taskRun) => taskRun.status === "attention" || taskRun.status === "failed").length;
  const runningAssignments = state.taskRuns.flatMap((taskRun) => taskRun.assignments).filter((assignment) => assignment.status === "queued" || assignment.status === "running").length;
  const completedTaskRuns = state.taskRuns.filter((taskRun) => taskRun.status === "completed").length;

  const parts = [`${colorize(GLYPH_TASKED_SUBAGENTS, "accent", theme)} ${bold("tasked", theme)}`];
  if (activeTaskRuns) parts.push(colorize(plural(activeTaskRuns, "active task run"), "accent", theme));
  if (runningAssignments) parts.push(colorize(plural(runningAssignments, "running task"), "accent", theme));
  if (attentionTaskRuns) parts.push(colorize(plural(attentionTaskRuns, "attention"), "warning", theme));
  if (completedTaskRuns) parts.push(colorize(plural(completedTaskRuns, "done"), "success", theme));
  if (parts.length === 1) parts.push(colorize(plural(state.taskRuns.length, "task run"), "muted", theme));
  return parts.join(dim(" · ", theme));
}
