# OMX Wiki

OMX Wiki is a compiled markdown knowledge layer for agents.

## What it is

- commit-friendly project knowledge stored under repository `omx_wiki/`
- markdown-first and search-first
- designed for agentic retrieval workflows, not vector-first RAG

## Core user surfaces

- `omx wiki add`
- `omx wiki query`
- `omx wiki lint`
- `omx wiki refresh`
- `omx wiki list`
- `omx wiki read`
- `omx wiki delete`

## Retrieval model

- Wiki pages are queried first when useful
- `omx explore` is deprecated and compatibility-only; prefer the wiki workflow plus normal Codex repository inspection before broader repository search
- repository search remains the fallback when wiki evidence is weak or missing

## Lifecycle model

- SessionStart can inject compact wiki context through the native hook path
- SessionEnd can capture session-log pages through the runtime cleanup path

## Constraints

- no vector embeddings required
- wiki is source-visible project knowledge intended for review/commit when useful
