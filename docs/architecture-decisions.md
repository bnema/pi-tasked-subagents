# Architecture decisions — pi-tasked-subagents

This document describes the current target architecture for the unreleased v0 package.

## TaskRun task assignment model

**Decision.** The product model is `TaskRun → Group → Task → Assignment → Evidence`.

- A `TaskRun` is the root orchestration record for one delegated body of work.
- A group is an optional scheduling section for dependencies, display, and concurrency.
- A task is the only unit of work assigned to a subagent.
- An assignment represents one launched subagent attempt for one task.
- A replacement assignment atomically supersedes prior attempts for that task. Superseded attempts remain directly inspectable as audit history but do not affect current scheduling, evidence, artifacts, status, or default UI rows.
- Evidence maps the authoritative assignment output back to task criteria.

**Rationale.** Main-agent coordination should stay simple and flat. Groups provide enough structure for dependency and concurrency control without exposing recursive subtasks or executable phases.

## Bounded v5 state ownership

**Decision.** Pi owns only append-only `pi-tasked-subagents:state` entries containing v5 checkpoint pointers. Each pointer is at most 4 KiB and contains a checkpoint digest, sequence, timestamp, and optional current TaskRun id; it contains no filesystem path, complete TaskRun, or raw result output.

`pi-tasked-subagents` owns the referenced immutable, content-addressed objects and result files in a private application-data root. On Linux the root is `$XDG_DATA_HOME/pi-tasked-subagents/`, falling back to `~/.local/share/pi-tasked-subagents/`; tests inject a temporary root. Checkpoint manifests are limited to 256 KiB, recoverable TaskRun objects to 2 MiB, and assignment archives to 256 KiB. A checkpoint contains at most 100 recoverable TaskRuns, 1,000 recent assignment references, and the newest 20 completed summaries.

Transient runner display fields update memory and UI but do not create checkpoints. Durable structural and terminal mutations write referenced objects before appending a pointer. Repeated durable projections are deduplicated.

**Rationale.** Small pointers bound Pi resume cost, while immutable external objects retain recoverable state without embedding output in the session.

## Branch restoration and retention

**Decision.** The newest fully valid v5 pointer on the selected branch restores the complete checkpoint. Pi `/tree` navigation selects the immutable checkpoint from that branch; restoration never combines generations. If the newest graph is missing, corrupt, the wrong type, or over its limit, restoration tries an earlier branch pointer and reports diagnostics rather than silently resetting state.

The session reference index includes checkpoint ids visible across all branches. Their object graphs remain pinned so exact branch rollback stays reliable. Unreferenced temporary or orphan objects become eligible for cleanup after 24 hours. `clear` removes logical state immediately, but physical data is deleted only when no session reference index pins it. Immutable authoritative results remain retained until explicit clear or maintenance. Cleanup never follows or deletes paths outside the configured data root.

**Rationale.** Exact indefinite rollback and a fixed total external-storage quota are incompatible. Branch correctness takes priority; storage grows with meaningful durable transitions rather than repeated full snapshots.

## Completed history and immutable results

**Decision.** Normal status presents active or actionable state plus at most the newest 20 completed TaskRun summaries. Terminal assignment metadata is stored in bounded immutable archives, while raw output is stored only in immutable session-scoped result files under random result identities.

`result <assignmentId>` hashes the requested assignment id, verifies archive identity and digest, and loads only the referenced authoritative result file. A known result remains discoverable after its TaskRun leaves recent history. The selected checkpoint's archive reference wins; otherwise multiple branch archives require explicit archive-id disambiguation. TaskRun, group, and task result targets work only when they resolve unambiguously.

**Rationale.** Bounded summaries keep ordinary state small. Lazy, identity-checked result lookup preserves detailed output without loading unrelated TaskRuns or copying raw output into Pi state.

## Session recovery

**Decision.** A normally loadable v4 branch is converted once through the same bounded object and result-ingestion rules, then receives one v5 pointer. An oversized JSONL session is recovered with the standalone `recover-session` command while Pi is closed. The command streams one record at a time, preserves unrelated records, writes a distinct output file, removes incomplete output on failure, and reports only counts and byte totals.

Operators back up the source, check free disk space, run recovery with Pi closed, review the command output, and explicitly open the generated file with `pi --session`. The source and backup remain untouched until the recovered session is verified.

**Rationale.** Pi must parse a session before an extension can load, so recovery for an oversized file cannot depend on Pi startup. A streaming, source-preserving command keeps memory use and privacy exposure bounded.

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

**Decision.** v0 keeps a local direct runner. Before launch, the adapter reserves a cryptographically random 128-bit result identity in the session-scoped application-data directory. The runner reads a JSON config, launches child Pi processes, writes transient progress snapshots, and atomically publishes one immutable terminal result. Concurrent completion or cancellation writers cannot replace the winning result.

**Rationale.** An immutable result file gives the parent controller one authoritative output channel and prevents divergent branches or terminal races from overwriting result content.

## Task acceptance, patching, and dispatch

**Decision.** The primary flow is tool-driven:

1. ordinary chat stays with the main session;
2. the main agent and user validate a task breakdown;
3. the agent calls `set_tasks` with flat tasks and optional groups;
4. the controller stores or replaces the `TaskRun`;
5. the scheduler creates ready task assignments;
6. the launcher runs the assignments;
7. the reducer applies task reports and evidence;
8. the agent calls `patch_task_run`, or an expansion-enabled task returns `taskRunPatch`, when newly discovered tasks should be appended to the same visible TaskRun.

**Validation.** A task run is rejected when it lacks tasks, lacks task-run metadata, contains groups without tasks, tasks without criteria, duplicate ids, unknown dependencies, invalid retry/concurrency settings, invalid expansion modes, or dependency cycles.

TaskRun patches are append-first. A patch may add new groups or new task ids, but it cannot silently replace an existing task. Existing task changes use `edit_task` so assignment history is handled explicitly.

## Scheduler semantics

**Decision.** The scheduler derives task readiness from task-run state.

- Group dependencies must complete before tasks in the dependent group can run.
- Task dependencies must complete before the dependent task can run.
- Tasks in a group run sequentially by default because `group.maxConcurrency` defaults to `1`.
- `maxConcurrency` on a group allows independent tasks in that group to run in parallel.
- Ungrouped tasks are governed only by explicit task dependencies and task-run concurrency.
- Failed, blocked, cancelled, or attention tasks block dependents.

**Rationale.** Groups remain scheduling-only product structure, while task assignments are the concrete subagent work units.

## Task report, evidence, and expansion semantics

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
- optional `taskRunPatch` only when the task has `expansionMode: "append_tasks"` and the report status is `completed`

**Rationale.** Criterion-level evidence keeps completion auditable. Optional group ids let ungrouped tasks report cleanly without placeholder values.

Expansion is visible by construction. A triage task can append new groups or tasks, but new groups are stored in `taskRun.groups` and new tasks are stored in `taskRun.tasks` before any subagent assignment runs for the new tasks. Duplicate task ids, malformed patch arrays, malformed patch entries, unknown dependencies, and dependency cycles are rejected safely.

## Public API actions

**Decision.** The public tool actions are task-run-first:

- `set_tasks`
- `edit_task`
- `edit_group`
- `patch_task_run`
- `dispatch`
- `status`
- `inspect`
- `result`
- `attach`
- `continue`
- `resolve`
- `ack`
- `stop`
- `cancel`
- `clear`
- `list_agents`

Public target ids are `taskRunId`, `groupId`, `taskId`, and `assignmentId`.

**Rationale.** These names match the persisted model and avoid compatibility aliases that would keep plan/phase vocabulary alive.

`ack` is a zero-subagent acknowledgement that an `attention`/`failed`/`blocked`/`paused` finding was resolved externally (by the main agent or a later run). It cascades over the target's descendants: eligible tasks and assignments become `completed` with a persisted `resolvedExternally` audit trail, while never-started descendants are `cancelled`/`skipped` rather than marked done; running descendants block the ack. Use `resolve` instead when independent re-verification is wanted. While unresolved stale `attention`/`failed` runs exist, an end-of-turn reminder (`agent_settled`) prompts the main agent to `ack` or `resolve` each one, at most once per run per session segment.

## UI and messages

**Decision.** UI surfaces show task runs, groups, tasks, authoritative assignments, and criteria progress. Superseded attempts are collapsed into a history count in aggregate views and remain available by direct assignment id. Background work emits one completion/attention/failure message only when its TaskRun becomes terminal; awaited work returns its report directly without queuing another agent turn. Targeted mutations select their TaskRun for the compact widget, while `inspect` includes a full checklist view for the selected TaskRun.

**Rationale.** Status output should reinforce the product model and make recovery actions obvious.

## Custom session entry types

| Type | Purpose |
|---|---|
| `pi-tasked-subagents:state` | bounded v5 pointer to an immutable external checkpoint |
| `pi-tasked-subagents:completion` | task-run completion follow-up |
| `pi-tasked-subagents:attention` | attention follow-up |
| `pi-tasked-subagents:attention-reminder` | end-of-turn reminder to ack/resolve stale attention runs |
| `pi-tasked-subagents:failure` | failure/cancellation follow-up |
