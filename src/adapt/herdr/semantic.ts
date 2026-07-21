import type {
	HookEventEnvelope,
	HookEventName,
} from "../../hooks/extensibility/types.js";

/**
 * Herdr semantic agent states, as documented by the official Herdr socket/CLI
 * protocol (herdr.dev/docs/agents, /docs/socket-api). `state` is semantic: it
 * drives Herdr waits, notifications, and workspace rollups. Display-only detail
 * is carried separately as metadata tokens.
 */
export const HERDR_SEMANTIC_STATES = [
	"working",
	"blocked",
	"idle",
	"unknown",
] as const;
export type HerdrSemanticState = (typeof HERDR_SEMANTIC_STATES)[number];

/**
 * OMX hook lifecycle events that map to Herdr `working`. These represent an
 * active turn, an active workflow, or active workers/tasks.
 */
const WORKING_EVENTS = new Set<string>([
	"session-start",
	"run.heartbeat",
	"worker.assigned",
	"worker.recovered",
	"test-started",
	"pre-tool-use",
	"post-tool-use",
]);

/**
 * OMX hook lifecycle events that map to Herdr `blocked`. These represent an
 * approval, question, or user decision that OMX is waiting on.
 */
const BLOCKED_EVENTS = new Set<string>([
	"blocked",
	"run.blocked_on_user",
	"run.blocked_on_system",
	"needs-input",
	"handoff-needed",
]);

/**
 * OMX hook lifecycle events that map to Herdr `idle`. These represent a turn,
 * workflow, or session reaching a terminal or resting state. Herdr derives its
 * own `done`/seen behavior from `idle`.
 */
const IDLE_EVENTS = new Set<string>([
	"turn-complete",
	"finished",
	"failed",
	"stop",
	"session-end",
	"session-idle",
]);

/**
 * OMX lifecycle events after which OMX should release `omx:runtime` authority so
 * Herdr can safely return to its normal Codex screen detection. Only whole-
 * session shutdown releases authority; per-run `finished`/`failed` map to `idle`
 * without releasing, because a single run ending does not mean OMX has left the
 * pane.
 */
const TERMINAL_EVENTS = new Set<string>(["stop", "session-end"]);

export interface HerdrStateMapping {
	state: HerdrSemanticState;
	/** Whether OMX should release Herdr authority after reporting this state. */
	terminal: boolean;
	/** Short, non-authoritative rationale for the mapping decision. */
	reason: string;
}

/**
 * Map a single OMX hook lifecycle event to a Herdr semantic state. Unknown or
 * unmapped events resolve to `unknown` rather than guessing, matching the issue
 * requirement that reconciliation-uncertain state is reported as `unknown`.
 */
export function mapHookEventToHerdrState(
	event: HookEventEnvelope | HookEventName | string,
): HerdrStateMapping {
	const name = typeof event === "string" ? event : event.event;

	if (BLOCKED_EVENTS.has(name)) {
		return {
			state: "blocked",
			terminal: false,
			reason: `OMX event '${name}' requires user/system attention.`,
		};
	}
	if (WORKING_EVENTS.has(name)) {
		return {
			state: "working",
			terminal: false,
			reason: `OMX event '${name}' indicates active work.`,
		};
	}
	if (IDLE_EVENTS.has(name)) {
		return {
			state: "idle",
			terminal: TERMINAL_EVENTS.has(name),
			reason: `OMX event '${name}' reached a terminal/resting state.`,
		};
	}

	return {
		state: "unknown",
		terminal: false,
		reason: `OMX event '${name}' has no authoritative Herdr mapping.`,
	};
}

export function isTerminalHookEvent(
	event: HookEventEnvelope | HookEventName | string,
): boolean {
	const name = typeof event === "string" ? event : event.event;
	return TERMINAL_EVENTS.has(name);
}

export type HerdrWorkerState =
	| "working"
	| "blocked"
	| "done"
	| "failed"
	| "idle"
	| "unknown";

export interface HerdrRollupWorker {
	id: string;
	state: HerdrWorkerState;
	/**
	 * True when this worker/task is blocked specifically on user action. Only
	 * user-blocking workers escalate the rollup to `blocked`; a worker blocked on
	 * the system alone does not make the whole pane look blocked.
	 */
	blockedOnUser?: boolean;
}

export interface HerdrRollupInput {
	/** The leader (or a workflow) is waiting on a user decision. */
	leaderBlockedOnUser?: boolean;
	workers: HerdrRollupWorker[];
	/** The whole run has reached a terminal outcome. */
	runTerminal?: boolean;
}

export interface HerdrRollupResult {
	state: HerdrSemanticState;
	reason: string;
	counts: {
		total: number;
		working: number;
		blocked: number;
		blockedOnUser: number;
		done: number;
		failed: number;
		idle: number;
		unknown: number;
	};
}

/**
 * Roll up authoritative OMX Team worker/task state into a single Herdr semantic
 * state, rather than relying on Herdr's pane-output inference.
 *
 * Precedence, per issue #3241:
 *   1. `blocked` if the leader needs user input or an authoritative worker/task
 *      is blocked on user action.
 *   2. otherwise `working` while any worker/task is active.
 *   3. otherwise `idle` when the run is terminal (or nothing is active).
 */
export function rollupTeamState(input: HerdrRollupInput): HerdrRollupResult {
	const counts = {
		total: input.workers.length,
		working: 0,
		blocked: 0,
		blockedOnUser: 0,
		done: 0,
		failed: 0,
		idle: 0,
		unknown: 0,
	};

	for (const worker of input.workers) {
		switch (worker.state) {
			case "working":
				counts.working += 1;
				break;
			case "blocked":
				counts.blocked += 1;
				if (worker.blockedOnUser !== false) counts.blockedOnUser += 1;
				break;
			case "done":
				counts.done += 1;
				break;
			case "failed":
				counts.failed += 1;
				break;
			case "idle":
				counts.idle += 1;
				break;
			default:
				counts.unknown += 1;
				break;
		}
	}

	if (input.leaderBlockedOnUser) {
		return {
			state: "blocked",
			reason: "Leader is blocked on user action.",
			counts,
		};
	}
	if (counts.blockedOnUser > 0) {
		return {
			state: "blocked",
			reason: `${counts.blockedOnUser} worker/task blocked on user action.`,
			counts,
		};
	}
	if (counts.working > 0) {
		return {
			state: "working",
			reason: `${counts.working} worker/task active.`,
			counts,
		};
	}

	return {
		state: "idle",
		reason: input.runTerminal
			? "Run reached a terminal state; no active workers."
			: "No active or user-blocked workers.",
		counts,
	};
}
