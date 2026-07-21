import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
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

export function detectHerdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrEnv {
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
	seq: number;
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

/** Build argv for `herdr pane report-agent` (no shell; execFile argv array). */
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

/**
 * Trust-pin the Herdr binary: only an absolute path to an existing regular file
 * is accepted. A bare `herdr` (PATH-resolved) is never used, to avoid PATH
 * hijack. Returns the trusted absolute path or null.
 */
export function resolveTrustedHerdrBin(binPath: string | null | undefined): string | null {
	const candidate = typeof binPath === "string" ? binPath.trim() : "";
	if (candidate.length === 0 || !isAbsolute(candidate)) return null;
	try {
		return statSync(candidate).isFile() ? candidate : null;
	} catch {
		return null;
	}
}

export interface CliTransportOptions {
	binPath?: string | null;
	/** Injectable for tests; defaults to node:child_process execFile. */
	execFileFn?: ExecFileFn;
	timeoutMs?: number;
}

/**
 * Argv-safe CLI transport. Requires a trust-pinned absolute Herdr binary; never
 * shells out and never falls back to a PATH-resolved `herdr`.
 */
export class CliHerdrTransport implements HerdrTransport {
	readonly kind = "cli" as const;
	private readonly bin: string | null;
	private readonly execFileFn: ExecFileFn;

	constructor(options: CliTransportOptions = {}) {
		this.bin = resolveTrustedHerdrBin(options.binPath);
		this.execFileFn =
			options.execFileFn ??
			((file, args, cb) => {
				execFile(file, args, { timeout: options.timeoutMs ?? 5000 }, (err) =>
					cb(err),
				);
			});
	}

	/** True only when a trust-pinned binary is available. */
	get available(): boolean {
		return this.bin !== null;
	}

	reportAgent(report: HerdrAgentReport): Promise<HerdrTransportResult> {
		return this.run(buildReportAgentArgs(report), "report-agent");
	}

	releaseAgent(report: HerdrReleaseReport): Promise<HerdrTransportResult> {
		return this.run(buildReleaseAgentArgs(report), "release-agent");
	}

	private run(args: string[], op: string): Promise<HerdrTransportResult> {
		return new Promise((resolve) => {
			if (!this.bin) {
				resolve({
					ok: false,
					transport: "cli",
					detail: `herdr ${op} skipped`,
					error: "no trust-pinned herdr binary (HERDR_BIN_PATH must be an absolute existing file)",
				});
				return;
			}
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

export interface SocketResponse {
	id?: string;
	result?: unknown;
	error?: { code?: string; message?: string } | string;
}

/**
 * Send one request and await the correlated response. Implementations must only
 * resolve `ok` when Herdr accepted the request (a matching `{id,result}`),
 * reject on `{id,error}`, and enforce bounded framing/timeout/backpressure.
 */
export type SocketExchange = (
	socketPath: string,
	request: SocketRequest,
) => Promise<SocketResponse>;

export interface SocketTransportOptions {
	socketPath: string;
	/** Injectable request/response exchange; defaults to a real Unix-socket NDJSON round-trip. */
	exchange?: SocketExchange;
	timeoutMs?: number;
	maxFrameBytes?: number;
}

const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;

/**
 * Raw Herdr socket transport with request/response correlation. Herdr uses
 * newline-delimited JSON over a local Unix domain socket; method names use dot
 * notation (pane.report_agent, pane.release_agent). Success is only reported
 * when a correlated `{id,result}` reply is received (Herdr acceptance), not when
 * bytes flush.
 */
export class SocketHerdrTransport implements HerdrTransport {
	readonly kind = "socket" as const;
	private readonly socketPath: string;
	private readonly exchange: SocketExchange;
	private counter = 0;

	constructor(options: SocketTransportOptions) {
		this.socketPath = options.socketPath;
		this.exchange =
			options.exchange ??
			((socketPath, request) =>
				ndjsonExchange(socketPath, request, {
					timeoutMs: options.timeoutMs ?? 5000,
					maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
				}));
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
		if (report.metadata && Object.keys(report.metadata).length > 0) {
			params.tokens = report.metadata;
		}
		return this.send("pane.report_agent", params, "report-agent");
	}

	releaseAgent(report: HerdrReleaseReport): Promise<HerdrTransportResult> {
		return this.send(
			"pane.release_agent",
			{ pane_id: report.paneId, source: report.source, seq: report.seq },
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
			id: `omx-${op}-${process.pid}-${this.counter}`,
			method,
			params,
		};
		try {
			const response = await this.exchange(this.socketPath, request);
			if (response.id !== undefined && response.id !== request.id) {
				return {
					ok: false,
					transport: "socket",
					detail: `${method} response id mismatch`,
					error: `expected ${request.id}, got ${response.id}`,
				};
			}
			if (response.error !== undefined) {
				const message =
					typeof response.error === "string"
						? response.error
						: (response.error.message ?? response.error.code ?? "herdr error");
				return {
					ok: false,
					transport: "socket",
					detail: `${method} rejected`,
					error: message,
				};
			}
			return { ok: true, transport: "socket", detail: `${method} accepted` };
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

interface NdjsonExchangeOptions {
	timeoutMs: number;
	maxFrameBytes: number;
}

/**
 * Real Unix-socket NDJSON request/response: write one request line, then read
 * reply lines with a bounded buffer, parse each NDJSON line, and resolve on the
 * first line whose `id` matches (or the first parseable object when the reply
 * carries no id). Enforces a total-buffer cap (backpressure/oversized-frame
 * guard) and a hard timeout.
 */
function ndjsonExchange(
	socketPath: string,
	request: SocketRequest,
	options: NdjsonExchangeOptions,
): Promise<SocketResponse> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let buffer = "";

		const done = (err?: Error, value?: SocketResponse) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (err) reject(err);
			else resolve(value ?? {});
		};

		socket.setTimeout(options.timeoutMs, () =>
			done(new Error("herdr socket timeout")),
		);
		socket.on("error", (err) => done(err));
		socket.on("close", () => done(new Error("herdr socket closed before reply")));
		socket.on("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`, (err) => {
				if (err) done(err);
			});
		});
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			if (Buffer.byteLength(buffer, "utf-8") > options.maxFrameBytes) {
				done(new Error("herdr response exceeded max frame bytes"));
				return;
			}
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (line.length > 0) {
					let parsed: SocketResponse | null = null;
					try {
						parsed = JSON.parse(line) as SocketResponse;
					} catch {
						parsed = null;
					}
					if (parsed && (parsed.id === undefined || parsed.id === request.id)) {
						done(undefined, parsed);
						return;
					}
				}
				newlineIndex = buffer.indexOf("\n");
			}
		});
	});
}
