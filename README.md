# pi-tasked-subagents

Task-run subagent orchestration for Pi.

`pi-tasked-subagents` lets Pi store a visible TaskRun checklist, group tasks for scheduling, dispatch one task per background subagent, and collect criterion-based evidence before marking work complete.

The TaskRun is the source of truth: subagents never own hidden workflow steps. Every launched assignment is attached to a visible task in the checklist.

## Install

Install from GitHub:

```bash
pi install git:github.com/bnema/pi-tasked-subagents
```

Install from a local checkout:

```bash
pi install /path/to/pi-tasked-subagents
```

For local development:

```bash
pi -e /path/to/pi-tasked-subagents
```

## Plugin path

The Pi extension entrypoint is:

```text
./extensions/index.ts
```

It is declared in `package.json` as:

```json
{
  "pi": {
    "extensions": ["./extensions/index.ts"]
  }
}
```

## Use

```text
/tasked-subagents help
/tasked-subagents status
/tasked-subagents inspect <taskRunId|groupId|taskId|assignmentId>
/tasked-subagents dispatch
/tasked-subagents agents
```

The model tool is named `tasked_subagents`.

Common tool actions:

```text
tasked_subagents action=set_tasks tasks=[...] groups=[...]
tasked_subagents action=patch_task_run taskRunId=<id> groups=[...] tasks=[...]
tasked_subagents action=inspect taskRunId=<id>
tasked_subagents action=attach taskRunId=<id>
```

Use `patch_task_run` when triage or planning discovers additional groups or tasks for the same visible TaskRun. This appends new task ids and new or updated groups without replacing completed tasks or assignment history.

Planner tasks may opt into expansion with `expansionMode: "append_tasks"`. Those tasks can return `taskRunPatch` in their final JSON report, and the controller appends groups and tasks as visible TaskRun records before dispatch continues.

## Model

- `TaskRun` is the visible checklist for one delegated body of work.
- `Group` controls display, dependencies, and concurrency.
- `Task` is the only unit a subagent can execute.
- `Assignment` is one subagent attempt for one task.
- `Evidence` maps assignment output back to task criteria.

This differs from workflow-only orchestration: dynamic fan-out must materialize as real TaskRun tasks before it runs.

## Develop

```bash
npm install
npm run verify
pi -e .
```
