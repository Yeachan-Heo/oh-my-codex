---
name: visual-ralph
description: "Visual Ralph orchestration for frontend UI from generated references, static references, or live URL targets, using $ultragoal with built-in visual verdict and pixel-diff evidence until the implementation matches and leaves a reproducible design system."
---

# Visual Ralph Skill

Use `$visual-ralph` for measured frontend implementation from an approved generated reference, static image, or live-URL baseline. The loop is:

`description / URL -> approved reference -> $ultragoal implementation -> Visual Ralph verdict + pixel diff -> reusable design system`.

For URL cloning, this skill owns the migrated `$web-clone` use case; preserve URL, viewport, fidelity, and interaction notes here. Do not invoke standalone `$web-clone`.

Shared operating, delegation, state, hook, team, cancellation, and verification invariants live in [`templates/AGENTS.md`](../../templates/AGENTS.md). Follow that source instead of duplicating its rules here.

## Use when

- The user wants a web/app UI built or restyled against a visual target.
- A live URL or generated raster mockup needs measured implementation and pixel-level iteration.
- The result must leave reusable repo-native tokens/components, not only a matching screenshot.

Do not use it for a durable `DESIGN.md` brief (`$design`), non-visual backend work, comparison-only fixes that can be executed directly, or deterministic SVG/code-native assets.

## Workflow

### 1. Ground the repository

Inspect package manager/scripts, frontend framework and routes, styling/token conventions, screenshot tooling, and reusable components. Choose stack-specific commands only when repository evidence supports them.

### 2. Establish a reference

For a live URL, capture or document an artifact containing source URL and permission/scope, viewport(s), route/state, seed/login assumptions, baseline screenshot path or capture command, visible-control parity notes, and exclusions (backend/API/auth, personalized data, crawling, third-party widgets).

For a generated concept, use `$imagegen` with classification `ui-mockup`, viewport/aspect ratio, surface, layout hierarchy, typography, color mood, exact text, no logos/watermarks/unrequested marks, and readable/feasible UI details. In OMX runtime, queue the continuation checkpoint before the built-in image tool:

```bash
omx imagegen continuation <session-id> --artifact <slug-or-filename> --generated-dir "$CODEX_HOME/generated_images/<session>" --work-dir ".omx/artifacts/visual-ralph/<slug>"
```

Copy the approved reference into `.omx/artifacts/visual-ralph/<slug>/reference.png`; do not leave it only under `$CODEX_HOME/generated_images`.

### 3. Approval gate

Stop after generation or URL capture and obtain approval of one reference image/state (or a targeted regeneration/capture adjustment). Before approval, do not implement or invoke `$ultragoal`. After approval, the image/baseline is the visual source of truth; major pivots require an explicit user request.

### 4. Hand off to `$ultragoal`

Pass the approved reference/baseline, URL and permission note when applicable, viewport/content state, interaction parity and exclusions, user description, detected frontend context, screenshot command/viewport, and the completion checklist. The active Ultragoal execution lane edits, runs, captures, and iterates after approval until matched or blocked.

### 5. Verdict before every edit

For each iteration, capture the current screenshot with viewport/state, run Visual Ralph verdict (using `vision` when needed), and treat its JSON as authoritative. If `score < 90`, turn `differences[]` and `suggestions[]` into the next edit plan and rerun before editing. Required verdict keys: `score`, `verdict`, `category_match`, `differences[]`, `suggestions[]`, `reasoning`.

### 6. Secondary diff evidence

Use pixel diff/pixelmatch overlays only to locate hotspots and translate them into edits; they never replace the verdict. Record final reference, screenshot, and diff artifacts for auditability.

### 7. Reusable design system

Encode the match in existing repo-native CSS variables, theme tokens, config, component variants, stories, or `DESIGN.md` updates. Capture applicable colors, spacing, typography/weights, radii, shadows/elevation, and important variants/states. Extend existing patterns rather than adding a parallel layer.

## Completion evidence and stop conditions

Do not declare done until the approved reference/baseline and reproduction command (viewport, route, state, output path) are saved; final verdict is `>= 90`; secondary diff evidence is recorded; reusable tokens/components exist; equivalent build/lint/test verification passes; no unapproved pivot occurred; and remaining differences are documented. Stop at the approval gate or report a concrete blocker when evidence cannot satisfy these conditions.

## Handoff template

```text
$ultragoal "Implement the approved frontend reference.
Reference: <workspace reference or URL-derived artifact>
Source URL and permission/scope: <when applicable>
Viewport/content state: <viewport, route/state, seed/login assumptions>
Interaction parity and exclusions: <visible controls and known limits>
Route/surface: <route or component>
Screenshot command: <command and viewport>
Run Visual Ralph verdict before every next edit; pass threshold >= 90.
Use pixel diff only as secondary evidence.
Extract reusable tokens/components for colors, spacing, typography, radii, shadows, and variants.
Run the repository's equivalent verification before completion.
Do not make major design pivots unless explicitly requested."
```

Task: {{ARGUMENTS}}
