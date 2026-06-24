# Passive URL reader

`omx url read <url> --json` performs a passive, bounded fetch of a user-supplied
HTTP(S) URL and emits structured JSON for automation.

The v0 reader is intentionally conservative:

- no browser automation or browser dependency
- no cookie injection, challenge solving, or bot-detection bypass
- no global binary or `PATH` ownership changes
- only `http:` and `https:` URLs are supported
- local, loopback, private, link-local, unique-local, multicast, reserved, and internal network addresses are blocked before fetching
- IPv6 unique-local (`fc00::/7`), link-local (`fe80::/10`), multicast (`ff00::/8`), loopback, unspecified, documentation/protocol-assignment ranges, and IPv4-mapped unsafe IPv4 addresses are blocked; public IPv6 is allowed
- hostnames are resolved before fetching; any unsafe resolved address blocks the read using the same address classifier as literal URLs
- redirects are followed manually and every redirect target is re-validated before the next fetch
- bounded response reads before text decoding
- structured `verdict` values: `ok`, `redirect`, `blocked`, or `error`

Example:

```sh
omx url read https://example.com --json
```

The JSON result includes the input URL, final URL, HTTP status, content type,
redirect flag, best-effort title/snippet for text-like responses, blocked/challenge
signals, truncation metadata, and safe error details when the read fails.
