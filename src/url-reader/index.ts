import type {
	FetchLike,
	FetchLikeResponse,
	UrlReadError,
	UrlReaderOptions,
	UrlReadResult,
	UrlReadVerdict,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const USER_AGENT = "oh-my-codex-url-reader/0";

const BLOCKED_STATUS_CODES = new Set([401, 403, 407, 423, 429, 451, 503]);
const TEXT_CONTENT_TYPES = [
	"text/",
	"application/json",
	"application/xml",
	"application/xhtml+xml",
	"application/rss+xml",
	"application/atom+xml",
	"application/ld+json",
];

const CHALLENGE_MARKERS: Array<[RegExp, string]> = [
	[/captcha/i, "captcha-marker"],
	[/cloudflare|cf-chl|cf_clearance/i, "cloudflare-marker"],
	[/access denied/i, "access-denied-marker"],
	[/just a moment/i, "just-a-moment-marker"],
	[/verify\s+you\s+are\s+human/i, "human-verification-marker"],
	[/bot\s+detection|automated\s+traffic/i, "bot-detection-marker"],
	[/\bblocked\b/i, "blocked-marker"],
	[/\bchallenge\b/i, "challenge-marker"],
];

export type {
	FetchLike,
	FetchLikeResponse,
	UrlReadError,
	UrlReaderOptions,
	UrlReadResult,
	UrlReadVerdict,
};

export async function readUrl(
	inputUrl: string,
	options: UrlReaderOptions = {},
): Promise<UrlReadResult> {
	const normalizedInput = inputUrl.trim();
	const fetchImpl =
		options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
	const timeoutMs = normalizePositiveInteger(
		options.timeoutMs,
		DEFAULT_TIMEOUT_MS,
	);
	const maxBytes = normalizePositiveInteger(
		options.maxBytes,
		DEFAULT_MAX_BYTES,
	);

	let parsed: URL;
	try {
		parsed = new URL(normalizedInput);
	} catch (error) {
		return errorResult(normalizedInput, normalizeError(error));
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return errorResult(normalizedInput, {
			name: "UnsupportedProtocolError",
			message: `Unsupported URL protocol: ${parsed.protocol}`,
		});
	}

	if (!fetchImpl) {
		return errorResult(normalizedInput, {
			name: "FetchUnavailableError",
			message: "No fetch implementation is available in this runtime.",
		});
	}

	try {
		const response = await fetchImpl(parsed.toString(), {
			method: "GET",
			redirect: "follow",
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				"user-agent": USER_AGENT,
				accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.1",
			},
		});
		return await resultFromResponse(normalizedInput, response, maxBytes);
	} catch (error) {
		return errorResult(normalizedInput, normalizeError(error));
	}
}

async function resultFromResponse(
	inputUrl: string,
	response: FetchLikeResponse,
	maxBytes: number,
): Promise<UrlReadResult> {
	const contentType = response.headers.get("content-type");
	const read = await readBoundedBody(response, maxBytes);
	const text = decodeBody(read.bytes, contentType);
	const signals = classifySignals(response, text);
	const redirected = response.redirected || urlsDiffer(inputUrl, response.url);
	const verdict: UrlReadVerdict =
		signals.length > 0 ? "blocked" : redirected ? "redirect" : "ok";
	const textLike = isTextLike(contentType);

	return {
		input_url: inputUrl,
		final_url: response.url || inputUrl,
		verdict,
		status: response.status,
		status_text: response.statusText || null,
		content_type: contentType,
		redirected,
		title: textLike ? extractTitle(text) : null,
		snippet: textLike ? buildSnippet(text) : null,
		signals,
		truncated: read.truncated,
		bytes_read: read.bytesRead,
		error: null,
	};
}

async function readBoundedBody(
	response: FetchLikeResponse,
	maxBytes: number,
): Promise<{ bytes: Uint8Array; bytesRead: number; truncated: boolean }> {
	if (!response.body) {
		return { bytes: new Uint8Array(), bytesRead: 0, truncated: false };
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	let truncated = false;

	try {
		while (bytesRead < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			const remaining = maxBytes - bytesRead;
			if (value.byteLength > remaining) {
				chunks.push(value.slice(0, remaining));
				bytesRead += remaining;
				truncated = true;
				break;
			}
			chunks.push(value);
			bytesRead += value.byteLength;
		}

		if (bytesRead >= maxBytes) truncated = true;
	} finally {
		if (truncated) {
			await reader.cancel().catch(() => undefined);
		} else {
			reader.releaseLock();
		}
	}

	const bytes = new Uint8Array(bytesRead);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return { bytes, bytesRead, truncated };
}

function classifySignals(response: FetchLikeResponse, text: string): string[] {
	const signals = new Set<string>();
	if (BLOCKED_STATUS_CODES.has(response.status)) {
		signals.add(`status-${response.status}`);
	}
	for (const [pattern, signal] of CHALLENGE_MARKERS) {
		if (pattern.test(text)) signals.add(signal);
	}
	return [...signals];
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
	if (bytes.byteLength === 0) return "";
	const charset = /charset=([^;]+)/i.exec(contentType ?? "")?.[1]?.trim();
	try {
		return new TextDecoder(charset || "utf-8", { fatal: false }).decode(bytes);
	} catch {
		return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	}
}

function extractTitle(text: string): string | null {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
	if (!match) return null;
	const title = decodeHtmlEntities(stripTags(match[1]))
		.replace(/\s+/g, " ")
		.trim();
	return title === "" ? null : title.slice(0, 200);
}

function buildSnippet(text: string): string | null {
	const withoutScripts = text
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
	const normalized = decodeHtmlEntities(stripTags(withoutScripts))
		.replace(/\s+/g, " ")
		.trim();
	if (normalized === "") return null;
	return normalized.slice(0, 500);
}

function stripTags(text: string): string {
	return text.replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'");
}

function isTextLike(contentType: string | null): boolean {
	if (!contentType) return true;
	const normalized = contentType.toLowerCase();
	return TEXT_CONTENT_TYPES.some(
		(prefix) => normalized.startsWith(prefix) || normalized.includes(prefix),
	);
}

function urlsDiffer(inputUrl: string, finalUrl: string): boolean {
	if (!finalUrl) return false;
	try {
		return new URL(inputUrl).toString() !== new URL(finalUrl).toString();
	} catch {
		return inputUrl !== finalUrl;
	}
}

function normalizePositiveInteger(
	value: number | undefined,
	fallback: number,
): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: fallback;
}

function normalizeError(error: unknown): UrlReadError {
	if (error instanceof Error) {
		const errorWithCode = error as Error & { code?: unknown };
		const code =
			typeof errorWithCode.code === "string" ? errorWithCode.code : undefined;
		return {
			name: error.name || "Error",
			message: error.message || "URL read failed.",
			...(code ? { code } : {}),
		};
	}
	return {
		name: "Error",
		message: typeof error === "string" ? error : "URL read failed.",
	};
}

function errorResult(inputUrl: string, error: UrlReadError): UrlReadResult {
	return {
		input_url: inputUrl,
		final_url: null,
		verdict: "error",
		status: null,
		status_text: null,
		content_type: null,
		redirected: false,
		title: null,
		snippet: null,
		signals: [],
		truncated: false,
		bytes_read: 0,
		error,
	};
}
