# Prometheus-inspired deliberate planning recipe (experimental)

This is a non-canonical recipe, not an active OMX skill, keyword, hook, or native-agent surface.
Use it only when an operator wants an extra manual checklist around the canonical
`$deep-interview -> $ralplan -> $ultragoal` path.

Credit: Inspired by the high-level OMO Prometheus concept (`code-yeongyu/oh-my-openagent`), reimplemented as concept-only guidance under MIT. This repository does not copy OMO source text, prompts, runtime code, or workflow implementation.

## Recipe

1. Run `$deep-interview` until requirements, non-goals, acceptance criteria, and unresolved assumptions are explicit.
2. Run `$ralplan` and require the plan to state:
   - objective and non-goals;
   - evidence versus assumptions;
   - verification gates;
   - rollback or escalation triggers;
   - whether any `$team` lanes are truly independent.
3. Before `$ultragoal`, manually challenge the plan with three questions:
   - What ambiguity could still change implementation scope?
   - What verification would catch the highest-cost failure?
   - What work split would create ownership conflicts or merge risk?
4. If the answers change the plan, revise the `$ralplan` artifact instead of creating a new workflow surface.
5. Hand the approved plan to `$ultragoal`; launch `$team` only inside a concrete Ultragoal story when parallel lanes are warranted.

## Boundaries

- Do not invoke `$prometheus-strict`; no such canonical active skill is shipped.
- Do not add Metis/Momus/Oracle prompt-backed native agents for this recipe.
- Do not create a separate Prometheus artifact convention; use existing `$deep-interview`, `$ralplan`, and `$ultragoal` artifacts.
