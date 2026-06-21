// ──────────────────────────────────────────────
// Persistence for plan-first tasked-subagents state
// ──────────────────────────────────────────────

import type { TaskedSubagentsState } from "../types.js";
import { ENTRY_TYPE_STATE } from "../defaults.js";
import { createEmptyState, deserializeState, ensureState, serializeState } from "./store.js";

export interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

export function restoreStateFromSessionEntries(entries: SessionEntry[]): TaskedSubagentsState {
  let foundData: unknown;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE_STATE && entry.data !== undefined && entry.data !== null) {
      foundData = entry.data;
    }
  }
  return foundData === undefined ? createEmptyState() : stateFromEntryData(foundData);
}

export function stateToEntryData(state: TaskedSubagentsState): unknown {
  return JSON.parse(serializeState(state));
}

export function stateFromEntryData(data: unknown): TaskedSubagentsState {
  if (typeof data === "string") return deserializeState(data);
  return ensureState(data);
}

export function buildStateEntryData(state: TaskedSubagentsState): object {
  return {
    version: state.version,
    plans: state.plans,
    currentPlanId: state.currentPlanId ?? null,
    updatedAt: state.updatedAt,
  };
}
