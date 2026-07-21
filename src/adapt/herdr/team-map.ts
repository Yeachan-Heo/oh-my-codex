import type { HerdrRollupInput, HerdrWorkerState } from "./semantic.js";

/**
 * Minimal authoritative Team-state shape consumed by the Herdr rollup. This
 * intentionally mirrors the real OMX Team state surfaces
 * (`WorkerStatus.state` from `src/team/state.ts` and the leader attention flag
 * `leader_attention_pending` from the team leader-attention state) rather than
 * inventing a bespoke shape.
 */
export interface TeamWorkerStateInput {
	id: string;
	/** WorkerStatus.state from src/team/state.ts */
	state: "idle" | "working" | "blocked" | "done" | "failed" | "draining" | "unknown";
	/** WorkerStatus.reason, used to detect user-blocking. */
	reason?: string;
}

export interface TeamStateInput {
	/** leader_attention_pending from the team leader-attention state. */
	leaderAttentionPending?: boolean;
	workers: TeamWorkerStateInput[];
	runTerminal?: boolean;
}

const USER_BLOCK_REASON = /(user|input|approval|permission|decision|confirm|review)/i;

function mapWorkerState(
	state: TeamWorkerStateInput["state"],
): HerdrWorkerState {
	switch (state) {
		case "draining":
			// Winding down but still active work; treat as working for rollup.
			return "working";
		case "idle":
		case "working":
		case "blocked":
		case "done":
		case "failed":
			return state;
		default:
			return "unknown";
	}
}

/**
 * Map real authoritative Team state into the Herdr rollup input. The leader
 * attention flag is the authoritative user-block signal; a worker marked
 * `blocked` only counts as user-blocking when its reason indicates a user
 * decision, so a system-blocked worker does not force the whole pane to look
 * blocked.
 */
export function mapTeamStateToRollup(state: TeamStateInput): HerdrRollupInput {
	return {
		leaderBlockedOnUser: state.leaderAttentionPending === true,
		runTerminal: state.runTerminal,
		workers: state.workers.map((worker) => ({
			id: worker.id,
			state: mapWorkerState(worker.state),
			blockedOnUser:
				worker.state === "blocked"
					? USER_BLOCK_REASON.test(worker.reason ?? "")
					: undefined,
		})),
	};
}
