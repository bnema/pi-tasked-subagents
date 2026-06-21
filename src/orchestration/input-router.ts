// ──────────────────────────────────────────────
// input-router: opt-in input interception for
// pi-tasked-subagents
//
// Decides whether a user input should be:
// - "continue"  – pass through unchanged (ordinary chat, slash commands,
//   skill/template expansions, extension-sourced recovery messages, empty/control input)
// - "handled"   – explicitly opted into tasked-subagents orchestration
// ──────────────────────────────────────────────

import type { ExtensionContext, InputSource } from "@earendil-works/pi-coding-agent";

import type { TaskedSubagentsController } from "./controller.js";

// ── Public types ───────────────────────────────

export type RoutingAction = "continue" | "handled";

export interface InputRoutingDecision {
  action: RoutingAction;
}

const EXPLICIT_TRIGGER_PATTERNS = [
  /^@tasked-subagents\s+(.+)$/isu,
  /^tasked-subagents:\s*(.+)$/isu,
  /^tasked\s+subagents:\s*(.+)$/isu,
];

/**
 * Extract an explicit tasked-subagents request from freeform input.
 *
 * Ordinary chat is never intercepted. Freeform input is handled only
 * when the user intentionally prefixes it with one of:
 *
 * - `@tasked-subagents <request>`
 * - `tasked-subagents: <request>`
 * - `tasked subagents: <request>`
 */
export function extractTaskedSubagentsRequest(text: string): string | undefined {
  const trimmed = text.trim();
  for (const pattern of EXPLICIT_TRIGGER_PATTERNS) {
    const match = pattern.exec(trimmed);
    const request = match?.[1]?.trim();
    if (request) return request;
  }
  return undefined;
}

// ── Router ─────────────────────────────────────

/**
 * Route a user input through the interception pipeline.
 *
 * Rules (conservative first-match):
 *
 * 1. Empty / whitespace-only      → continue
 * 2. `source === "extension"`     → continue
 *    (covers sendUserMessage recovery, plugin-injected messages,
 *     and subagent completion/attention reports – prevents loops)
 * 3. Starts with `/`               → continue
 *    (slash commands, /skill:*, /template, built-in commands)
 * 4. Explicit tasked-subagents prefix → handled
 * 5. Ordinary freeform chat        → continue
 */
export function routeInput(
  text: string,
  source: InputSource | undefined,
  controller: TaskedSubagentsController,
  ctx?: ExtensionContext,
): InputRoutingDecision {
  if (!text || !text.trim()) {
    return { action: "continue" };
  }

  if (source === "extension") {
    return { action: "continue" };
  }

  const trimmed = text.trim();

  if (trimmed.startsWith("/")) {
    return { action: "continue" };
  }

  const request = extractTaskedSubagentsRequest(trimmed);
  if (!request) {
    return { action: "continue" };
  }

  if (ctx) controller.handleUserAsk(request, ctx);
  else controller.handleUserAsk(request);

  return { action: "handled" };
}
