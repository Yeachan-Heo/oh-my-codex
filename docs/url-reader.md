# Passive URL reader

`omx url read <url> --json` performs a passive, bounded fetch of a user-supplied
HTTP(S) URL and emits structured JSON for automation.

The v0 reader is intentionally conservative:

- no browser automation or browser dependency
- no cookie injection, challenge solving, or bot-detection bypass
- no global binary or `PATH` ownership changes
- bounded response reads before text decoding
- structured `verdict` values: `ok`, `redirect`, `blocked`, or `error`

Example:

```sh
omx url read https://example.com --json
```

The JSON result includes the input URL, final URL, HTTP status, content type,
redirect flag, best-effort title/snippet for text-like responses, blocked/challenge
signals, truncation metadata, and safe error details when the read fails.
