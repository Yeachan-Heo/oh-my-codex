# TypeScript SDK

The OMX TypeScript SDK is a **Node.js 20+** public, importable surface for building tools on top of
`oh-my-codex` without shelling out for every operation. It has six layers:

1. **`OmxClient`** — a typed client for the local `omx api` gateway.
2. **`OmxApiDaemon`** — a small lifecycle wrapper that can start, discover, and stop the
   native localhost gateway from Node.
3. **`OmxWorkspace`** — read-only helpers for `.omx/state` workspace/runtime files.
4. **`OmxTeamClient`** — wrappers over the existing file-backed team API operations.
5. **`OmxCatalogClient`** — bundled skill/agent catalog and skill prompt helpers.
6. **`OmxRuntimeClient`** — launcher wrappers for plain `omx exec` prompts, `$skill` prompts, `omx resume`, and `codex fork`.

The SDK intentionally stays local-first and Node-only. It imports `node:fs`, `node:child_process`, and other Node runtime modules through the public root export. It talks to loopback `omx-api` endpoints and reads workspace files; it does not introduce cloud credentials or remote state.

The HTTP timeout covers request setup and response headers. Streaming helpers return async iterators; pass `{ signal }` as the second method argument to cancel long-running streams or requests. Breaking out of the async iterator cancels the response body reader.

## Public API surface

This SDK publishes the following root exports from `oh-my-codex`:

| Area | Public exports |
| --- | --- |
| Local API client | `OmxClient`, `OmxClientOptions`, `OmxClientDiscoveryOptions`, `resolveOmxApiClientOptions`, `readOmxDaemonState`, `readOmxDaemonToken`, `defaultOmxApiStateFile`, `daemonTokenFileForState` |
| Daemon lifecycle | `startOmxApiDaemon`, `readOmxApiDaemonStatus`, `buildOmxApiServeArgs`, `OmxApiDaemon` |
| Workspace state reads | `OmxWorkspace` |
| Team state operations | `OmxTeamClient`, `OmxTeamApiError` |
| Skill and agent catalog | `OmxCatalogClient` |
| Runtime launch helpers | `OmxRuntimeClient`, `OmxRuntimeSpawnOptions`, `buildCodexSessionArgs`, `buildCodexForkArgs`, `buildOmxResumeArgs`, `buildOmxExecArgs`, `buildOmxExecSkillArgs` |
| Codex profile mapping | `resolveCodexHome`, `readCodexConfig`, `resolveCodexProfile`, `codexProfileToApiEnv` |
| Transport and errors | `OmxHttpError`, `OmxSdkError`, `OmxTimeoutError`, `parseSseFrame`, `parseSseStream`, `OmxFetch` |
| Types | request, response, daemon, SSE, workspace, team, and JSON helper types exported from `src/sdk/types.ts` and the typed SDK modules |

The SDK scope is local Node.js automation for the current OMX installation. Browser, edge runtime, and multi-tenant server APIs should use separate entrypoints when added.

## Quick start

```ts
import { OmxClient, startOmxApiDaemon } from 'oh-my-codex';

const daemon = await startOmxApiDaemon({ backend: 'mock', port: 0 });
try {
  const text = await daemon.client.generateText('Say hello from OMX.');
  console.log(text);

  const client = await OmxClient.fromEnv({ stateFile: daemon.stateFile });
  console.log(await client.health());
} finally {
  await daemon.stop();
}
```

## API client

```ts
const client = new OmxClient({
  baseUrl: 'http://127.0.0.1:14510',
  bearerToken: process.env.OMX_API_LOCAL_BEARER,
});

await client.health();
await client.models();
await client.telemetry();
await client.responses.create({ model: 'omx-mock', input: 'ping' });
await client.chat.completions.create({ messages: [{ role: 'user', content: 'ping' }] });
await client.images.generate({ prompt: 'a tiny robot' });
await client.stop();
```

Streaming endpoints return async iterators over parsed SSE frames. The parser intentionally handles the OMX subset of SSE (`event:` and `data:` fields), ignores comments/`id`/`retry`, parses JSON `data:` payloads when possible, and otherwise returns the raw data string:

```ts
const controller = new AbortController();
const stream = await client.responses.stream(
  { input: 'stream please' },
  { signal: controller.signal, timeoutMs: 30_000 },
);
for await (const event of stream) {
  console.log(event.event, event.data);
}
```

## Daemon lifecycle

`startOmxApiDaemon()` resolves the packaged/native `omx-api` binary using the same logic as
`omx api`, spawns it in the background for the current Node process, waits for its daemon
state file, and returns an `OmxApiDaemon` controller. SDK-managed daemons use a unique temporary
state file in a private temporary directory by default; pass `stateFile` only when you intentionally
want a stable discovery path. SDK daemon helpers accept loopback bind hosts only. IPv6 loopback
state (`::1`) is formatted as a bracketed URL (`http://[::1]:PORT`) for client discovery.

```ts
const daemon = await startOmxApiDaemon({
  backend: 'mock',
  host: '127.0.0.1',
  port: 14510,
});

console.log(daemon.baseUrl);
await daemon.stop();
```

For an already-running daemon, use `OmxClient.fromEnv()` or `readOmxApiDaemonStatus()`.
Status reads require both a valid daemon state file and a live recorded process id.
Resolution order is:

1. explicit `baseUrl`
2. `OMX_API_BASE_URL`
3. daemon state file (`OMX_API_STATE_FILE`, or `~/.omx/state/api/omx-api-daemon.json` by default)
4. `OMX_API_PORT` or the default `14510`

Bearer-token resolution is intentionally conservative. Reuse a single `OmxClient` when possible;
`OmxClient.fromEnv()` reads the daemon state and token files during client construction. The SDK
uses an explicit `bearerToken` option for any target. It uses `OMX_API_LOCAL_BEARER` only for
state-file/default-port local discovery, not for arbitrary `baseUrl` / `OMX_API_BASE_URL` targets.
It reads a daemon token file only when the client target is resolved from a loopback daemon state
file, or when an explicit `baseUrl` / `OMX_API_BASE_URL` exactly matches that daemon state's
scheme, host, and port with no embedded credentials, path, query, or fragment. Token files must
stay beside the daemon state file; symlinked token files and token paths outside that directory are
ignored. On Unix, token files must be owned by the current user and not be group/world-readable. On
Windows, token confidentiality relies on the file's existing ACLs.

If you start `omx-api` outside `startOmxApiDaemon()` with a custom or legacy state-file path,
pass that path explicitly with `OmxClient.fromEnv({ stateFile })` or set `OMX_API_STATE_FILE`.

## Backends, models, and Codex profiles

The SDK daemon backend is the local `omx-api` engine, not the interactive Codex launcher:

- `backend: 'mock'` returns deterministic local fixture responses and is the default for tests,
  examples, and SDK integration smoke checks.
- `backend: 'real-private'` is experimental and requires private backend/OAuth environment
  variables such as `OMX_API_CODEX_OAUTH_TOKEN` and `OMX_API_PRIVATE_BACKEND_URL`.

Codex launch profiles are now an explicit SDK boundary. `profile: 'gpt55'` can be passed to
launcher builders/runners and to `startOmxApiDaemon()` with deliberately limited semantics:

- Runtime wrappers pass it through as `--profile gpt55` to Codex/OMX commands.
- Daemon startup reads `$CODEX_HOME/config.toml` plus `$CODEX_HOME/gpt55.config.toml`, then maps
  API-relevant values to API environment variables.
- Existing non-empty explicit API env vars still win over profile-derived values; empty or
  whitespace-only strings are treated as unset so they do not accidentally suppress profile defaults.
- Launcher-only settings such as sandboxing, approvals, tmux, HUD, and skills are not mapped into
  the API daemon. Use `madmax: true` on runtime wrappers when you need the launcher bypass flag.

```ts
import { startOmxApiDaemon, OmxRuntimeClient } from 'oh-my-codex';

const daemon = await startOmxApiDaemon({
  backend: 'real-private',
  profile: 'gpt55',
});

const runtime = new OmxRuntimeClient({ cwd: process.cwd() });
const child = runtime.runPrompt({
  prompt: 'Inspect this repo and summarize the release risks.',
  profile: 'gpt55',
  model: 'gpt-5.5',
  reasoningEffort: 'high',
  madmax: true,
});

const workflowChild = runtime.runSkill({
  skill: 'ralph',
  prompt: 'finish the SDK verification',
  profile: 'gpt55',
  model: 'gpt-5.5',
  reasoningEffort: 'high',
  madmax: true,
});
```

`madmax: true` maps to the launcher bypass flag for the command being spawned: `omx exec`
receives `--madmax`, while `omx resume` / `codex fork` receive
`--dangerously-bypass-approvals-and-sandbox`. Only use it for trusted automation running inside an
external sandbox. Prompts and session ids are passed as argv, not through a shell; skill and agent
names are validated to simple catalog-safe names, but caller-provided prompt text is still
untrusted model input.

For one-off API calls, request-level `model` remains the clearest override:

```ts
await daemon.client.responses.create({
  model: 'gpt-5.5',
  input: 'Draft a release checklist.',
});
```

## Current SDK coverage

This MVP exposes stable local building blocks, not the whole interactive OMX CLI surface.

| Area | SDK support | Notes |
| --- | --- | --- |
| Local generation API | **Yes** | `OmxClient` wraps local `omx-api` responses/chat/images endpoints. |
| Daemon lifecycle | **Yes** | `startOmxApiDaemon()` starts/stops the native sidecar and manages private temporary state by default. |
| Workspace state reads | **Yes** | `OmxWorkspace` reads session/HUD/mode state without mutating runtime state. |
| Team queue/mailbox | **Yes** | `OmxTeamClient` supports mailbox sends, broadcasts, delivery/notified marks, summaries, task lifecycle wrappers, event/state reads, worker heartbeat/inbox/identity wrappers, approvals, monitor snapshots, and cleanup operations. It still does not spawn tmux workers or own the full team pipeline. |
| Plain OMX prompts | **Yes, launcher wrapper** | `OmxRuntimeClient.runPrompt()` launches `omx exec` with the prompt as one argv element and optional `profile`, `model`, `reasoningEffort`, `madmax`, `direct`, `json`, and `outputLastMessage` settings. AGENTS.md routing, hooks, and OMX runtime setup still come from the CLI path. |
| Skills/workflows (`$ralph`, `$team`, `$ultrawork`, etc.) | **Yes, launcher wrapper** | `OmxCatalogClient` lists/reads bundled skill definitions and builds `$skill` prompts. `OmxRuntimeClient.runSkill()` launches `omx exec` with that prompt. Skill protocol/state remains CLI/AGENTS/SKILL.md-owned. |
| `fork` / session branching | **Yes, launcher wrapper** | `OmxRuntimeClient.fork()` spawns `codex fork` because there is no separate `omx fork` command. `buildCodexForkArgs()` is exposed for dry-run/testing. |
| `omx resume` / session picker | **Yes, launcher wrapper** | `OmxRuntimeClient.resume()` spawns `omx resume`; `buildOmxResumeArgs()` supports `--last`, `--all`, session id, prompt, profile, model, reasoning effort, and madmax/bypass. |
| Codex profile resolution (`--profile gpt55`) | **Yes, bounded** | Runtime wrappers pass `--profile`; daemon startup can map model/provider/reasoning from `$CODEX_HOME/<profile>.config.toml` into API env. Launcher-only settings are intentionally ignored. |
| Setup/doctor/update | **Not yet** | These remain CLI commands because they mutate user/project install state. |

## Known follow-ups

Track these items for future SDK iterations:

- Consider parent-crash daemon cleanup for SDK-managed daemons. Today normal `daemon.stop()` cleanup is covered; abrupt process death can still orphan a sidecar.
- Decide whether strict host matching (`localhost` vs `127.0.0.1`) should remain security-first behavior or get normalized for convenience.
- Consider changing SDK-managed daemon default port from `14510` to `0` in a future compatibility-safe pass. When callers pass `port: 0`, the daemon state must report the OS-assigned port before the SDK accepts it.

## Team queue and mailbox messages

`OmxTeamClient` wraps the existing team API for mailbox messaging. When a live pane is not available, `sendMessage()` persists the mailbox entry and returns the queued dispatch outcome so callers can inspect `dispatch.reason`, `request_id`, and `message_id`.

```ts
import { OmxTeamClient } from 'oh-my-codex';

const team = new OmxTeamClient({ cwd: process.cwd() });
const sent = await team.sendMessage({
  teamName: 'my-team',
  fromWorker: 'worker-1',
  toWorker: 'worker-2',
  body: 'Please check your mailbox.',
});

if (sent.dispatch.reason === 'queued_for_hook_dispatch') {
  console.log('Queued for hook delivery:', sent.dispatch.request_id);
}

const mailbox = await team.mailboxList({
  teamName: 'my-team',
  worker: 'worker-2',
  includeDelivered: false,
});
```

The same client also wraps team task/event operations:

```ts
const task = await team.createTask({
  teamName: 'my-team',
  subject: 'Review SDK docs',
  description: 'Check profile and runtime wrapper boundaries.',
});
const claim = await team.claimTask({
  teamName: 'my-team',
  taskId: task.id,
  worker: 'worker-1',
  expectedVersion: task.version ?? 1,
});
await team.transitionTaskStatus({
  teamName: 'my-team',
  taskId: task.id,
  from: 'in_progress',
  to: 'completed',
  claimToken: String(claim.claimToken),
  result: 'Docs reviewed.',
});
```

## Prompts, skills, agents, resume, and fork

The SDK exposes two intentionally separate surfaces:

- `OmxCatalogClient` is read/build only. It reads bundled skill/agent metadata and local
  `SKILL.md` / prompt files from the installed package.
- `OmxRuntimeClient` launches the existing CLI runtime. It does not reimplement workflow
  state machines in process.

```ts
import { OmxCatalogClient, OmxRuntimeClient } from 'oh-my-codex';

const catalog = new OmxCatalogClient();
console.log(catalog.listSkills().map((skill) => skill.name));
console.log(await catalog.readSkill('ralph'));

const runtime = new OmxRuntimeClient({ cwd: process.cwd() });
console.log(runtime.buildPromptArgs({
  prompt: 'Inspect this repo and summarize release risks.',
  profile: 'gpt55',
  model: 'gpt-5.5',
  reasoningEffort: 'high',
  madmax: true,
  json: true,
  outputLastMessage: 'last-message.txt',
}));
console.log(runtime.buildSkillArgs({
  skill: 'ralph',
  prompt: 'verify the SDK',
  profile: 'gpt55',
  model: 'gpt-5.5',
  reasoningEffort: 'high',
  madmax: true,
}));

// Real launcher calls:
// runtime.runPrompt({ prompt: 'Inspect this repo.', profile: 'gpt55', madmax: true });
// runtime.runSkill({ skill: 'ralph', prompt: 'verify the SDK', profile: 'gpt55' });
// runtime.resume({ last: true, profile: 'gpt55' });
// runtime.fork({ last: true, profile: 'gpt55', prompt: 'try an alternate approach' });
```

`fork()` uses `codex fork` directly because OMX currently exposes `omx resume` but not an
`omx fork` subcommand. `runPrompt()` uses `omx exec` with the prompt as one argv element.
`runSkill()` uses `omx exec` with the `$skill prompt` string as one argv element. AGENTS.md routing,
hooks, installed skills, and OMX runtime state still behave like normal CLI invocations.
`resume()` and `fork()` reject conflicting session selectors, and reject session ids, prompt strings,
and model values that start with `-` so caller-provided values cannot be parsed as launcher flags.
Runtime launcher methods inherit terminal stdio by default. Pass `spawnOptions`, `omxSpawnOptions`,
or `codexSpawnOptions` when a consumer needs to capture stdout/stderr or run detached. These
objects accept only `stdio`, `detached`, `windowsHide`, and `signal`; unsupported child-process
options such as `shell` are rejected before spawn:

```ts
const capturedRuntime = new OmxRuntimeClient({
  cwd: process.cwd(),
  spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] },
});
```

## Workspace state

`OmxWorkspace` exposes safe read helpers for SDK consumers that need status without owning
OMX runtime state transitions:

```ts
import { OmxWorkspace } from 'oh-my-codex';

const workspace = new OmxWorkspace({ cwd: process.cwd() });
const session = await workspace.readSession();
const hud = await workspace.readHud();
const activeModes = await workspace.listModeStates();
```

Write-side state mutation remains owned by existing runtime/CLI flows. Add write methods only
when they preserve session-scoped state invariants and have dedicated regression tests.
