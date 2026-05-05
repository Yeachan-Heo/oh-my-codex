# Proposal

<Change>
  <Goal>Strengthen Cursor-mode CLI confidence with reproducible e2e checks and clear user-facing help.</Goal>
  <In_Scope>
    - Add e2e coverage for `omx mode` persistence and `omx cursor apply --run` invocation path.
    - Ensure top-level CLI help documents Cursor/mode entrypoints.
    - Keep Cursor adapter workflow additive; no behavior changes to Codex execution surfaces.
  </In_Scope>
  <Out_Of_Scope>
    - No redesign of Cursor prompt contract beyond existing apply prompt text.
    - No CI workflow or adapter file schema rewrite.
    - No change to team/runtime orchestration behavior.
  </Out_Of_Scope>
  <Risk>
    - E2E tests could be flaky if they depend on host-installed Cursor binaries.
    - Help-text updates could drift from command behavior without test coverage.
  </Risk>
  <Rollback>
    - code rollback
    - config rollback
  </Rollback>
</Change>
