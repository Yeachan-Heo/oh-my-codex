import type {
	HookEventEnvelope,
	HookEventName,
} from "../../hooks/extensibility/types.js";
import {
	clearAuthority,
	recordAuthority,
} from "./authority.js";
import { sanitizeMessage, sanitizeMetadata } from "./sanitize.js";
import {
	type HerdrRollupInput,
	type HerdrSemanticState,
	type HerdrStateMapping,
	isTerminalHookEvent,
	mapHookEventToHerdrState,
	rollupTeamState,
} from "./semantic.js";
import { nextSeq as durableNextSeq } from "./seq-store.js";
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
	/** Injectable seq provider; defaults to the durable cross-process store. */
	seqFn?: (source: string) => number;
	/** Base dir for the durable seq/authority stores (tests). */
	stateBaseDir?: string;
	/**
	 * Returns true when an OMX workflow other than this one remains active, so
	 * release must be suppressed. Defaults to "nothing else active".
	 */
	workflowActiveFn?: () => boolean;
	/** Best-effort logger; never throws into the OMX run. */
	logger?: (message: string, meta?: Record<string, unknown>) => void;
	/** Session id recorded on the authority record for crash reconciliation. */
	sessionId?: string;
}

export interface HerdrBridgeOutcome {
	attempted: boolean;
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
 * - No behavior change outside a detected Herdr pane.
 * - Ordered: seq comes from a durable cross-process per-source store, so stale
 *   reports cannot win across concurrent hook processes or restarts.
 * - Non-blocking / failure-isolated: transport errors are captured and returned,
 *   never thrown.
 * - Release is gated on remaining active workflows and records/clears authority
 *   for crash reconciliation.
 */
export class HerdrBridge {
	private readonly env: HerdrEnv;
	private readonly transport: HerdrTransport | null;
	private readonly source: string;
	private readonly agent: string;
	private readonly seqFn: (source: string) => number;
	private readonly workflowActiveFn: () => boolean;
	private readonly stateBaseDir?: string;
	private readonly sessionId?: string;
	private readonly logger?: HerdrBridgeOptions["logger"];
	private released = false;
	private authorityRecorded = false;

	constructor(options: HerdrBridgeOptions = {}) {
		this.env = options.env ?? detectHerdrEnv();
		this.source = options.source ?? HERDR_BRIDGE_SOURCE;
		this.agent = options.agent ?? HERDR_BRIDGE_AGENT;
		this.stateBaseDir = options.stateBaseDir;
		this.sessionId = options.sessionId;
		this.logger = options.logger;
		this.seqFn =
			options.seqFn ??
			((source) => durableNextSeq(source, { baseDir: this.stateBaseDir }));
		this.workflowActiveFn = options.workflowActiveFn ?? (() => false);
		this.transport = this.env.enabled
			? (options.transport ?? defaultTransport(this.env))
			: (options.transport ?? null);
	}

	get enabled(): boolean {
		return this.env.enabled;
	}

	private nextSeq(): number {
		return this.seqFn(this.source);
	}

	private skip(reason: string): HerdrBridgeOutcome {
		return { attempted: false, ok: false, skipped: true, reason };
	}

	async reportState(
		state: HerdrSemanticState,
		options: { message?: string; metadata?: Record<string, string> } = {},
	): Promise<HerdrBridgeOutcome> {
		if (!this.env.enabled || !this.env.paneId || !this.transport) {
			return this.skip("herdr-not-detected");
		}
		const seq = this.nextSeq();
		const message = sanitizeMessage(options.message);
		const metadata = sanitizeMetadata(options.metadata);
		try {
			const result = await this.transport.reportAgent({
				paneId: this.env.paneId,
				source: this.source,
				agent: this.agent,
				state,
				message,
				metadata,
				seq,
			});
			if (result.ok) this.ensureAuthorityRecorded();
			else this.log("herdr report failed", { state, seq, result });
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
	 * Release `omx:runtime` authority. Suppressed while another OMX workflow
	 * remains active (a single terminal event must not release authority for
	 * still-running workflows). Clears the authority record on release.
	 */
	async release(): Promise<HerdrBridgeOutcome> {
		if (!this.env.enabled || !this.env.paneId || !this.transport) {
			return this.skip("herdr-not-detected");
		}
		if (this.released) {
			return { attempted: false, ok: true, skipped: true, reason: "already-released" };
		}
		if (this.workflowActiveFn()) {
			return {
				attempted: false,
				ok: true,
				skipped: true,
				reason: "workflow-still-active",
			};
		}
		const seq = this.nextSeq();
		try {
			const result = await this.transport.releaseAgent({
				paneId: this.env.paneId,
				source: this.source,
				seq,
			});
			this.released = true;
			this.clearAuthorityRecord();
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
			this.released = true;
			this.clearAuthorityRecord();
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

	private ensureAuthorityRecorded(): void {
		if (this.authorityRecorded || !this.env.paneId) return;
		this.authorityRecorded = true;
		try {
			recordAuthority(
				{
					pane_id: this.env.paneId,
					source: this.source,
					owner_pid: process.pid,
					session_id: this.sessionId,
				},
				{ baseDir: this.stateBaseDir },
			);
		} catch (error) {
			this.log("herdr authority record failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private clearAuthorityRecord(): void {
		try {
			clearAuthority({ baseDir: this.stateBaseDir });
		} catch {
			// best-effort
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

export function createHerdrBridge(options: HerdrBridgeOptions = {}): HerdrBridge {
	return new HerdrBridge(options);
}
