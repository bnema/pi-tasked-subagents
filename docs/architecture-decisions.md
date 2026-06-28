# Architecture decisions — pi-tasked-subagents

This document describes the current target architecture for the unreleased v0 package.

## TaskRun task assignment model

**Decision.** The product model is `TaskRun → Group → Task → Assignment → Evidence`.

- A `TaskRun` is the root orchestration record for one delegated body of work.
- A group is an optional scheduling section for dependencies, display, and concurrency.
- A task is the only unit of work assigned to a subagent.
- An assignment represents one launched subagent attempt for one task.
- Evidence maps assignment output back to task criteria.

**Rationale.** Main-agent coordination should stay simple and flat. Groups provide enough structure for dependency and concurrency control without exposing recursive subtasks or executable phases.

## Clean v4 state

**Decision.** The state shape is v4 and contains `taskRuns`, the current task-run id, and timestamps. Older plan/phase development snapshots are reset instead of migrated.

**Rationale.** The plugin is unreleased. Compatibility code would preserve the old conceptual model and make the task-run refactor harder to reason about.

## Removed legacy concepts

**Decision.** One-off background work is represented as a one-group, one-task `TaskRun`. There are no public quick actions or slash-command run aliases.

Removed public concepts include:

- standalone ad-hoc run actions outside a task run;
- standalone parallel-run actions outside a task run;
- standalone workflow actions outside a task run;
- phase-as-workflow dispatch as product language;
- group-level report synthesis as the primary report contract.

**Rationale.** Subagents should always receive a task with criteria, not an arbitrary prompt. Keeping separate quick concepts would fracture state, UI, command handling, and documentation.

## Task graph launcher boundary

**Decision.** The controller-facing launcher exposes `launchTaskGraph(request, ctx)`. Each graph entry is a task assignment with task-run, optional group, task, assignment, agent, prompt, dependencies, retry options, and output settings.

**Rationale.** The runner can still use DAG scheduling internally for dependencies and concurrency, but the rest of the plugin should speak task-assignment language.

## Runner integration strategy

**Decision.** v0 keeps a local direct runner adapted from the earlier lazy-subagents runner. The runner reads a JSON config, launches child Pi processes, writes progress snapshots, and writes a result file.

**Rationale.** Result-file delivery gives the parent controller one authoritative channel for subagent output. It is easier to test and avoids races between stdout, custom session entries, and direct parent-state mutation.

## Task acceptance and dispatch

**Decision.** The primary flow is tool-driven:

1. ordinary chat stays with the main session;
2. the main agent and user validate a task breakdown;
3. the agent calls `set_tasks` with flat tasks and optional groups;
4. the controller stores or replaces the `TaskRun`;
5. the scheduler creates ready task assignments;
6. the launcher runs the assignments;
7. the reducer applies task reports and evidence.

**Validation.** A task run is rejected when it lacks tasks, lacks task-run metadata, contains groups without tasks, tasks without criteria, duplicate ids, unknown dependencies, invalid retry/concurrency settings, or dependency cycles.

## Scheduler semantics

**Decision.** The scheduler derives task readiness from task-run state.

- Group dependencies must complete before tasks in the dependent group can run.
- Task dependencies must complete before the dependent task can run.
- Tasks in a group run sequentially by default because `group.maxConcurrency` defaults to `1`.
- `maxConcurrency` on a group allows independent tasks in that group to run in parallel.
- Ungrouped tasks are governed only by explicit task dependencies and task-run concurrency.
- Failed, blocked, cancelled, or attention tasks block dependents.

**Rationale.** Groups remain scheduling-only product structure, while task assignments are the concrete subagent work units.

## Task report and evidence semantics

**Decision.** Subagents return `SubagentTaskReport` JSON for exactly one assignment.

Required report fields:

- `taskRunId`
- optional `groupId`
- `taskId`
- `assignmentId`
- `status`: `completed`, `attention`, or `failed`
- `summary`
- `criteriaEvidence`
- optional `artifacts`
- optional `followUps`

**Rationale.** Criterion-level evidence keeps completion auditable. Optional group ids let ungrouped tasks report cleanly without placeholder values.

## Public API actions

**Decision.** The public tool actions are task-run-first:

- `set_tasks`
- `edit_task`
- `edit_group`
- `dispatch`
- `status`
- `inspect`
- `result`
- `continue`
- `resolve`
- `stop`
- `cancel`
- `clear`
- `list_agents`

Public target ids are `taskRunId`, `groupId`, `taskId`, and `assignmentId`.

**Rationale.** These names match the persisted model and avoid compatibility aliases that would keep plan/phase vocabulary alive.

## UI and messages

**Decision.** UI surfaces show task runs, groups, tasks/subtasks, assignments, and criteria progress. Completion/attention/failure messages identify the task run and assignment run rather than presenting generic background execution.

**Rationale.** Status output should reinforce the product model and make recovery actions obvious.

## Custom session entry types

| Type | Purpose |
|---|---|
| `pi-tasked-subagents:state` | serialized v4 task-run state |
| `pi-tasked-subagents:completion` | task-run completion follow-up |
| `pi-tasked-subagents:attention` | attention follow-up |
| `pi-tasked-subagents:failure` | failure/cancellation follow-up |
