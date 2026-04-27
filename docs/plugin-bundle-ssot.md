# Plugin Bundle SSOT Contract

The repository keeps one canonical authoring surface for each plugin/setup asset type and treats `plugins/oh-my-codex` as generated-or-verified plugin output.

## Canonical roots

- **Plugin skills:** root `skills/<name>/SKILL.md` is canonical. The plugin mirror at `plugins/oh-my-codex/skills/<name>/` is refreshed by `npm run sync:plugin` and verified by `npm run verify:plugin-bundle`.
- **Plugin skill membership:** `templates/catalog-manifest.json` controls which catalog skills are installable. Active/internal skills, plus setup-only policy additions, must have canonical root skill directories and plugin mirrors.
- **Plugin MCP metadata:** `src/config/omx-first-party-mcp.ts` is canonical. `plugins/oh-my-codex/.mcp.json` must match `buildOmxPluginMcpManifest()`.
- **Plugin manifest version and paths:** `package.json` is canonical for the plugin version. The plugin manifest must point to `./skills/`, `./.mcp.json`, and `./.app.json`.
- **Native agents and prompts:** root `prompts/` plus `src/agents/definitions.ts` are setup-owned canonical sources. The official plugin intentionally does not ship plugin-scoped `agents`, `prompts`, or hooks.

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

Native agents are setup-owned assets, not plugin-scoped bundle assets. Their source-of-truth chain is:

1. `templates/catalog-manifest.json` and `src/catalog/manifest.json` select installable native agents with `active` or `internal` status.
2. `src/agents/definitions.ts` defines each native agent's metadata, model lane, posture, routing role, and tooling posture.
3. `prompts/<name>.md` supplies the prompt body for each installable native agent.
4. `src/agents/native-config.ts` generates native Codex TOML from the definition plus prompt.
5. `omx setup` writes generated TOML to `.codex/agents/<name>.toml` for the selected scope.

Run the non-mutating native-agent verifier before review or release:

```bash
npm run verify:native-agents
```

The verifier fails when installable catalog agents are missing definitions or prompts, when definitions are missing catalog rows, when merged/alias canonical targets do not resolve directly to installable agents, when prompt files are neither cataloged native agents nor explicit setup prompt assets, or when generated TOML loses required metadata.

The official plugin manifest must continue to omit `agents`, `prompts`, and `hooks`; those remain installed by `omx setup`, not by the plugin bundle.
