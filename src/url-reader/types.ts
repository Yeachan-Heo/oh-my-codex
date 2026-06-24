export type UrlReadVerdict = "ok" | "blocked" | "error" | "redirect";

export interface UrlReadError {
	name: string;
	message: string;
	code?: string;
}

export interface UrlReadResult {
	input_url: string;
	final_url: string | null;
	verdict: UrlReadVerdict;
	status: number | null;
	status_text: string | null;
	content_type: string | null;
	redirected: boolean;
	title: string | null;
	snippet: string | null;
	signals: string[];
	truncated: boolean;
	bytes_read: number;
	error: UrlReadError | null;
}

export interface FetchLikeResponse {
	readonly status: number;
	readonly statusText: string;
	readonly url: string;
	readonly redirected: boolean;
	readonly body: ReadableStream<Uint8Array> | null;
	readonly headers: {
		get(name: string): string | null;
	};
}

export type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<FetchLikeResponse>;

export type ResolveHostname = (hostname: string) => Promise<string[]>;

export interface UrlReaderOptions {
	fetch?: FetchLike;
	resolveHostname?: ResolveHostname;
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
}
