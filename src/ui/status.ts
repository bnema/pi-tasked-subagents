// ──────────────────────────────────────────────
// Footer status for plan-first tasked-subagents
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
  if (state.plans.length === 0) return undefined;
  const activePlans = state.plans.filter((plan) => plan.status === "running" || plan.status === "pending").length;
  const attentionPlans = state.plans.filter((plan) => plan.status === "attention" || plan.status === "failed").length;
  const runningAssignments = state.plans.flatMap((plan) => plan.assignments).filter((assignment) => assignment.status === "queued" || assignment.status === "running").length;
  const completedPlans = state.plans.filter((plan) => plan.status === "completed").length;

  const parts = [`${colorize(GLYPH_TASKED_SUBAGENTS, "accent", theme)} ${bold("tasked", theme)}`];
  if (activePlans) parts.push(colorize(plural(activePlans, "active plan"), "accent", theme));
  if (runningAssignments) parts.push(colorize(plural(runningAssignments, "running task"), "accent", theme));
  if (attentionPlans) parts.push(colorize(plural(attentionPlans, "attention"), "warning", theme));
  if (completedPlans) parts.push(colorize(plural(completedPlans, "done"), "success", theme));
  if (parts.length === 1) parts.push(colorize(plural(state.plans.length, "plan"), "muted", theme));
  return parts.join(dim(" · ", theme));
}
