/**
 * Bound and redact operator/agent text before it crosses the OMX -> Herdr
 * boundary. OMX lifecycle context can contain prompts, source text, absolute
 * paths, and secrets; none of that should be shipped verbatim to Herdr's
 * display surfaces. Applied to the semantic `message` and to display-only
 * metadata tokens.
 */

export const MAX_MESSAGE_LEN = 120;
export const MAX_TOKEN_KEY_LEN = 32;
export const MAX_TOKEN_VALUE_LEN = 80;
export const MAX_TOKENS = 16;

const SECRET_KEY_PATTERN =
	/(secret|token|password|passwd|api[_-]?key|authorization|bearer|credential|private[_-]?key|access[_-]?key)/i;
const SECRET_VALUE_PATTERN =
	/(bearer\s+[a-z0-9._-]+|sk-[a-z0-9]{8,}|gh[pousr]_[a-z0-9]{8,}|eyj[a-z0-9._-]{10,}|[a-f0-9]{32,})/i;
const ABS_PATH_PATTERN = /(?:\/[^\s:]+){2,}|[a-zA-Z]:\\[^\s]+/g;

function collapseWhitespace(value: string): string {
	return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function redactPaths(value: string): string {
	return value.replace(ABS_PATH_PATTERN, "[path]");
}

/** Sanitize a semantic message: collapse whitespace, redact paths/secrets, cap length. */
export function sanitizeMessage(
	message: string | undefined,
	maxLen = MAX_MESSAGE_LEN,
): string | undefined {
	if (message === undefined) return undefined;
	let out = collapseWhitespace(message);
	if (out.length === 0) return undefined;
	if (SECRET_VALUE_PATTERN.test(out)) out = "[redacted]";
	out = redactPaths(out);
	if (out.length > maxLen) out = `${out.slice(0, maxLen - 1)}…`;
	return out;
}

/**
 * Sanitize display-only metadata tokens: cap key/value length and token count,
 * drop secret-like keys/values, redact absolute paths. Returns undefined when
 * nothing survives.
 */
export function sanitizeMetadata(
	metadata: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!metadata) return undefined;
	const out: Record<string, string> = {};
	let count = 0;
	for (const [rawKey, rawValue] of Object.entries(metadata)) {
		if (count >= MAX_TOKENS) break;
		if (typeof rawValue !== "string") continue;
		const key = rawKey.slice(0, MAX_TOKEN_KEY_LEN);
		if (SECRET_KEY_PATTERN.test(key)) continue;
		let value = collapseWhitespace(rawValue);
		if (value.length === 0) continue;
		if (SECRET_VALUE_PATTERN.test(value)) {
			value = "[redacted]";
		} else {
			value = redactPaths(value);
		}
		if (value.length > MAX_TOKEN_VALUE_LEN) {
			value = `${value.slice(0, MAX_TOKEN_VALUE_LEN - 1)}…`;
		}
		out[key] = value;
		count += 1;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
