---
name: visual-ralph
description: "Visual Ralph orchestration for frontend UI from generated references, static references, or live URL targets, using $ralph with $visual-verdict and pixel-diff evidence until the implementation matches and leaves a reproducible design system."
---

# Visual Ralph Skill

Use this skill when the user wants Codex to build or restyle frontend UI through a Visual Ralph loop: an approved generated reference, static reference, or live URL-derived baseline becomes the target, Ralph implements, and Visual Verdict drives measured iteration rather than subjective description alone.

## Purpose

Create a measured frontend delivery loop from either a generated reference, a static reference, or a live URL:

`user description / live URL -> approved visual reference -> $ralph implementation -> $visual-verdict + pixel diff -> reproducible design system`.

For live URL cloning requests, Visual Ralph owns the migrated `$web-clone` use case. Do not route new URL-driven website cloning work to `$web-clone`; preserve the URL, viewport, fidelity requirements, and interaction notes inside the Visual Ralph loop.

This is an orchestration skill. It composes existing skills and must not add runtime commands, dependencies, or app-specific assumptions by itself.

## Use when

- The user describes a desired web/app UI and wants implementation, not just design advice.
- The user provides a live URL and wants a visual implementation or clone through measured Visual Verdict iteration.
- A generated raster mockup/reference image would make the target clearer.
- The task needs pixel-level visual iteration with a pass/fail threshold.
- The final result should leave reusable design tokens/components, not only a one-off screenshot match.

## Do not use when

- The user only wants design critique or general frontend advice; use `$frontend-ui-ux` or a designer lane.
- The task is a non-visual backend/API implementation with no UI reference target.
- The user already supplied a final static reference image and only needs comparison/fixes; hand directly to `$ralph` with `$visual-verdict` guidance.
- The requested output is a deterministic SVG/vector/code-native asset rather than a raster reference.

## Workflow

### 1. Ground the target repo

Before stack-specific choices, inspect local evidence:
- package manager and scripts,
- frontend framework and routing structure,
- styling system and design-token conventions,
- screenshot/test tooling,
- existing components that should be reused.

Do not hardcode React, Vue, Tailwind, Playwright, or any other stack unless the repository evidence supports it.

### 2. Establish the visual reference

For live URL requests, capture or document the URL-derived reference inside the Visual Ralph artifacts and carry forward viewport, content-state, and interaction constraints. Do not invoke `$web-clone`; that standalone skill is hard-deprecated.

Live URL reference artifacts must include:
- source URL and permission/scope note,
- viewport(s), route/state, and any seed/login assumptions,
- captured baseline screenshot path or documented capture command/tool,
- interaction parity notes for visible controls,
- known exclusions such as backend/API/auth, personalized data, multi-page crawling, and third-party widget parity.

For generated UI concepts, use `$imagegen` to produce the reference from the user's UI description.

Prompt requirements:
- classify as `ui-mockup`, unless another imagegen taxonomy is clearly better,
- include viewport/aspect ratio and intended surface,
- specify layout, hierarchy, typography direction, color mood, and any exact text,
- forbid logos/watermarks/unrequested brand marks,
- ask imagegen to avoid impossible UI details or unreadable text.

For project-bound implementation, copy the approved reference into the workspace, for example under `.omx/artifacts/visual-ralph/<slug>/reference.png`. Never leave the implementation reference only in `$CODEX_HOME/generated_images/...`.

### 3. Require explicit user approval

Stop after reference generation or URL-derived reference capture and ask the user to approve one reference image/state or request a targeted regeneration/capture adjustment.

Before approval:
- do not start frontend implementation,
- do not invoke `$ralph`,
- do not treat a rough image as final.

After approval, the confirmed image or URL-derived baseline becomes the visual source of truth. Major design pivots, replacing the reference, or changing the design direction require an explicit user request.

### 4. Hand off to `$ralph` for implementation

Invoke `$ralph` with:
- the approved reference image path or URL-derived baseline artifact,
- source URL, viewport(s), content state, and interaction parity notes for live URL tasks,
- the user description,
- the detected repo/frontend context,
- exact screenshot command/viewport requirements,
- the completion checklist below.

Ralph may iterate autonomously after approval. It should edit code, run the app, capture screenshots, and keep improving until the approved reference is matched or a real blocker exists.

### 5. Use `$visual-verdict` before every next edit

For each visual iteration:
1. Capture the current generated screenshot with recorded viewport/state.
2. Run `$visual-verdict` comparing the approved reference and generated screenshot.
3. Treat the JSON verdict as authoritative.
4. If `score < 90`, convert `differences[]` and `suggestions[]` into the next edit plan.
5. Rerun before the next edit.

Required verdict shape is inherited from `$visual-verdict`: `score`, `verdict`, `category_match`, `differences[]`, `suggestions[]`, and `reasoning`.

### 6. Use pixel diff only as secondary debug evidence

When mismatch diagnosis is hard, generate a pixel diff or pixelmatch overlay to locate hotspots. Pixel diff does not replace `$visual-verdict`; it only helps translate visual hotspots into concrete edits.

Record final diff evidence with the reference/screenshot artifacts so the result can be audited.

### 7. Build a reproducible design system

The implementation is incomplete unless the visual match is encoded in repo-native reusable artifacts. Depending on the project, this may mean CSS variables, theme tokens, Tailwind config, component variants, Storybook stories, design docs, or existing equivalents.

Capture at least the applicable:
- colors,
- spacing scale,
- typography scale/weights,
- radii,
- shadows/elevation,
- important component variants and states.

Prefer existing token/component patterns. Do not introduce a new design-system layer if the repo already has one that can be extended.

## Completion checklist

Do not declare done until all are true:
- Approved reference image or URL-derived reference artifact is saved in the workspace.
- Screenshot reproduction command, viewport, route, seed/state, and output paths are documented.
- `$visual-verdict` final score is `>= 90` against the approved reference.
- Pixel diff or overlay evidence is recorded as secondary debug evidence.
- Design-system tokens/components are repo-native and reusable.
- Build/lint/test or the repo's equivalent verification passes.
- No unapproved major design pivot occurred after reference approval.
- Remaining visual differences, if any, are explicitly documented with rationale.

## Handoff template

```text
$ralph "Implement the approved frontend reference.
Reference: <workspace-reference-image-or-url-derived-artifact>
Source URL (if URL-derived): <url and permission/scope note>
Viewport/content state: <viewport, route/state, seed/login assumptions>
Interaction parity notes: <visible controls and known exclusions>
Route/surface: <route or component>
Screenshot command: <command and viewport>
Use $visual-verdict before every next edit; pass threshold score >= 90.
Use pixel diff only as secondary debug evidence.
Extract reusable design tokens/components for colors, spacing, typography, radii, shadows, and key variants.
Run build/lint/test before completion.
Do not make major design pivots unless explicitly requested."
```

Task: {{ARGUMENTS}}
