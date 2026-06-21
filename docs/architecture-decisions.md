# Architecture decisions — pi-tasked-subagents

This document describes the current target architecture for the unreleased v0 package.

## Plan-first task assignment model

**Decision.** The product model is `Plan → Phase → Task → Assignment → Evidence`.

- A plan contains phases.
- A phase contains tasks.
- A task is the only unit of work assigned to a subagent.
- An assignment represents one launched subagent attempt for one task.
- Evidence maps assignment output back to task criteria.

**Rationale.** This package merges the useful parts of two earlier projects: `pi-tasked-phases` supplied validated specs, phases, tasks, criteria, and progress; `pi-lazy-subagents` supplied background execution, dependencies, result files, stop/cancel, and progress snapshots. The merged product should not expose those as competing modes. It should expose one plan-first coordination model.

## Clean v2 state

**Decision.** The state shape is v2 and contains only plans, the current plan id, and timestamps. Earlier development snapshots with asks, run registries, workflow runs, or quick-run owners are reset instead of migrated.

**Rationale.** The plugin is unreleased. Compatibility code would preserve the old conceptual split and make the refactor harder to reason about.

## Removed legacy concepts

**Decision.** One-off background work is represented as a one-phase, one-task plan. There are no public quick actions or slash-command run aliases.

Removed public concepts include:

- standalone ad-hoc run actions outside a plan;
- standalone parallel-run actions outside a plan;
- standalone workflow actions outside a plan;
- phase-as-workflow dispatch as product language;
- phase-level report synthesis as the primary report contract.

**Rationale.** Subagents should always receive a task, not an arbitrary prompt. Keeping separate quick concepts would fracture state, UI, command handling, and documentation.

## Task graph launcher boundary

**Decision.** The controller-facing launcher exposes `launchTaskGraph(request, ctx)`. Each graph entry is a task assignment with plan, phase, task, assignment, agent, prompt, dependencies, retry options, and output settings.

**Rationale.** The runner can still use DAG scheduling internally for dependencies and concurrency, but the rest of the plugin should speak task-assignment language.

## Runner integration strategy

**Decision.** v0 keeps a local direct runner adapted from the earlier lazy-subagents runner. The runner reads a JSON config, launches child Pi processes, writes progress snapshots, and writes a result file.

**Rationale.** Result-file delivery gives the parent controller one authoritative channel for subagent output. It is easier to test and avoids races between stdout, custom session entries, and direct parent-state mutation.

## Plan acceptance and dispatch

**Decision.** The primary flow is tool-driven:

1. ordinary chat stays with the main session;
2. the main agent and user validate a plan;
3. the agent calls `replace_plan`;
4. the controller stores the plan;
5. the scheduler creates ready task assignments;
6. the launcher runs the assignments;
7. the reducer applies task reports and evidence.

**Validation.** A plan is rejected when it has an empty spec, no phases, phases without tasks, tasks without criteria, duplicate ids, unknown dependencies, invalid retry settings, or dependency cycles.

## Scheduler semantics

**Decision.** The scheduler derives task readiness from plan state.

- Phase dependencies must complete before the dependent phase can run.
- Task dependencies must complete before the dependent task can run.
- Tasks in a phase run sequentially by default.
- `maxConcurrency` on a phase allows independent tasks in that phase to run in parallel.
- Failed, blocked, cancelled, or attention tasks block dependents.

**Rationale.** Phases remain first-class product structure, while task assignments are the concrete subagent work units.

## Task report and evidence semantics

**Decision.** Subagents return `SubagentTaskReport` JSON for exactly one assignment.

Required report fields:

- `planId`
- `phaseId`
- `taskId`
- `assignmentId`
- `status`: `completed`, `attention`, or `failed`
- `summary`
- `criteriaEvidence`
- optional `artifacts`
- optional `followUps`

`cancelled` is not a normal subagent report status. Cancellation is controller/assignment state when the runner is stopped or cancelled before a valid report exists.

**Validation rules.**

1. Report ids must match the owning assignment.
2. Evidence must be non-empty.
3. Criterion indexes must be unique.
4. Criterion indexes must be in bounds for the assigned task.
5. A completed report must cover every criterion.
6. Insufficient evidence puts the task into attention instead of silently completing it.

**Rationale.** Criteria-mapped evidence prevents vague completion claims and makes recovery explicit.

## Input-router bypass rules

**Decision.** The input router is opt-in. It handles only explicit freeform triggers:

- `@tasked-subagents <request>`
- `tasked-subagents: <request>`
- `tasked subagents: <request>`

It bypasses ordinary chat, slash commands, extension-originated input, and plugin-generated follow-up messages.

**Rationale.** Ordinary user messages belong to the main session unless the user explicitly opts into tasked-subagents orchestration.

## UI and messages

**Decision.** UI surfaces show plans, phases, tasks, assignments, and criteria progress. Completion/attention/failure messages identify the plan and assignment run rather than presenting generic background execution.

**Rationale.** Status output should reinforce the product model and make recovery actions obvious.

## Custom session entry types

| Type | Purpose |
|---|---|
| `pi-tasked-subagents:state` | serialized v2 plan state |
| `pi-tasked-subagents:completion` | task/plan completion follow-up |
| `pi-tasked-subagents:attention` | attention follow-up |
| `pi-tasked-subagents:failure` | failure/cancellation follow-up |

Launch and artifact renderers may exist in code as UI helpers, but the current controller emits only state and terminal follow-up entries.
