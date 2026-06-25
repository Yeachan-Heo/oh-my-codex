# Passive URL reader

`omx url read <url> --json` performs a passive, bounded fetch of a user-supplied
HTTP(S) URL and emits structured JSON for automation.

The v0 reader is intentionally conservative:

- no browser automation or browser dependency
- no cookie injection, challenge solving, or bot-detection bypass
- no global binary or `PATH` ownership changes
- only `http:` and `https:` URLs are supported
- local, loopback, private, link-local, unique-local, multicast, reserved, and internal network addresses are blocked before fetching
- IPv6 special-purpose/reserved ranges are blocked, including local-use IPv4/IPv6 translation (`64:ff9b:1::/48`), discard-only/dummy prefixes (`100::/64`, `100:0:0:1::/64`), IETF protocol assignments (`2001::/23`), documentation (`2001:db8::/32`, `3fff::/20`), 6to4 (`2002::/16`), segment routing SIDs (`5f00::/16`), unique-local (`fc00::/7`), link-local (`fe80::/10`), multicast (`ff00::/8`), loopback, unspecified, and IPv4-mapped unsafe IPv4 addresses; public IPv6 is allowed
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
