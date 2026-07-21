import type {
	HookEventEnvelope,
	HookEventName,
} from "../../hooks/extensibility/types.js";
import {
	type HerdrRollupInput,
	type HerdrSemanticState,
	type HerdrStateMapping,
	isTerminalHookEvent,
	mapHookEventToHerdrState,
	rollupTeamState,
} from "./semantic.js";
import {
	CliHerdrTransport,
	type HerdrEnv,
	type HerdrTransport,
	type HerdrTransportResult,
	SocketHerdrTransport,
	detectHerdrEnv,
} from "./transport.js";

export const HERDR_BRIDGE_SOURCE = "omx:runtime";
export const HERDR_BRIDGE_AGENT = "codex";

export interface HerdrBridgeOptions {
	env?: HerdrEnv;
	transport?: HerdrTransport;
	source?: string;
	agent?: string;
	/** Optional best-effort logger; never throws into the OMX run. */
	logger?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface HerdrBridgeOutcome {
	/** True when the bridge attempted a report/release (i.e. inside Herdr). */
	attempted: boolean;
	/** True when the underlying transport call succeeded. */
	ok: boolean;
	skipped: boolean;
	reason: string;
	state?: HerdrSemanticState;
	seq?: number;
	released?: boolean;
	transport?: HerdrTransportResult;
}

/**
 * Opt-in, best-effort OMX -> Herdr lifecycle/status bridge.
 *
 * Guarantees (issue #3241):
 * - No behavior change outside a detected Herdr pane (every op is a no-op when
 *   `env.enabled` is false).
 * - Ordered: a single monotonically increasing per-source seq is used for both
 *   report and release, so stale reports cannot win.
 * - Non-blocking / failure-isolated: transport errors are captured and returned,
 *   never thrown, so a Herdr failure cannot fail the OMX run.
 */
export class HerdrBridge {
	private readonly env: HerdrEnv;
	private readonly transport: HerdrTransport | null;
	private readonly source: string;
	private readonly agent: string;
	private readonly logger?: HerdrBridgeOptions["logger"];
	private seq = 0;
	private released = false;

	constructor(options: HerdrBridgeOptions = {}) {
		this.env = options.env ?? detectHerdrEnv();
		this.source = options.source ?? HERDR_BRIDGE_SOURCE;
		this.agent = options.agent ?? HERDR_BRIDGE_AGENT;
		this.logger = options.logger;
		this.transport = this.env.enabled
			? (options.transport ?? defaultTransport(this.env))
			: (options.transport ?? null);
	}

	get enabled(): boolean {
		return this.env.enabled;
	}

	/** Next monotonic sequence value; shared across report and release. */
	private nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}

	private skip(reason: string): HerdrBridgeOutcome {
		return { attempted: false, ok: false, skipped: true, reason };
	}

	/** Report a Herdr semantic state directly. */
	async reportState(
		state: HerdrSemanticState,
		options: { message?: string; metadata?: Record<string, string> } = {},
	): Promise<HerdrBridgeOutcome> {
		if (!this.env.enabled || !this.env.paneId || !this.transport) {
			return this.skip("herdr-not-detected");
		}
		const seq = this.nextSeq();
		try {
			const result = await this.transport.reportAgent({
				paneId: this.env.paneId,
				source: this.source,
				agent: this.agent,
				state,
				message: options.message,
				metadata: options.metadata,
				seq,
			});
			if (!result.ok) this.log("herdr report failed", { state, seq, result });
			return {
				attempted: true,
				ok: result.ok,
				skipped: false,
				reason: result.detail,
				state,
				seq,
				transport: result,
			};
		} catch (error) {
			// Failure isolation: never propagate into the OMX run.
			const message = error instanceof Error ? error.message : String(error);
			this.log("herdr report threw", { state, seq, error: message });
			return {
				attempted: true,
				ok: false,
				skipped: false,
				reason: `report threw: ${message}`,
				state,
				seq,
			};
		}
	}

	/**
	 * Map an OMX hook lifecycle event to a Herdr state and report it. If the
	 * event is terminal, release Herdr authority afterward.
	 */
	async reportHookEvent(
		event: HookEventEnvelope | HookEventName | string,
		options: { message?: string; metadata?: Record<string, string> } = {},
	): Promise<HerdrBridgeOutcome> {
		if (!this.env.enabled) return this.skip("herdr-not-detected");
		const mapping: HerdrStateMapping = mapHookEventToHerdrState(event);
		const outcome = await this.reportState(mapping.state, {
			message: options.message ?? mapping.reason,
			metadata: options.metadata,
		});
		if (isTerminalHookEvent(event)) {
			const release = await this.release();
			return { ...outcome, released: release.released ?? release.ok };
		}
		return outcome;
	}

	/** Report an authoritative Team rollup state. */
	async reportTeamRollup(
		input: HerdrRollupInput,
		options: { metadata?: Record<string, string> } = {},
	): Promise<HerdrBridgeOutcome> {
		if (!this.env.enabled) return this.skip("herdr-not-detected");
		const rollup = rollupTeamState(input);
		return this.reportState(rollup.state, {
			message: rollup.reason,
			metadata: options.metadata,
		});
	}

	/**
	 * Release `omx:runtime` authority so Herdr returns to normal Codex screen
	 * detection. Idempotent and safe to call on shutdown/exit.
	 */
	async release(): Promise<HerdrBridgeOutcome> {
		if (!this.env.enabled || !this.env.paneId || !this.transport) {
			return this.skip("herdr-not-detected");
		}
		if (this.released) {
			return { attempted: false, ok: true, skipped: true, reason: "already-released" };
		}
		const seq = this.nextSeq();
		try {
			const result = await this.transport.releaseAgent({
				paneId: this.env.paneId,
				source: this.source,
				seq,
			});
			this.released = true;
			if (!result.ok) this.log("herdr release failed", { seq, result });
			return {
				attempted: true,
				ok: result.ok,
				skipped: false,
				reason: result.detail,
				seq,
				released: true,
				transport: result,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log("herdr release threw", { seq, error: message });
			// Mark released so shutdown does not spin retrying a broken transport.
			this.released = true;
			return {
				attempted: true,
				ok: false,
				skipped: false,
				reason: `release threw: ${message}`,
				seq,
				released: true,
			};
		}
	}

	private log(message: string, meta?: Record<string, unknown>): void {
		try {
			this.logger?.(message, meta);
		} catch {
			// A misbehaving logger must not break the bridge.
		}
	}
}

function defaultTransport(env: HerdrEnv): HerdrTransport {
	if (env.socketPath) {
		return new SocketHerdrTransport({ socketPath: env.socketPath });
	}
	return new CliHerdrTransport({ binPath: env.binPath });
}

/** Convenience factory honoring the opt-in environment gate. */
export function createHerdrBridge(
	options: HerdrBridgeOptions = {},
): HerdrBridge {
	return new HerdrBridge(options);
}
