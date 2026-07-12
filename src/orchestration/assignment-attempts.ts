import type { TaskAssignmentRecord, TaskRecord, TaskRunRecord } from "../types.js";

export function isSupersededAssignment(assignment: TaskAssignmentRecord): boolean {
  return assignment.supersededAt !== undefined || assignment.supersededByAssignmentId !== undefined;
}

export function assignmentsForTask(taskRun: TaskRunRecord, task: TaskRecord): TaskAssignmentRecord[] {
  return task.assignmentIds
    .map((assignmentId) => taskRun.assignments.find((assignment) => assignment.id === assignmentId))
    .filter((assignment): assignment is TaskAssignmentRecord => Boolean(assignment));
}

export function authoritativeAssignment(taskRun: TaskRunRecord, task: TaskRecord): TaskAssignmentRecord | undefined {
  const assignments = assignmentsForTask(taskRun, task);
  for (let index = assignments.length - 1; index >= 0; index -= 1) {
    if (!isSupersededAssignment(assignments[index])) return assignments[index];
  }
  return undefined;
}

export function authoritativeAssignments(taskRun: TaskRunRecord): TaskAssignmentRecord[] {
  return taskRun.tasks
    .map((task) => authoritativeAssignment(taskRun, task))
    .filter((assignment): assignment is TaskAssignmentRecord => Boolean(assignment));
}
