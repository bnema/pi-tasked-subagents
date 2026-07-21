// Package metadata
export const PACKAGE_NAME = "pi-tasked-subagents";

// Tool and command names
export const TOOL_NAME = "tasked_subagents";
export const COMMAND_NAME = "tasked-subagents";

// UI keys
export const STATUS_KEY = "pi-tasked-subagents";
export const WIDGET_KEY = "pi-tasked-subagents";

// Custom message / entry types for v0
export const ENTRY_TYPE_STATE = "pi-tasked-subagents:state";
export const ENTRY_TYPE_LAUNCH = "pi-tasked-subagents:launch";
export const ENTRY_TYPE_COMPLETION = "pi-tasked-subagents:completion";
export const ENTRY_TYPE_ATTENTION = "pi-tasked-subagents:attention";
export const ENTRY_TYPE_ATTENTION_REMINDER = "pi-tasked-subagents:attention-reminder";
export const ENTRY_TYPE_FAILURE = "pi-tasked-subagents:failure";
export const ENTRY_TYPE_ARTIFACT = "pi-tasked-subagents:artifact";

// State version for the task-run state model.
export const STATE_VERSION = 4;

// Bounded durable v5 persistence.
export const STATE_POINTER_VERSION = 5;
export const STORE_VERSION = 1;
export const MAX_POINTER_BYTES = 4 * 1024;
export const MAX_CHECKPOINT_BYTES = 256 * 1024;
export const MAX_TASK_RUN_OBJECT_BYTES = 2 * 1024 * 1024;
export const MAX_ASSIGNMENT_ARCHIVE_BYTES = 256 * 1024;
export const MAX_RECOVERABLE_TASK_RUNS = 100;
export const MAX_RECENT_COMPLETED = 20;
export const MAX_RECENT_ASSIGNMENT_REFS = 1_000;
/**
 * Recovery retains one raw JSONL record at a time. 256 MiB accommodates a
 * v4 state containing the maximum 100 recoverable 2 MiB TaskRuns plus its
 * bounded checkpoint metadata, while rejecting unbounded legacy records.
 */
export const MAX_RECOVERY_RECORD_BYTES = 256 * 1024 * 1024;

// Defaults for launcher / dispatch
export const DEFAULT_POLL_INTERVAL_MS = 500;
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;
export const MAX_WAIT_TIMEOUT_MS = 30 * 60_000;
export const MAX_RUN_NAME_LENGTH = 64;
export const RUN_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// UI limits
export const DEFAULT_WIDGET_LINES = 14;
export const DEFAULT_VISIBLE_RECENT_EVENTS = 12;
export const DEFAULT_VISIBLE_RECENT_RUNS = 8;
export const DEFAULT_COMPLETED_RETENTION_LIMIT = 20;

// Input-router constants
/** Prefixes for slash commands that are passed through without interception. */
export const PASS_THROUGH_PREFIXES = ["/", "/skill:"] as const;
