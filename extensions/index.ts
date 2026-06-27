// ──────────────────────────────────────────────
// pi-tasked-subagents extension entrypoint
// ──────────────────────────────────────────────

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  InputSource,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { COMMAND_NAME, TOOL_NAME } from "../src/defaults.js";
import { shortTitle } from "../src/utils/text.js";
import { listAvailableAgentProfiles } from "../src/launcher/agent-profiles.js";
import {
  buildHelpText,
  formatAgentsReport,
  formatCancelAcknowledgement,
  formatClearAcknowledgement,
  formatContinueAcknowledgement,
  formatInspectReport,
  formatResolveAcknowledgement,
  formatResultReport,
  resolveResultAssignmentId,
  formatStatusReport,
  formatStopAcknowledgement,
  parseCommand,
  parseDispatchArgs,
} from "../src/orchestration/commands.js";
import { TaskedSubagentsController } from "../src/orchestration/controller.js";
import { routeInput } from "../src/orchestration/input-router.js";
import { restoreStateFromSessionEntries } from "../src/state/persistence.js";
import { registerMessageRenderers, statusLabel } from "../src/ui/messages.js";

const NonEmptyString = Type.String({ minLength: 1 });
const COLLAPSED_TOOL_RESULT_WIDTH = 120;
const COLLAPSED_TOOL_CALL_WIDTH = 120;
const NO_TOOL_OUTPUT_PREVIEW = `${TOOL_NAME} no output`;

function objectRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sessionEntryCustomType(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || !("customType" in entry)) return undefined;
  return typeof entry.customType === "string" ? entry.customType : undefined;
}

function sessionEntryData(entry: unknown): unknown {
  if (!entry || typeof entry !== "object" || !("data" in entry)) return undefined;
  return entry.data;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return objectRecord(parsed);
  } catch {
    return undefined;
  }
}

function taskReportPreview(text: string): string | undefined {
  const input = parseJsonObject(text);
  if (!input) return undefined;
  const summary = stringField(input, "summary");
  const status = stringField(input, "status");
  if (!summary && !status) return undefined;
  return [
    status ? statusLabel(status) : undefined,
    stringField(input, "taskId") ?? stringField(input, "assignmentId") ?? stringField(input, "taskRunId"),
    summary,
  ].filter(Boolean).join(" · ");
}

function agentListPreview(text: string): string | undefined {
  if (!text.startsWith("Available subagent profiles:")) return undefined;
  const count = text.split(/\r?\n/u).filter((line) => /^\s*-\s+\S/u.test(line)).length;
  return count > 0 ? `Available subagent profiles · ${count} ${count === 1 ? "agent" : "agents"}` : "Available subagent profiles";
}

function collapsedToolResultText(text: string): string {
  const preview = taskReportPreview(text) ?? agentListPreview(text) ?? text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? NO_TOOL_OUTPUT_PREVIEW;
  return shortTitle(preview, COLLAPSED_TOOL_RESULT_WIDTH);
}

function toolCallTarget(input: Record<string, unknown>, action: string | undefined): string | undefined {
  return stringField(input, "assignmentId")
    ?? stringField(input, "targetId")
    ?? stringField(input, "taskRunId")
    ?? stringField(input, "groupId")
    ?? stringField(input, "taskId")
    ?? (action === "set_tasks" ? stringField(input, "title") ?? stringField(input, "request") : undefined);
}

function collapsedToolCallText(args: unknown): string {
  const input = objectRecord(args);
  const action = input ? stringField(input, "action") ?? "status" : "status";
  const target = input ? toolCallTarget(input, action) : undefined;
  return shortTitle([TOOL_NAME, action, target].filter(Boolean).join(" "), COLLAPSED_TOOL_CALL_WIDTH);
}

const TaskInputSchema = Type.Object({
  id: Type.Optional(NonEmptyString),
  group: Type.Optional(NonEmptyString),
  text: NonEmptyString,
  criteria: Type.Array(NonEmptyString, { minItems: 1 }),
  dependsOn: Type.Optional(Type.Array(NonEmptyString)),
  agentHint: Type.Optional(NonEmptyString),
  filesHint: Type.Optional(Type.Array(NonEmptyString)),
  cwd: Type.Optional(NonEmptyString),
  retries: Type.Optional(Type.Integer({ minimum: 0 })),
  outputMode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
  outputSchema: Type.Optional(NonEmptyString),
  when: Type.Optional(NonEmptyString),
});

const TaskGroupInputSchema = Type.Object({
  id: NonEmptyString,
  title: Type.Optional(NonEmptyString),
  dependsOn: Type.Optional(Type.Array(NonEmptyString)),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
  agentHint: Type.Optional(NonEmptyString),
  filesHint: Type.Optional(Type.Array(NonEmptyString)),
});

const ToolParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("help"),
    Type.Literal("status"),
    Type.Literal("inspect"),
    Type.Literal("result"),
    Type.Literal("set_tasks"),
    Type.Literal("edit_task"),
    Type.Literal("edit_group"),
    Type.Literal("dispatch"),
    Type.Literal("continue"),
    Type.Literal("resolve"),
    Type.Literal("stop"),
    Type.Literal("cancel"),
    Type.Literal("clear"),
    Type.Literal("list_agents"),
  ], { default: "status" }),
  targetId: Type.Optional(NonEmptyString),
  taskRunId: Type.Optional(NonEmptyString),
  groupId: Type.Optional(NonEmptyString),
  taskId: Type.Optional(NonEmptyString),
  assignmentId: Type.Optional(NonEmptyString),
  request: Type.Optional(NonEmptyString),
  title: Type.Optional(NonEmptyString),
  context: Type.Optional(NonEmptyString),
  groups: Type.Optional(Type.Array(TaskGroupInputSchema, { minItems: 1 })),
  tasks: Type.Optional(Type.Array(TaskInputSchema, { minItems: 1 })),
  group: Type.Optional(Type.Partial(TaskGroupInputSchema)),
  task: Type.Optional(Type.Partial(TaskInputSchema)),
  prompt: Type.Optional(NonEmptyString),
  details: Type.Optional(Type.Boolean()),
  scope: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("all")], { default: "completed" })),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
});

export default function taskedSubagentsExtension(pi: ExtensionAPI): void {
  const controller = new TaskedSubagentsController(pi);
  registerMessageRenderers(pi);

  pi.on("input", (event, ctx) => {
    const decision = routeInput(event.text, event.source as InputSource | undefined, controller, ctx);
    return decision.action === "handled" ? { action: "handled" as const } : { action: "continue" as const };
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    const restored = restoreStateFromSessionEntries(entries.map((entry) => ({
      type: entry.type,
      customType: sessionEntryCustomType(entry),
      data: sessionEntryData(entry),
    })));
    controller.restoreState(restored);
    controller.updateUI(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    const restored = restoreStateFromSessionEntries(entries.map((entry) => ({
      type: entry.type,
      customType: sessionEntryCustomType(entry),
      data: sessionEntryData(entry),
    })));
    controller.restoreState(restored);
    controller.updateUI(ctx);
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Tasked subagents",
    description: "Store validated task runs as groups and tasks, then dispatch ready task assignments to background subagents.",
    promptSnippet: "Use tasked_subagents for validated subagent delegation. After decomposing work, call set_tasks with tasks and optional groups. Every subagent assignment executes exactly one task.",
    promptGuidelines: [
      "Let ordinary user messages stay in the main session context; do not rely on hidden interception.",
      "Use set_tasks after validation; every task contains concrete criteria and may belong to a group.",
      "Use a one-task task run for one-off delegation.",
      "Use dispatch to schedule ready task assignments for an existing task run.",
      "Use edit_task or edit_group with targetId plus a patch for targeted validated changes.",
      "After set_tasks, edit_task, edit_group, or dispatch, do not poll immediately; wait for the automatic completion/attention/failure follow-up signal.",
      "Use status for human-requested health checks, suspected stalls, or after about 60s with no signal.",
      "Use result with an assignmentId, or with a taskRunId/groupId/taskId only when it maps to one assignment, after a terminal follow-up signal or explicit human request.",
      "Use resolve with targetId and prompt after fixing an attention/failure finding; the verification assignment decides whether the target is complete.",
      "Use continue, stop, and cancel to manage task assignments.",
      "Use list_agents to discover available subagent profile names before choosing an agentHint.",
    ],
    parameters: ToolParamsSchema,
    renderCall(args, theme) {
      return new Text(theme.fg("dim", collapsedToolCallText(args)), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "tasked_subagents running…"), 0, 0);
      const text = result.content
        ?.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
      return new Text(expanded && text ? text : collapsedToolResultText(text ?? ""), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? "status";
      let text: string;

      switch (action) {
        case "help":
          text = buildHelpText();
          break;
        case "status":
          text = formatStatusReport(controller.getState(), params.targetId ?? params.taskRunId ?? params.groupId ?? params.taskId ?? params.assignmentId);
          break;
        case "inspect": {
          const target = params.targetId ?? params.taskRunId ?? params.groupId ?? params.taskId ?? params.assignmentId;
          text = target ? formatInspectReport(controller.getState(), target) : buildHelpText();
          break;
        }
        case "result": {
          const target = params.assignmentId ?? params.targetId ?? params.taskId ?? params.groupId ?? params.taskRunId;
          if (!target) {
            text = buildHelpText();
            break;
          }
          const assignmentId = resolveResultAssignmentId(controller.getState(), target);
          text = assignmentId ? await controller.getRunResult(assignmentId) ?? formatResultReport(controller.getState(), assignmentId) : formatResultReport(controller.getState(), target);
          break;
        }
        case "set_tasks": {
          if (!params.tasks) {
            text = "set_tasks requires tasks.";
            break;
          }
          const accepted = await controller.setTasks({
            taskRunId: params.taskRunId,
            request: params.request,
            title: params.title,
            context: params.context,
            groups: params.groups,
            tasks: params.tasks,
            maxConcurrency: params.maxConcurrency,
          }, ctx);
          text = accepted.accepted
            ? `Accepted task run ${accepted.taskRunId}; task assignments are running in the background. Do not poll; wait for the automatic completion/attention/failure follow-up signal.`
            : `Task run rejected:\n${accepted.errors.join("\n")}`;
          break;
        }
        case "edit_task": {
          const targetId = params.targetId ?? params.taskId ?? params.assignmentId;
          if (!targetId || !params.task) {
            text = "edit_task requires targetId or taskId, plus task.";
            break;
          }
          const edited = await controller.editTask({ taskRunId: params.taskRunId, targetId, task: params.task }, ctx);
          text = edited.edited
            ? `Edited ${edited.taskId ?? targetId}; affected task assignments are running in the background. Do not poll; wait for the automatic completion/attention/failure follow-up signal.`
            : `Task edit rejected:\n${edited.errors.join("\n")}`;
          break;
        }
        case "edit_group": {
          const targetId = params.targetId ?? params.groupId;
          if (!targetId || !params.group) {
            text = "edit_group requires targetId or groupId, plus group.";
            break;
          }
          const edited = await controller.editGroup({ taskRunId: params.taskRunId, targetId, group: params.group }, ctx);
          text = edited.edited
            ? edited.dispatchScheduled
              ? `Edited ${edited.groupId ?? targetId}; affected task assignments are running in the background. Do not poll; wait for the automatic completion/attention/failure follow-up signal.`
              : `Edited ${edited.groupId ?? targetId}.`
            : `Group edit rejected:\n${edited.errors.join("\n")}`;
          break;
        }
        case "dispatch": {
          const result = await controller.dispatchReady({ taskRunId: params.taskRunId, maxConcurrency: params.maxConcurrency, ctx });
          text = `Dispatched ${result.launched} task assignment(s), skipped ${result.skipped}.`;
          if (result.errors.length > 0) text += `\n${result.errors.join("\n")}`;
          break;
        }
        case "continue": {
          const target = params.targetId ?? params.taskId ?? params.assignmentId ?? params.groupId ?? params.taskRunId;
          if (!target || !params.prompt) {
            text = buildHelpText();
            break;
          }
          const continued = await controller.continueTarget(target, params.prompt, ctx);
          text = continued ? formatContinueAcknowledgement(target, params.prompt) : `Could not continue ${target}.`;
          break;
        }
        case "resolve": {
          const target = params.targetId ?? params.taskId ?? params.assignmentId ?? params.groupId ?? params.taskRunId;
          if (!target || !params.prompt) {
            text = buildHelpText();
            break;
          }
          const resolved = await controller.resolveTarget(target, params.prompt, ctx);
          text = resolved ? formatResolveAcknowledgement(target, params.prompt) : `Could not resolve ${target}.`;
          break;
        }
        case "stop": {
          const assignmentId = params.assignmentId ?? params.targetId;
          if (!assignmentId) {
            text = buildHelpText();
            break;
          }
          const stopped = await controller.stopRun(assignmentId);
          text = stopped ? formatStopAcknowledgement(assignmentId) : `Could not stop ${assignmentId}.`;
          break;
        }
        case "cancel": {
          const assignmentId = params.assignmentId ?? params.targetId;
          if (!assignmentId) {
            text = buildHelpText();
            break;
          }
          const cancelled = await controller.cancelRun(assignmentId);
          text = cancelled ? formatCancelAcknowledgement(assignmentId) : `Could not cancel ${assignmentId}.`;
          break;
        }
        case "clear": {
          const count = await controller.clear(params.scope ?? "completed");
          text = formatClearAcknowledgement(count);
          break;
        }
        case "list_agents":
          text = formatAgentsReport(listAvailableAgentProfiles(), { details: params.details });
          break;
      }

      return { content: [{ type: "text", text }], details: { action } };
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Manage tasked subagent task runs: status, inspect, result, agents, continue, resolve, stop, cancel, clear.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parsed = parseCommand(args);
      let output: string;
      switch (parsed.action) {
        case "help":
          output = buildHelpText();
          break;
        case "status":
          output = formatStatusReport(controller.getState(), parsed.targetId);
          break;
        case "inspect":
          output = parsed.targetId ? formatInspectReport(controller.getState(), parsed.targetId) : buildHelpText();
          break;
        case "result": {
          if (!parsed.assignmentId) {
            output = buildHelpText();
            break;
          }
          const assignmentId = resolveResultAssignmentId(controller.getState(), parsed.assignmentId);
          output = assignmentId ? await controller.getRunResult(assignmentId) ?? formatResultReport(controller.getState(), assignmentId) : formatResultReport(controller.getState(), parsed.assignmentId);
          break;
        }
        case "continue": {
          if (!parsed.targetId || !parsed.prompt) {
            output = buildHelpText();
            break;
          }
          const continued = await controller.continueTarget(parsed.targetId, parsed.prompt, ctx);
          output = continued ? formatContinueAcknowledgement(parsed.targetId, parsed.prompt) : `Could not continue ${parsed.targetId}.`;
          break;
        }
        case "resolve": {
          if (!parsed.targetId || !parsed.prompt) {
            output = buildHelpText();
            break;
          }
          const resolved = await controller.resolveTarget(parsed.targetId, parsed.prompt, ctx);
          output = resolved ? formatResolveAcknowledgement(parsed.targetId, parsed.prompt) : `Could not resolve ${parsed.targetId}.`;
          break;
        }
        case "stop": {
          if (!parsed.assignmentId) {
            output = buildHelpText();
            break;
          }
          const stopped = await controller.stopRun(parsed.assignmentId);
          output = stopped ? formatStopAcknowledgement(parsed.assignmentId) : `Could not stop ${parsed.assignmentId}.`;
          break;
        }
        case "cancel": {
          if (!parsed.assignmentId) {
            output = buildHelpText();
            break;
          }
          const cancelled = await controller.cancelRun(parsed.assignmentId);
          output = cancelled ? formatCancelAcknowledgement(parsed.assignmentId) : `Could not cancel ${parsed.assignmentId}.`;
          break;
        }
        case "clear": {
          const count = await controller.clear(parsed.scope ?? "completed");
          output = formatClearAcknowledgement(count);
          break;
        }
        case "agents":
          output = formatAgentsReport(listAvailableAgentProfiles(), { details: parsed.details });
          break;
        case "dispatch": {
          const dispatchArgs = parseDispatchArgs(parsed.args);
          if (dispatchArgs.errors.length > 0) {
            output = `Dispatch rejected:\n${dispatchArgs.errors.join("\n")}`;
            break;
          }
          const result = await controller.dispatchReady({ taskRunId: dispatchArgs.taskRunId, maxConcurrency: dispatchArgs.maxConcurrency, ctx });
          output = `Dispatched ${result.launched} task assignment(s), skipped ${result.skipped}.`;
          if (result.errors.length > 0) output += `\n${result.errors.join("\n")}`;
          break;
        }
      }

      if (ctx.mode === "tui") ctx.ui.notify(output.slice(0, 500), "info");
      else pi.sendUserMessage(output);
    },
  });
}
