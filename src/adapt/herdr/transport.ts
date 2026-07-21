import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import type { HerdrSemanticState } from "./semantic.js";

/**
 * Herdr pane environment exported into managed pane processes:
 *   HERDR_ENV=1, HERDR_PANE_ID, HERDR_SOCKET_PATH, HERDR_BIN_PATH.
 * See herdr.dev/docs/socket-api.
 */
export interface HerdrEnv {
	/** True only when OMX is running inside a Herdr-managed pane. */
	enabled: boolean;
	paneId: string | null;
	socketPath: string | null;
	binPath: string | null;
}

export function detectHerdrEnv(
	env: NodeJS.ProcessEnv = process.env,
): HerdrEnv {
	const paneId = nonEmpty(env.HERDR_PANE_ID);
	const enabled = env.HERDR_ENV === "1" && paneId !== null;
	return {
		enabled,
		paneId,
		socketPath: nonEmpty(env.HERDR_SOCKET_PATH),
		binPath: nonEmpty(env.HERDR_BIN_PATH),
	};
}

function nonEmpty(value: string | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export interface HerdrAgentReport {
	paneId: string;
	source: string;
	agent: string;
	state: HerdrSemanticState;
	message?: string;
	/**
	 * Monotonically increasing per-source sequence. Herdr accepts but ignores a
	 * report whose seq is <= the last accepted seq for the same source, so stale
	 * reports cannot overwrite newer state.
	 */
	seq: number;
	/** Display-only metadata tokens (pane.report_metadata). */
	metadata?: Record<string, string>;
}

export interface HerdrReleaseReport {
	paneId: string;
	source: string;
	seq: number;
}

export interface HerdrTransportResult {
	ok: boolean;
	transport: "cli" | "socket";
	detail: string;
	error?: string;
}

export interface HerdrTransport {
	readonly kind: "cli" | "socket";
	reportAgent(report: HerdrAgentReport): Promise<HerdrTransportResult>;
	releaseAgent(report: HerdrReleaseReport): Promise<HerdrTransportResult>;
}

type ExecFileFn = (
	file: string,
	args: string[],
	callback: (error: Error | null) => void,
) => void;

/**
 * Build argv for `herdr pane report-agent`. argv is passed directly to execFile
 * (no shell), so pane ids, messages, and metadata cannot inject shell syntax.
 */
export function buildReportAgentArgs(report: HerdrAgentReport): string[] {
	const args = [
		"pane",
		"report-agent",
		report.paneId,
		"--source",
		report.source,
		"--agent",
		report.agent,
		"--state",
		report.state,
		"--seq",
		String(report.seq),
	];
	if (report.message !== undefined && report.message.length > 0) {
		args.push("--message", report.message);
	}
	return args;
}

export function buildReleaseAgentArgs(report: HerdrReleaseReport): string[] {
	return [
		"pane",
		"release-agent",
		report.paneId,
		"--source",
		report.source,
		"--seq",
		String(report.seq),
	];
}

export interface CliTransportOptions {
	binPath?: string | null;
	/** Injectable for tests; defaults to node:child_process execFile. */
	execFileFn?: ExecFileFn;
	timeoutMs?: number;
}

/**
 * Argv-safe CLI transport. Uses the Herdr binary resolved from HERDR_BIN_PATH
 * (falling back to `herdr` on PATH) and never shells out.
 */
export class CliHerdrTransport implements HerdrTransport {
	readonly kind = "cli" as const;
	private readonly bin: string;
	private readonly execFileFn: ExecFileFn;

	constructor(options: CliTransportOptions = {}) {
		this.bin = options.binPath?.trim() ? options.binPath.trim() : "herdr";
		this.execFileFn =
			options.execFileFn ??
			((file, args, cb) => {
				execFile(file, args, { timeout: options.timeoutMs ?? 5000 }, (err) =>
					cb(err),
				);
			});
	}

	reportAgent(report: HerdrAgentReport): Promise<HerdrTransportResult> {
		return this.run(buildReportAgentArgs(report), "report-agent");
	}

	releaseAgent(report: HerdrReleaseReport): Promise<HerdrTransportResult> {
		return this.run(buildReleaseAgentArgs(report), "release-agent");
	}

	private run(args: string[], op: string): Promise<HerdrTransportResult> {
		return new Promise((resolve) => {
			this.execFileFn(this.bin, args, (error) => {
				if (error) {
					resolve({
						ok: false,
						transport: "cli",
						detail: `herdr ${op} failed`,
						error: error.message,
					});
					return;
				}
				resolve({ ok: true, transport: "cli", detail: `herdr ${op} ok` });
			});
		});
	}
}

export interface SocketRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

export type SocketWriter = (
	socketPath: string,
	request: SocketRequest,
) => Promise<void>;

export interface SocketTransportOptions {
	socketPath: string;
	/** Injectable for tests; defaults to a newline-delimited JSON Unix socket write. */
	writer?: SocketWriter;
	timeoutMs?: number;
}

/**
 * Raw Herdr socket transport. Herdr uses newline-delimited JSON over a local
 * Unix domain socket; method names use dot notation (pane.report_agent,
 * pane.release_agent). See herdr.dev/docs/socket-api.
 */
export class SocketHerdrTransport implements HerdrTransport {
	readonly kind = "socket" as const;
	private readonly socketPath: string;
	private readonly writer: SocketWriter;
	private counter = 0;

	constructor(options: SocketTransportOptions) {
		this.socketPath = options.socketPath;
		this.writer =
			options.writer ??
			((socketPath, request) =>
				writeNdjsonRequest(socketPath, request, options.timeoutMs ?? 5000));
	}

	reportAgent(report: HerdrAgentReport): Promise<HerdrTransportResult> {
		const params: Record<string, unknown> = {
			pane_id: report.paneId,
			source: report.source,
			agent: report.agent,
			state: report.state,
			seq: report.seq,
		};
		if (report.message !== undefined && report.message.length > 0) {
			params.message = report.message;
		}
		return this.send("pane.report_agent", params, "report-agent");
	}

	releaseAgent(report: HerdrReleaseReport): Promise<HerdrTransportResult> {
		return this.send(
			"pane.release_agent",
			{
				pane_id: report.paneId,
				source: report.source,
				seq: report.seq,
			},
			"release-agent",
		);
	}

	private async send(
		method: string,
		params: Record<string, unknown>,
		op: string,
	): Promise<HerdrTransportResult> {
		this.counter += 1;
		const request: SocketRequest = {
			id: `omx-${op}-${this.counter}`,
			method,
			params,
		};
		try {
			await this.writer(this.socketPath, request);
			return { ok: true, transport: "socket", detail: `${method} ok` };
		} catch (error) {
			return {
				ok: false,
				transport: "socket",
				detail: `${method} failed`,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

function writeNdjsonRequest(
	socketPath: string,
	request: SocketRequest,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;
		const done = (err?: Error) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (err) reject(err);
			else resolve();
		};
		socket.setTimeout(timeoutMs, () => done(new Error("herdr socket timeout")));
		socket.on("error", (err) => done(err));
		socket.on("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`, (err) => {
				if (err) done(err);
				else done();
			});
		});
	});
}
