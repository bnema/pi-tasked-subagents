import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentProfile {
  name: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  thinking?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
}

const DEFAULT_TOOLS = ["read", "bash", "grep", "find", "ls", "diagnostics", "code_search"];
const EDIT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "diagnostics", "code_search"];

const BUILTIN_PROFILES: Record<string, AgentProfile> = {
  coordinator: {
    name: "coordinator",
    systemPrompt: "You are a task-run coordinator. Return only the requested structured JSON response.",
    tools: DEFAULT_TOOLS,
  },
  delegate: {
    name: "delegate",
    systemPrompt: "You are a delegated Pi child session. Complete the assigned task autonomously with the provided tools. Stay tightly scoped and return the requested final result.",
    tools: EDIT_TOOLS,
  },
  worker: {
    name: "worker",
    systemPrompt: "You are an implementation child session. Make the requested changes, validate them when practical, and return the requested final result.",
    tools: EDIT_TOOLS,
  },
  reviewer: {
    name: "reviewer",
    systemPrompt: "You are a review child session. Inspect carefully and report concise evidence-backed findings. Do not edit files.",
    tools: DEFAULT_TOOLS,
  },
};

function profileDirs(): string[] {
  return [path.join(os.homedir(), ".agents", "agents"), path.join(os.homedir(), ".pi", "agent", "agents")];
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeTools(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function parseProfile(filePath: string): AgentProfile | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
    const name = normalizeText(frontmatter.name) ?? path.basename(filePath, path.extname(filePath));
    const systemPrompt = body.trim();
    if (!name || !systemPrompt) return undefined;
    return {
      name,
      systemPrompt,
      tools: normalizeTools(frontmatter.tools),
      model: normalizeText(frontmatter.model),
      thinking: normalizeText(frontmatter.thinking),
      systemPromptMode: normalizeText(frontmatter.systemPromptMode) === "replace" ? "replace" : "append",
      inheritProjectContext: typeof frontmatter.inheritProjectContext === "boolean" ? frontmatter.inheritProjectContext : undefined,
      inheritSkills: typeof frontmatter.inheritSkills === "boolean" ? frontmatter.inheritSkills : undefined,
    };
  } catch {
    return undefined;
  }
}

export function listAvailableAgentProfiles(): AgentProfile[] {
  const profiles = new Map<string, AgentProfile>();
  for (const profile of Object.values(BUILTIN_PROFILES)) {
    profiles.set(profile.name, profile);
  }

  for (const dir of profileDirs()) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const profile = parseProfile(path.join(dir, entry.name));
        if (profile) profiles.set(profile.name, profile);
      }
    } catch {
      // ignore missing dirs
    }
  }

  return [...profiles.values()].sort((left, right) => left.name.localeCompare(right.name));
}

let cachedProfilesByName: Map<string, AgentProfile> | undefined;

function getCachedProfilesByName(): Map<string, AgentProfile> {
  cachedProfilesByName ??= new Map(listAvailableAgentProfiles().map((profile) => [profile.name, profile]));
  return cachedProfilesByName;
}

export function getAgentProfile(agentName: string | undefined): AgentProfile {
  const name = agentName?.trim() || "delegate";
  return getCachedProfilesByName().get(name) ?? { ...BUILTIN_PROFILES.delegate, name };
}
