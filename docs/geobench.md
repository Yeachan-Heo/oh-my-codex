# GEO benchmark for oh-my-codex

This repository includes a [`geobench`](https://github.com/NomaDamas/geobench) product spec for measuring LLM answer visibility: hit rate, MRR, share of voice, citation rate/share, and confidence intervals.

```bash
/path/to/geobench/dist/geobench estimate --product geobench/oh-my-codex.yaml --providers openai --tier cheap
/path/to/geobench/dist/geobench profile geobench/oh-my-codex.yaml
/path/to/geobench/dist/geobench bench --product geobench/oh-my-codex.yaml --providers openai --tier cheap --mode benchmark
```

Publish aggregate metrics only; do not publish raw provider answers, secrets, or private run logs.
