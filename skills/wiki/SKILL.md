---
name: wiki
description: Persistent markdown project wiki stored under repository omx_wiki with keyword search and lifecycle capture
triggers: ["wiki add", "wiki lint", "wiki query", "wiki read", "wiki delete"]
---

# Wiki

Persistent, self-maintained markdown knowledge base for project and session knowledge.

## Operations

### Ingest
```bash
omx wiki wiki_ingest --input '{"title":"Auth Architecture","content":"...","tags":["auth","architecture"],"category":"architecture"}' --json
```

### Query
```bash
omx wiki wiki_query --input '{"query":"authentication","tags":["auth"],"category":"architecture"}' --json
```

### Lint
```bash
omx wiki wiki_lint --json
```

### Quick Add
```bash
omx wiki wiki_add --input '{"title":"Page Title","content":"...","tags":["tag1"],"category":"decision"}' --json
```

### List / Read / Delete
```bash
omx wiki wiki_list --json
omx wiki wiki_read --input '{"page":"auth-architecture"}' --json
omx wiki wiki_delete --input '{"page":"outdated-page"}' --json
omx wiki wiki_refresh --json
```

## Categories
`architecture`, `decision`, `pattern`, `debugging`, `environment`, `session-log`, `reference`, `convention`

## Storage
- Pages: `omx_wiki/*.md`
- Index: `omx_wiki/index.md`
- Log: `omx_wiki/log.md`

## Cross-References
Use `[[page-name]]` wiki-link syntax to create cross-references between pages.

## Auto-Capture
At session end, discoveries can be captured as `session-log-*` pages. Configure via `wiki.autoCapture` in `.omx-config.json`.

## Hard Constraints
- No vector embeddings — query uses keyword + tag matching only
- Wiki files are repository project knowledge under `omx_wiki/`; legacy `.omx/wiki/` is read-only compatibility input when no canonical wiki exists
