import { readUrl } from "../url-reader/index.js";
import type { UrlReaderOptions } from "../url-reader/types.js";

const HELP = `omx url - Passive URL reader

Usage:
  omx url read <url> --json

Options:
  --json       Emit structured JSON (required for v0)
  -h, --help   Show this help

Examples:
  omx url read https://example.com --json

This command passively reads a user-supplied URL and classifies the reachable
response. It only supports http(s), resolves hosts before fetch, blocks local or
internal network targets, and re-validates redirects before following them. To
avoid DNS rebinding/TOCTOU in the Node v0 runtime, HTTP hostname requests are
sent to a validated pinned IP with the original Host header; HTTPS hostnames are
blocked because this fetch path cannot safely pin the TCP connection while also
preserving TLS SNI/certificate validation. Direct public IP HTTPS URLs remain
allowed. It does not bypass challenges, use a browser, inject cookies, or take
over any global binary/PATH ownership.
`;

const HELP_TOKENS = new Set(["--help", "-h", "help"]);

export interface ParsedUrlReadArgs {
	url: string;
	json: boolean;
}

export function parseUrlReadArgs(args: string[]): ParsedUrlReadArgs {
	let json = false;
	const positionals: string[] = [];

	for (const token of args) {
		if (token === "--json") {
			json = true;
			continue;
		}
		if (HELP_TOKENS.has(token)) {
			return { url: "", json: false };
		}
		if (token.startsWith("-")) {
			throw new Error(`Unknown option: ${token}\n${HELP}`);
		}
		positionals.push(token);
	}

	if (positionals.length === 0) {
		throw new Error(`Missing URL.\n${HELP}`);
	}
	if (positionals.length > 1) {
		throw new Error(`Unexpected extra argument: ${positionals[1]}\n${HELP}`);
	}
	if (!json) {
		throw new Error(`Missing required --json flag.\n${HELP}`);
	}

	return { url: positionals[0], json };
}

export async function urlCommand(
	args: string[],
	options: UrlReaderOptions = {},
): Promise<void> {
	const subcommand = args[0];
	if (!subcommand || HELP_TOKENS.has(subcommand)) {
		console.log(HELP.trim());
		return;
	}

	if (subcommand !== "read") {
		throw new Error(`Unknown url subcommand: ${subcommand}\n${HELP}`);
	}

	if (args.slice(1).some((token) => HELP_TOKENS.has(token))) {
		console.log(HELP.trim());
		return;
	}

	const parsed = parseUrlReadArgs(args.slice(1));
	const result = await readUrl(parsed.url, options);
	console.log(JSON.stringify(result, null, 2));
}
