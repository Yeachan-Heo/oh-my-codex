import type { HookEventEnvelope } from "../../hooks/extensibility/types.js";
import { reconcileStaleAuthority } from "./authority.js";
import { HerdrBridge, type HerdrBridgeOptions } from "./bridge.js";
import { detectHerdrEnv } from "./transport.js";

export interface HerdrWiringInput {
	cwd: string;
	event: HookEventEnvelope;
	/** Test injection for the bridge (env/transport/seq/etc.). */
	bridgeOptions?: HerdrBridgeOptions;
}

export interface HerdrWiringResult {
	wired: boolean;
	reason: string;
	reconciledStaleAuthority?: boolean;
	state?: string;
	released?: boolean;
}

/**
 * Production entry point that reports a canonical OMX lifecycle event to the
 * containing Herdr pane. Called from `dispatchHookEvent` (the single seam every
 * native/derived/team/notify dispatch path funnels through). Best-effort and
 * non-blocking: any failure is swallowed and never affects the OMX run, and it
 * is a complete no-op outside a Herdr pane.
 */
export async function reportHerdrLifecycleEvent(
	input: HerdrWiringInput,
): Promise<HerdrWiringResult> {
	const env = input.bridgeOptions?.env ?? detectHerdrEnv();
	if (!env.enabled) {
		return { wired: false, reason: "herdr-not-detected" };
	}

	try {
		// On session-start, reconcile any authority left behind by a crashed
		// prior OMX process before we (re)assert state.
		let reconciled: boolean | undefined;
		if (input.event.event === "session-start") {
			reconciled = reconcileStaleAuthority();
		}

		const sessionId =
			typeof input.event.session_id === "string"
				? input.event.session_id
				: undefined;
		const bridge = new HerdrBridge({
			env,
			sessionId,
			...input.bridgeOptions,
		});
		const outcome = await bridge.reportHookEvent(input.event, {
			metadata: buildDisplayMetadata(input.event),
		});
		return {
			wired: true,
			reason: outcome.reason,
			reconciledStaleAuthority: reconciled,
			state: outcome.state,
			released: outcome.released,
		};
	} catch (error) {
		// Failure isolation at the wiring boundary.
		return {
			wired: false,
			reason: `herdr wiring threw: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Small, display-only metadata derived from the event (bounded/redacted downstream). */
function buildDisplayMetadata(
	event: HookEventEnvelope,
): Record<string, string> | undefined {
	const tokens: Record<string, string> = {};
	if (typeof event.mode === "string" && event.mode.length > 0) {
		tokens.omx_mode = event.mode;
	}
	const phase = event.context?.phase;
	if (typeof phase === "string" && phase.length > 0) {
		tokens.phase = phase;
	}
	return Object.keys(tokens).length > 0 ? tokens : undefined;
}
