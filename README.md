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
tasked_subagents action=clear targetId=<taskRunId|groupId|taskId|assignmentId>
```

Background dispatch emits one automatic signal when its TaskRun reaches a terminal state. Operations using `wait=true` return their final report directly and do not queue an additional agent turn.

Targeted `clear` removes one inactive TaskRun. `clear scope=all` cancels active subagents before removing their state. Clearing removes logical state immediately; files are deleted only when no session or branch reference still pins them. Cleanup is contained within the configured data root.

Use `patch_task_run` when triage or planning discovers additional groups or tasks for the same visible TaskRun. This appends new task ids and new or updated groups without replacing completed tasks or assignment history.

Planner tasks may opt into expansion with `expansionMode: "append_tasks"`. Those tasks can return `taskRunPatch` in their final JSON report, and the controller appends groups and tasks as visible TaskRun records before dispatch continues.

## Session state and results

Pi session files contain bounded v5 checkpoint pointers, not complete TaskRun snapshots or raw subagent output. Each pointer is at most 4 KiB and selects immutable, content-addressed state objects owned by `pi-tasked-subagents` in its private application-data directory. The data root is `$XDG_DATA_HOME/pi-tasked-subagents/` when `XDG_DATA_HOME` is an absolute path, or `~/.local/share/pi-tasked-subagents/` otherwise.

The selected branch's newest valid pointer is authoritative. Pi `/tree` navigation therefore restores the exact immutable checkpoint for that branch. Objects referenced by any visible branch are pinned, so exact rollback takes priority over a fixed total storage quota.

Normal status output includes active or actionable TaskRuns and the newest 20 completed summaries. Assignment results remain available after a summary leaves that list: `result <assignmentId>` verifies the assignment's immutable archive and loads only its authoritative result file on demand. If branches produced multiple archives for the same assignment id and the selected checkpoint does not disambiguate them, choose an exact archive instead of relying on an implicit match.

State storage enforces these limits:

- Pi checkpoint pointer: 4 KiB;
- checkpoint manifest: 256 KiB;
- recoverable TaskRun object: 2 MiB;
- assignment archive: 256 KiB;
- recoverable TaskRuns per checkpoint: 100;
- recent assignment references per checkpoint: 1,000;
- completed summaries in normal history: 20;
- raw JSONL recovery record: 256 MiB (enough for a bounded v4 state with up to 100 recoverable 2 MiB TaskRuns plus checkpoint metadata).

## Recover an oversized session

Recovery runs offline and writes a new session file; it never modifies the source. Use generic paths appropriate for your system:

1. Close Pi completely.
2. Check that the destination volume has enough free disk space for a backup, the recovered file, and external state objects.
3. Back up the original session:

   ```bash
   cp session.jsonl session.backup.jsonl
   ```

4. Run the streaming recovery command:

   ```bash
   npm run recover-session -- --input session.jsonl --output session.recovered.jsonl
   ```

5. Review the command's record and byte counts, confirm `session.recovered.jsonl` is the intended output, and keep the original and backup until the recovered session has been verified.
6. Open the generated file explicitly with Pi:

   ```bash
   pi --session session.recovered.jsonl
   ```

The converter processes one JSONL record at a time, externalizes bounded orchestration state, preserves unrelated records, and does not print prompts, result output, or paths found inside session records.

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
