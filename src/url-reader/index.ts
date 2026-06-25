import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
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
const DEFAULT_MAX_REDIRECTS = 10;
const USER_AGENT = "oh-my-codex-url-reader/0";
const DEFAULT_HTTP_PORT = "80";
const DEFAULT_HTTPS_PORT = "443";

const BLOCKED_STATUS_CODES = new Set([401, 403, 407, 423, 429, 451, 503]);
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const LOCALHOST_NAMES = new Set(["localhost", "localhost.localdomain"]);
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
	const maxRedirects = normalizePositiveInteger(
		options.maxRedirects,
		DEFAULT_MAX_REDIRECTS,
	);

	let parsed: URL;
	try {
		parsed = new URL(normalizedInput);
	} catch (error) {
		return errorResult(normalizedInput, normalizeError(error));
	}

	if (!fetchImpl) {
		return errorResult(normalizedInput, {
			name: "FetchUnavailableError",
			message: "No fetch implementation is available in this runtime.",
		});
	}

	try {
		const response = await fetchWithSafeRedirects(
			parsed,
			fetchImpl,
			options,
			timeoutMs,
			maxRedirects,
		);
		if ("blocked" in response) return response.blocked;
		return await resultFromResponse(
			normalizedInput,
			response.response,
			maxBytes,
			response.redirected,
		);
	} catch (error) {
		return errorResult(normalizedInput, normalizeError(error));
	}
}

async function fetchWithSafeRedirects(
	initialUrl: URL,
	fetchImpl: FetchLike,
	options: UrlReaderOptions,
	timeoutMs: number,
	maxRedirects: number,
): Promise<
	| { response: FetchLikeResponse; redirected: boolean }
	| { blocked: UrlReadResult }
> {
	let currentUrl = initialUrl;
	let redirected = false;

	for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
		const safeTarget = await prepareSafeFetchTarget(
			currentUrl,
			options,
			redirected,
			initialUrl.toString(),
		);
		if ("blocked" in safeTarget) return { blocked: safeTarget.blocked };

		const response = await fetchImpl(safeTarget.fetchUrl.toString(), {
			method: "GET",
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
			headers: safeTarget.headers,
		});

		if (!REDIRECT_STATUS_CODES.has(response.status)) {
			return { response, redirected: redirected || response.redirected };
		}

		const location = response.headers.get("location");
		if (!location) return { response, redirected };

		let nextUrl: URL;
		try {
			nextUrl = new URL(location, currentUrl);
		} catch {
			return {
				blocked: blockedResult(currentUrl.toString(), "unsafe-redirect-url", {
					name: "UnsafeUrlError",
					message: "Blocked URL redirect because the target URL is invalid.",
				}),
			};
		}

		const unsafeRedirect = await prepareSafeFetchTarget(
			nextUrl,
			options,
			true,
			initialUrl.toString(),
		);
		if ("blocked" in unsafeRedirect) return { blocked: unsafeRedirect.blocked };
		currentUrl = nextUrl;
		redirected = true;
	}

	return {
		blocked: blockedResult(initialUrl.toString(), "too-many-redirects", {
			name: "TooManyRedirectsError",
			message: "Blocked URL read after too many redirects.",
		}),
	};
}

interface SafeFetchTarget {
	fetchUrl: URL;
	headers: Record<string, string>;
}

async function prepareSafeFetchTarget(
	url: URL,
	options: UrlReaderOptions,
	redirect = false,
	inputUrl = url.toString(),
): Promise<SafeFetchTarget | { blocked: UrlReadResult }> {
	const validation = await validateAndResolveSafeUrl(url, options, redirect, inputUrl);
	if ("blocked" in validation) return validation;

	const hostname = normalizeHostname(url.hostname);
	const ipVersion = isIP(hostname);
	const headers = defaultFetchHeaders();

	if (ipVersion !== 0) {
		return { fetchUrl: url, headers };
	}

	if (url.protocol === "https:") {
		return {
			blocked: blockedResult(inputUrl, "https-hostname-not-pinned", {
				name: "UnsafeUrlError",
				message: redirect
					? "Blocked URL redirect because HTTPS hostname targets cannot be connection-pinned safely in this runtime."
					: "Blocked URL read because HTTPS hostname targets cannot be connection-pinned safely in this runtime.",
			}),
		};
	}

	const fetchUrl = new URL(url.toString());
	fetchUrl.hostname = formatHostnameForUrl(validation.address);
	headers.host = originalHttpHostHeader(url);
	return { fetchUrl, headers };
}

async function validateAndResolveSafeUrl(
	url: URL,
	options: UrlReaderOptions,
	redirect = false,
	inputUrl = url.toString(),
): Promise<{ address: string } | { blocked: UrlReadResult }> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return {
			blocked: blockedResult(inputUrl, "unsupported-protocol", {
				name: "UnsupportedProtocolError",
				message: `Blocked URL read because protocol ${url.protocol} is not supported.`,
			}),
		};
	}

	const hostname = normalizeHostname(url.hostname);
	if (isLocalhostName(hostname)) {
		return {
			blocked: blockedResult(inputUrl, "localhost-name", {
				name: "UnsafeUrlError",
				message: redirect
					? "Blocked URL redirect to a local hostname."
					: "Blocked URL read for a local hostname.",
			}),
		};
	}

	let addresses: string[];
	try {
		addresses = await resolveHostname(hostname, options);
	} catch {
		return {
			blocked: blockedResult(inputUrl, "dns-resolution-failed", {
				name: "DnsResolutionError",
				message: "Blocked URL read because the hostname could not be resolved safely.",
			}),
		};
	}

	if (addresses.length === 0) {
		return {
			blocked: blockedResult(inputUrl, "dns-resolution-empty", {
				name: "DnsResolutionError",
				message: "Blocked URL read because the hostname did not resolve to an address.",
			}),
		};
	}

	if (addresses.some((address) => !isSafeIpAddress(address))) {
		return {
			blocked: blockedResult(inputUrl, "unsafe-address", {
				name: "UnsafeUrlError",
				message: redirect
					? "Blocked URL redirect because the target resolves to an unsafe network address."
					: "Blocked URL read because the target resolves to an unsafe network address.",
			}),
		};
	}

	return { address: addresses[0] };
}

function defaultFetchHeaders(): Record<string, string> {
	return {
		"user-agent": USER_AGENT,
		accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.1",
	};
}

function originalHttpHostHeader(url: URL): string {
	const hostname = normalizeHostname(url.hostname);
	const defaultPort = url.protocol === "https:" ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT;
	const bracketedHostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
	return url.port && url.port !== defaultPort ? `${bracketedHostname}:${url.port}` : bracketedHostname;
}

function formatHostnameForUrl(address: string): string {
	return isIP(address) === 6 ? `[${address}]` : address;
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

function isLocalhostName(hostname: string): boolean {
	return LOCALHOST_NAMES.has(hostname) || hostname.endsWith(".localhost");
}

async function resolveHostname(
	hostname: string,
	options: UrlReaderOptions,
): Promise<string[]> {
	if (isIP(hostname) !== 0) return [hostname];
	if (options.resolveHostname) return options.resolveHostname(hostname);
	const records = await dnsLookup(hostname, { all: true, verbatim: true });
	return records.map((record) => record.address);
}

function isSafeIpAddress(address: string): boolean {
	const normalized = normalizeHostname(address);
	const version = isIP(normalized);
	if (version === 4) return isSafeIpv4(normalized);
	if (version === 6) return isSafeIpv6(normalized);
	return false;
}

function isSafeIpv4(address: string): boolean {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b, c] = parts as [number, number, number, number];
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 192 && b === 0) return false;
	if (a === 192 && b === 88 && c === 99) return false;
	if (a === 198 && (b === 18 || b === 19)) return false;
	if (a === 198 && b === 51 && c === 100) return false;
	if (a === 203 && b === 0 && c === 113) return false;
	return true;
}

function isSafeIpv6(address: string): boolean {
	const value = ipv6ToBigInt(address);
	if (value === null) return false;

	const ipv4Mapped = ipv4FromIpv6Mapped(value);
	if (ipv4Mapped) return isSafeIpv4(ipv4Mapped);

	if (value === 0n || value === 1n) return false;
	if (inIpv6Range(value, ipv6Prefix("64:ff9b:1::"), 48)) return false; // local-use IPv4/IPv6 translation
	if (inIpv6Range(value, ipv6Prefix("100::"), 64)) return false; // discard-only
	if (inIpv6Range(value, ipv6Prefix("100:0:0:1::"), 64)) return false; // dummy prefix
	if (inIpv6Range(value, ipv6Prefix("2001::"), 23)) return false; // IETF protocol assignments
	if (inIpv6Range(value, ipv6Prefix("2001:db8::"), 32)) return false; // documentation/reserved
	if (inIpv6Range(value, ipv6Prefix("2002::"), 16)) return false; // 6to4 transition addresses
	if (inIpv6Range(value, ipv6Prefix("3fff::"), 20)) return false; // documentation/reserved
	if (inIpv6Range(value, ipv6Prefix("5f00::"), 16)) return false; // segment routing SIDs
	if (inIpv6Range(value, ipv6Prefix("fc00::"), 7)) return false; // unique local
	if (inIpv6Range(value, ipv6Prefix("fe80::"), 10)) return false; // link local
	if (inIpv6Range(value, ipv6Prefix("ff00::"), 8)) return false; // multicast
	return true;
}

function ipv4FromIpv6Mapped(value: bigint): string | null {
	if (!inIpv6Range(value, 0xffffn << 32n, 96)) return null;
	return bigIntToIpv4(value & 0xffffffffn);
}

function ipv6Prefix(address: string): bigint {
	const value = ipv6ToBigInt(address);
	if (value === null) throw new Error(`Invalid IPv6 prefix: ${address}`);
	return value;
}

function inIpv6Range(value: bigint, prefixValue: bigint, prefixBits: number): boolean {
	const shift = BigInt(128 - prefixBits);
	return value >> shift === prefixValue >> shift;
}

function bigIntToIpv4(value: bigint): string {
	return [24n, 16n, 8n, 0n]
		.map((shift) => Number((value >> shift) & 0xffn))
		.join(".");
}

function ipv6ToBigInt(address: string): bigint | null {
	let normalized = address.toLowerCase();
	const zoneIndex = normalized.indexOf("%");
	if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
	const ipv4Tail = /(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
	if (ipv4Tail) {
		const ipv4 = ipv4Tail[2].split(".").map((part) => Number.parseInt(part, 10));
		if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
		normalized = `${ipv4Tail[1]}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
	}
	const halves = normalized.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
	const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
	if (groups.length !== 8) return null;
	let value = 0n;
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
		value = (value << 16n) + BigInt(Number.parseInt(group, 16));
	}
	return value;
}

async function resultFromResponse(
	inputUrl: string,
	response: FetchLikeResponse,
	maxBytes: number,
	safeRedirected = false,
): Promise<UrlReadResult> {
	const contentType = response.headers.get("content-type");
	const read = await readBoundedBody(response, maxBytes);
	const text = decodeBody(read.bytes, contentType);
	const signals = classifySignals(response, text);
	const redirected = safeRedirected || response.redirected || urlsDiffer(inputUrl, response.url);
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

function blockedResult(inputUrl: string, signal: string, error: UrlReadError): UrlReadResult {
	return {
		input_url: inputUrl,
		final_url: null,
		verdict: "blocked",
		status: null,
		status_text: null,
		content_type: null,
		redirected: false,
		title: null,
		snippet: null,
		signals: [signal],
		truncated: false,
		bytes_read: 0,
		error,
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
