---
name: web-clone
description: "DEPRECATED: URL-driven website cloning has moved into $visual-ralph; use $visual-ralph for live-URL visual implementation workflows."
---

# Web Clone Skill (Hard Deprecated)

`$web-clone` is hard-deprecated. Do not start new work through this skill.

## Migration

Use `$visual-ralph` for the migrated live-URL use case. Visual Ralph now owns URL-driven visual implementation loops alongside generated-image and static-reference workflows:

- live URL or website cloning request -> `$visual-ralph`
- generated mockup/reference request -> `$visual-ralph` with `$imagegen`
- static screenshot/reference comparison -> `$ralph` with `$visual-verdict`

## Behavior

If this skill is selected by older routing, stop the standalone web-clone pipeline and reroute the task to `$visual-ralph` instead. Preserve the user's target URL, fidelity requirements, viewport constraints, and functional parity notes in the Visual Ralph handoff.

## Rationale

The URL extraction, visual iteration, and implementation verification responsibilities are now part of Visual Ralph's broader visual-delivery workflow. Keeping a second standalone cloning skill would split guidance and make verification behavior drift.
