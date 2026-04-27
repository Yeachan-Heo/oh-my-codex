# Plugin Bundle SSOT Contract

The repository keeps one canonical authoring surface for each plugin/setup asset type and treats `plugins/oh-my-codex` as generated-or-verified plugin output.

## Canonical roots

- **Plugin skills:** root `skills/<name>/SKILL.md` is canonical. The plugin mirror at `plugins/oh-my-codex/skills/<name>/` is refreshed by `npm run sync:plugin` and verified by `npm run verify:plugin-bundle`.
- **Plugin skill membership:** `templates/catalog-manifest.json` controls which catalog skills are installable. Active/internal skills, plus setup-only policy additions, must have canonical root skill directories and plugin mirrors.
- **Plugin MCP metadata:** `src/config/omx-first-party-mcp.ts` is canonical. `plugins/oh-my-codex/.mcp.json` must match `buildOmxPluginMcpManifest()`.
- **Plugin manifest version and paths:** `package.json` is canonical for the plugin version. The plugin manifest must point to `./skills/`, `./.mcp.json`, and `./.app.json`.
- **Native agents and prompts:** root `prompts/` plus `src/agents/definitions.ts` are setup-owned canonical sources for legacy setup mode. The official plugin intentionally does not ship plugin-scoped `agents`, `prompts`, or hooks; plugin setup archives/removes legacy OMX-managed prompt and native-agent files so users do not keep stale mixed surfaces.

## Commands

```bash
npm run sync:plugin           # mutate plugin mirror/metadata from canonical roots
npm run verify:plugin-bundle  # non-mutating SSOT check for CI/review
npm run sync:plugin:check     # compatibility alias for the same non-mutating check
```

`prepack` runs sync and verification before packaging, but contributors should run the non-mutating verification before review so release-time sync does not hide stale plugin artifacts.

## Adding or changing a skill

1. Edit or add the root skill under `skills/<name>/SKILL.md`.
2. Add/update the skill entry in `templates/catalog-manifest.json` and `src/catalog/manifest.json`.
3. Run `npm run build && npm run sync:plugin`.
4. Run `npm run verify:plugin-bundle`.

Root skill directories that should not appear in the plugin must be represented in the catalog as `alias` or `merged`; otherwise the plugin bundle verifier fails because the root directory is neither installable nor explicitly excluded.

## Native agent SSOT

Native agents are setup-owned assets, not plugin-scoped bundle assets. Generated native-agent TOMLs and prompt files intentionally use different setup policies:

1. `templates/catalog-manifest.json` and `src/catalog/manifest.json` select installable native agent TOMLs with `active` or `internal` status.
2. `src/agents/definitions.ts` defines each native agent's metadata, model lane, posture, routing role, and tooling posture.
3. `prompts/<name>.md` supplies prompt guidance. Cataloged prompt files remain setup-owned prompt assets even when their agent status is `merged`, `alias`, or `deprecated`; explicit non-native prompt assets such as harness/orchestrator prompts are also setup-owned.
4. `src/agents/native-config.ts` generates native Codex TOML from the definition plus prompt for active/internal native agents only.
5. `omx setup` writes generated TOML to `.codex/agents/<name>.toml` for the selected scope and installs setup-owned prompts to `.codex/prompts/<name>.md`.

Run the non-mutating native-agent verifier before review or release:

```bash
npm run verify:native-agents
```

The verifier fails when installable catalog agents are missing definitions or prompts, when definitions are missing catalog rows, when merged/alias canonical targets do not resolve directly to installable agents, when prompt files are neither cataloged native agents nor explicit setup prompt assets, or when generated TOML loses required metadata.

`omx setup` converges generated native-agent TOMLs safely: normal setup removes stale non-installable TOMLs only when they carry the exact `# oh-my-codex agent: <name>` generated marker for the same cataloged agent name. User-authored or ambiguous TOMLs are preserved during normal setup; `--force` remains the explicit destructive cleanup path for stale non-installable native-agent files. Prompt cleanup uses the prompt asset policy, so cataloged prompt files and explicit setup prompt assets are preserved even when they are not installable native-agent TOMLs.

The official plugin manifest must continue to omit `agents`, `prompts`, and `hooks`; legacy setup mode installs prompts/native agents, while plugin setup mode removes archived legacy copies instead of refreshing plugin-scoped prompt or agent assets.
