# Migration Guide: Codex Flow -> Cursor Mode (Additive)

This guide migrates teams to the new Cursor mode while preserving existing Codex support.

## Goals

1. Keep current `omx` Codex workflow available.
2. Enable a first-class Cursor mode (`omx mode cursor`).
3. Move model decision steps to Cursor CLI, with CI drift gate enforcement.

## Step 1: Verify prerequisites

```bash
npm install
npm run build
command -v cursor-agent || command -v cursor
```

If neither `cursor-agent` nor `cursor` exists, install Cursor CLI first.

## Step 2: Check mode support

```bash
node dist/cli/omx.js mode show
node dist/cli/omx.js mode cursor
node dist/cli/omx.js mode show
```

Expected:
- mode changes from `codex` to `cursor`.
- mode state persists in `.omx/mode.json`.

## Step 3: Validate adapter assets

```bash
node dist/cli/omx.js cursor doctor
```

Expected:
- adapter files present
- Cursor CLI detected
- doctor passes

## Step 4: Start cursor-first flow

```bash
scripts/omc.sh mode cursor
scripts/omc.sh new feature-sample
scripts/omc.sh plan feature-sample
scripts/omc.sh apply feature-sample
scripts/omc.sh review feature-sample
scripts/omc.sh archive feature-sample
```

## Step 5: PR template and CI gate

Ensure PR body contains:

```text
Change Path: `openspec/changes/<change-slug>/`
```

`PR Check` workflow will run `cursor-drift-gate` on pull_request events.

## Rollback to Codex mode

If team needs to temporarily disable cursor-first behavior:

```bash
node dist/cli/omx.js mode codex
```

Existing Codex commands remain unchanged.

## Recommended rollout

- Week 1: shadow mode (use cursor flow for 20-30% PRs)
- Week 2: default mode cursor for most feature PRs
- Week 3: enforce cursor drift gate as required status check

