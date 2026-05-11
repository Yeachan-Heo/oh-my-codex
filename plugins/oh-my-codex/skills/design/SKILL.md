---
name: design
description: Canonical repo-local DESIGN.md workflow for product, UI/UX, and frontend decision source of truth
---

# Design Skill

Use `$design` when product, UI/UX, frontend, or design-system decisions need a durable source of truth in the repository. This skill discovers existing design context, interviews for missing product/design information, and creates or refreshes repo-local `DESIGN.md` so future UI/UX/frontend work is grounded instead of improvised.

## Purpose

Make repo-local `DESIGN.md` source of truth and canonical design contract for the current repository:

`existing repo evidence -> missing-context interview -> create/refresh DESIGN.md -> use DESIGN.md for UI/UX/frontend decisions`.

The output is not a pixel-matching loop and not a one-off visual critique. It is the maintained design brief/checklist that implementation, review, and future visual work should cite.

## Use when

- The user asks for design direction, UX guidance, frontend planning, or design-system alignment.
- A repo needs a design brief before UI/frontend implementation begins.
- Existing UI/components/assets/screenshots need to be summarized into a reusable design source of truth.
- UI/UX/frontend decisions are ambiguous and should be resolved through product context, constraints, and documented principles.
- A feature needs `DESIGN.md` created or refreshed before `$ralph`, a designer lane, or implementation work proceeds.

## Do not use when

- The user provides or requests a visual reference/image/live URL and wants measured implementation until screenshots match. Use `$visual-ralph` for that visual-reference implementation loop.
- The task is pure backend/API/infrastructure work with no user-facing design consequence.
- The user only asks to compare screenshots or score visual fidelity. Use `$visual-ralph` and its built-in visual verdict flow.

## Relationship to `$visual-ralph`

`$design` owns the durable repo design source of truth: product goals, users, IA, visual language, components, accessibility, constraints, and open questions in `DESIGN.md`.

`$visual-ralph` owns implementation against an approved generated/static/live-URL visual reference, with screenshot capture, Visual Ralph verdict scoring, and pixel-diff evidence. `$visual-ralph` may read `DESIGN.md`, and it may leave design-system artifacts behind, but it does not replace the `DESIGN.md` discovery/interview/refresh workflow.

If both are needed, run `$design` first to establish the design contract, then run `$visual-ralph` only after the visual reference/baseline is approved.

## Workflow

### 1. Discover local design evidence

Inspect the repository before writing guidance. Look for:

- `DESIGN.md`, `docs/design*`, `docs/ux*`, `docs/frontend*`, `README.md`, product specs, PRDs, and issue notes.
- Existing UI source: routes, pages, layouts, components, stories, examples, demos, theme files, CSS variables, Tailwind/theme config, tokens, icons, and assets.
- Screenshots, mockups, brand files, logos, Figma/export notes, Storybook snapshots, Playwright screenshots, visual-regression baselines, or `.omx/artifacts/visual-ralph/*` references.
- Accessibility, responsive, i18n, content, and platform constraints already encoded in code or docs.

Record evidence with file paths. Distinguish observed facts from design inferences.

### 2. Interview only for missing context

Ask concise questions only when repo evidence cannot answer design-critical context. Prefer one focused round that closes the biggest gaps, such as:

- target users/personas and jobs to be done,
- product/business goals and non-goals,
- brand personality or forbidden aesthetics,
- primary flows and information architecture,
- accessibility level, device/browser support, and implementation constraints,
- existing design assets or references the repo does not contain.

If the user wants autonomous progress or cannot answer, create `DESIGN.md` with explicit assumptions and open questions instead of blocking.

### 3. Create or refresh `DESIGN.md`

Use the structure below. Preserve useful existing content, remove contradictions, and mark unknowns as open questions. Keep it actionable for implementers and reviewers.

#### Required `DESIGN.md` structure/checklist

```markdown
# Design

## Source of truth
- Status: Draft | Active | Needs refresh
- Last refreshed: YYYY-MM-DD
- Primary product surfaces:
- Evidence reviewed:

## Brand
- Personality:
- Trust signals:
- Avoid:

## Product goals
- Goals:
- Non-goals:
- Success signals:

## Personas and jobs
- Primary personas:
- User jobs:
- Key contexts of use:

## Information architecture
- Primary navigation:
- Core routes/screens:
- Content hierarchy:

## Design principles
- Principle 1:
- Principle 2:
- Tradeoffs:

## Visual language
- Color:
- Typography:
- Spacing/layout rhythm:
- Shape/radius/elevation:
- Motion:
- Imagery/iconography:

## Components
- Existing components to reuse:
- New/changed components:
- Variants and states:
- Token/component ownership:

## Accessibility
- Target standard:
- Keyboard/focus behavior:
- Contrast/readability:
- Screen-reader semantics:
- Reduced motion and sensory considerations:

## Responsive behavior
- Supported breakpoints/devices:
- Layout adaptations:
- Touch/hover differences:

## Interaction states
- Loading:
- Empty:
- Error:
- Success:
- Disabled:
- Offline/slow network, if applicable:

## Content voice
- Tone:
- Terminology:
- Microcopy rules:

## Implementation constraints
- Framework/styling system:
- Design-token constraints:
- Performance constraints:
- Compatibility constraints:
- Test/screenshot expectations:

## Open questions
- [ ] Question / owner / impact
```

### 4. Use `DESIGN.md` as the decision contract

For UI/UX/frontend work after the refresh:

- Cite the relevant `DESIGN.md` sections before making design choices.
- Prefer existing components, tokens, and documented constraints.
- If implementation reveals a design contradiction, update `DESIGN.md` or add an open question before proceeding.
- Do not introduce a new design-system layer when existing repo-native patterns can be extended.

### 5. Handoff to implementation or Visual Ralph when appropriate

- For normal frontend implementation, hand off with the relevant `DESIGN.md` sections, repo evidence, and acceptance criteria.
- For visual-reference/image/live-URL matching, hand off to `$visual-ralph` with the approved reference/baseline and note that `DESIGN.md` is supporting context, not the visual verdict target.

## Completion checklist

Do not declare the design workflow complete until:

- Existing design docs/assets/components/screenshots have been inspected or explicitly noted as absent.
- Missing product/design context has been answered, assumed, or listed in `DESIGN.md` open questions.
- `DESIGN.md` exists at the repo root and contains all required checklist sections.
- UI/UX/frontend recommendations cite `DESIGN.md` rather than relying on unstated preferences.
- Any `$visual-ralph` handoff is clearly separated as visual implementation matching, not DESIGN.md governance.

Task: {{ARGUMENTS}}
