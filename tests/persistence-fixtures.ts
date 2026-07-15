import type {
  RunProgressSnapshot,
  TaskRunRecord,
  TaskRunStatus,
  TaskedSubagentsState,
} from "../src/types.js";

const FIXED_TIME = 1_800_000_000_000;

function padded(index: number): string {
  return String(index).padStart(3, "0");
}

export function syntheticTaskRun(
  index: number,
  status: TaskRunStatus = "completed",
): TaskRunRecord {
  const suffix = padded(index);
  const taskRunId = `task-run-${suffix}`;
  const groupId = `group-${suffix}`;
  const taskId = `task-${suffix}`;
  const assignmentId = `assignment-${suffix}`;
  const runId = `run-${suffix}`;
  const timestamp = FIXED_TIME + index;
  const completed = status === "completed";

  return {
    id: taskRunId,
    title: `Synthetic TaskRun ${suffix}`,
    request: `Complete generic request ${suffix}`,
    context: `Generic deterministic context ${suffix}`,
    status,
    groups: [{
      id: groupId,
      title: `Generic group ${suffix}`,
      status: completed ? "completed" : "running",
      dependsOn: [],
      maxConcurrency: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(completed ? { completedAt: timestamp } : {}),
    }],
    tasks: [{
      id: taskId,
      groupId,
      text: `Perform generic task ${suffix}`,
      status: completed ? "completed" : "running",
      criteria: [{
        id: `${taskId}-criterion-1`,
        text: "Generic criterion is satisfied",
        satisfied: completed,
        evidence: [{
          criterionId: `${taskId}-criterion-1`,
          assignmentId,
          summary: `Generic evidence ${suffix}`,
          artifactPath: `artifacts/output-${suffix}.txt`,
          createdAt: timestamp,
        }],
      }],
      dependsOn: [],
      assignmentIds: [assignmentId],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(completed ? { completedAt: timestamp } : {}),
    }],
    assignments: [{
      id: assignmentId,
      taskRunId,
      groupId,
      taskId,
      agent: "generic-agent",
      prompt: `Use placeholder input /tmp/example/input-${suffix}.txt`,
      status: completed ? "completed" : "running",
      runId,
      launchRef: {
        runId,
        asyncId: `async-${suffix}`,
        legacy: true,
        resultPath: `/tmp/example/result-${suffix}.json`,
        assignments: [{
          assignmentId,
          runId,
          resultPath: `/tmp/example/result-${suffix}.json`,
        }],
      },
      result: {
        assignmentId,
        status: "completed",
        summary: `Generic result ${suffix}`,
        criteriaEvidence: [{
          criteriaIndex: 0,
          criterionId: `${taskId}-criterion-1`,
          evidence: `Deterministic evidence ${suffix}`,
        }],
        artifacts: [{
          label: "Generic output",
          path: `artifacts/output-${suffix}.txt`,
          assignmentId,
          taskRunId,
          groupId,
          taskId,
        }],
        followUps: [],
        rawResultPath: `/tmp/example/result-${suffix}.json`,
        createdAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(completed ? { completedAt: timestamp } : {}),
    }],
    artifacts: [{
      label: "Generic output",
      path: `artifacts/output-${suffix}.txt`,
      assignmentId,
      taskRunId,
      groupId,
      taskId,
    }],
    maxConcurrency: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(completed ? { completedAt: timestamp } : {}),
  };
}

export function syntheticState(runCount: number): TaskedSubagentsState {
  const taskRuns = Array.from({ length: runCount }, (_, index) => syntheticTaskRun(index + 1));
  return {
    version: 4,
    taskRuns,
    currentTaskRunId: taskRuns.at(-1)?.id,
    updatedAt: FIXED_TIME + runCount,
  };
}

export function syntheticProgress(
  runId: string,
  assignmentId: string,
  sequence: number,
): RunProgressSnapshot {
  return {
    runId,
    status: "running",
    steps: [{
      id: assignmentId,
      status: "completed",
      agent: "generic-agent",
      currentTool: `generic-tool-${sequence % 4}`,
      lastActionAt: FIXED_TIME + sequence,
      lastActionSummary: `Generic progress update ${sequence}`,
      recentActivity: [`Generic activity ${sequence}`],
    }],
  };
}
