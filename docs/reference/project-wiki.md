# Project wiki (OMX-native backport)

This note captures the approved OMX-native shape for the project wiki backport.
It is intentionally **not** a literal OMC port.

## Core shape

- Keep the reusable wiki domain under `src/wiki/*`.
- Expose wiki operations from a dedicated MCP server at `src/mcp/wiki-server.ts`.
- Register the server as `omx_wiki`.
- Keep wiki storage under `.omx/wiki/`.
- Do **not** add vector embeddings; query stays keyword/tag based.

## Config + generator contract

`omx setup` / the config generator should own the dedicated wiki MCP block:

```toml
[mcp_servers.omx_wiki]
command = "<absolute Node executable used by omx setup>"
args = ["<repo>/dist/mcp/wiki-server.js"]
enabled = true
```

The bootstrap/config path should treat `omx_wiki` as a first-party OMX server
alongside the existing built-ins, while keeping the diff small and idempotent.
Setup-managed first-party MCP blocks must use the stable absolute Node
executable that ran `omx setup` rather than a PATH-dependent bare `node`.

## Storage contract

Wiki state is project-local and should live under:

- `.omx/wiki/*.md` — content pages
- `.omx/wiki/index.md` — generated catalog
- `.omx/wiki/log.md` — append-only operation log

Guardrails that must stay true:

- reserved-file guard for `index.md` and `log.md`
- Unicode-safe slugging
- CRLF-safe frontmatter parsing
- single-pass unescape for escaped newlines
- punctuation filtering during tokenization
- CJK + accented-Latin tokenization support

The docs and code should never regress back to `.omc/wiki/`.

## Lifecycle + hook contract

- `SessionStart` stays **native** and **bounded**.
  - It may read `.omx/wiki/` and surface brief context when the wiki already exists.
  - It should stay read-mostly and must not block startup on heavy writes.
- `SessionEnd` stays **runtime-fallback** and **non-blocking**.
  - Best-effort capture is okay.
  - Missing wiki state should degrade to a no-op.
- Literal `PreCompact` parity is **deferred in v1** unless an OMX-native seam is proven clean.

## Routing contract

Wiki access should be explicit:

- prefer `$wiki`
- allow clear task verbs such as `wiki query`, `wiki add`, `wiki read`, `wiki delete`, `wiki ingest`, and `wiki lint`
- avoid implicit bare `wiki` noun activation in prompt routing

This keeps the routing surface specific enough to avoid false positives from ordinary prose.

## MCP tool surface

The dedicated `omx_wiki` server should expose the seven stabilized wiki tools:

- `wiki_ingest`
- `wiki_query`
- `wiki_lint`
- `wiki_add`
- `wiki_list`
- `wiki_read`
- `wiki_delete`

These tools should operate only on `.omx/wiki/` and keep lifecycle behavior bounded.
