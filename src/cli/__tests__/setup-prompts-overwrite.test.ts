import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from '../setup.js';
import { checkNativeAgentConfigDrift } from '../doctor.js';
import { readCatalogManifest } from '../../catalog/reader.js';
import {
  NON_NATIVE_AGENT_PROMPT_ASSETS,
  getInstallableNativeAgentNames,
} from '../../agents/policy.js';

describe('omx setup prompt/native-agent overwrite behavior', () => {
  const obsoleteNativeAgentField = ['skill', 'ref'].join('_');

  it('installs setup-owned prompts separately from active/internal native agents', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const promptsDir = join(wd, '.codex', 'prompts');
      const nativeAgentsDir = join(wd, '.codex', 'agents');
      const installedPrompts = new Set(await readdir(promptsDir));
      const installedNativeAgents = new Set(await readdir(nativeAgentsDir));

      assert.equal(installedPrompts.has('executor.md'), true);
      assert.equal(installedPrompts.has('team-executor.md'), true);
      assert.equal(installedPrompts.has('code-reviewer.md'), true);
      assert.equal(installedPrompts.has('code-simplifier.md'), true);

      for (const promptOnlyAgent of [
        'style-reviewer',
        'quality-reviewer',
        'api-reviewer',
        'performance-reviewer',
        'product-manager',
        'ux-researcher',
        'information-architect',
        'product-analyst',
        'qa-tester',
        'quality-strategist',
      ]) {
        assert.equal(
          installedPrompts.has(`${promptOnlyAgent}.md`),
          true,
          `expected setup to preserve prompt-only role ${promptOnlyAgent}.md`,
        );
      }

      for (const promptAsset of NON_NATIVE_AGENT_PROMPT_ASSETS) {
        assert.equal(
          installedPrompts.has(`${promptAsset}.md`),
          true,
          `expected setup to preserve explicit prompt asset ${promptAsset}.md`,
        );
      }

      const installableNativeAgents = getInstallableNativeAgentNames(readCatalogManifest());
      for (const agentName of installableNativeAgents) {
        assert.equal(
          installedNativeAgents.has(`${agentName}.toml`),
          true,
          `expected setup to install native agent ${agentName}.toml`,
        );
      }
      assert.equal(installedNativeAgents.has('code-review.toml'), false);
      assert.equal(installedNativeAgents.has('plan.toml'), false);
      assert.equal(installedNativeAgents.has('style-reviewer.toml'), false);
      assert.equal(installedNativeAgents.has('quality-reviewer.toml'), false);
      assert.equal(installedNativeAgents.has('api-reviewer.toml'), false);
      assert.equal(installedNativeAgents.has('performance-reviewer.toml'), false);
      assert.equal(installedNativeAgents.has('product-manager.toml'), false);
      assert.equal(installedNativeAgents.has('ux-researcher.toml'), false);
      assert.equal(installedNativeAgents.has('information-architect.toml'), false);
      assert.equal(installedNativeAgents.has('product-analyst.toml'), false);

      const codeReviewerToml = await readFile(join(wd, '.codex', 'agents', 'code-reviewer.toml'), 'utf-8');
      assert.match(codeReviewerToml, /^name = "code-reviewer"$/m);
      assert.match(codeReviewerToml, /developer_instructions\s*=/);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves customized prompt instructions while refreshing model fields during normal setup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const executorPath = join(wd, '.codex', 'agents', 'executor.toml');
      const installed = await readFile(executorPath, 'utf-8');
      const manifestPath = join(wd, '.codex', '.omx', 'native-agents.json');
      const initialManifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        files: Record<string, { sha256: string; developerInstructionsSha256?: string }>;
      };
      const initialEntry = initialManifest.files['executor.toml'];
      assert.ok(initialEntry.developerInstructionsSha256);
      const generatedModel = installed.match(/^model = "([^"]+)"$/m)?.[1];
      const generatedReasoning = installed.match(/^model_reasoning_effort = "([^"]+)"$/m)?.[1];
      assert.ok(generatedModel);
      assert.ok(generatedReasoning);
      const customized = installed
        .replace(/^model = ".*"$/m, 'model = "user-model-override"')
        .replace(/^model_reasoning_effort = ".*"$/m, 'model_reasoning_effort = "user-effort-override"')
        .replace(/^developer_instructions =/m, '# user header note\n$&')
        .replace('<identity>', '<identity>\nManual user instruction\n- resolved_model: USER PROMPT LINE');
      const customizedCrlf = customized.replace(/\n/g, '\r\n');
      assert.notEqual(customizedCrlf, installed);
      await writeFile(executorPath, customizedCrlf);

      await setup({ scope: 'project' });

      const refreshed = await readFile(executorPath, 'utf-8');
      const withoutGeneratedModelFields = (content: string) => content.replace(
        /^(?:model|model_provider|model_reasoning_effort) = .*\r?\n?/gm,
        '',
      );
      assert.notEqual(refreshed, customizedCrlf);
      assert.equal(withoutGeneratedModelFields(refreshed), withoutGeneratedModelFields(customizedCrlf));
      assert.match(refreshed, new RegExp(`^model = "${generatedModel}"\\r?$`, 'm'));
      assert.match(refreshed, new RegExp(`^model_reasoning_effort = "${generatedReasoning}"\\r?$`, 'm'));
      assert.match(refreshed, /Manual user instruction/);
      assert.match(refreshed, /- resolved_model: USER PROMPT LINE/);
      assert.match(refreshed, /# user header note\r?\n/);
      const refreshedManifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        files: Record<string, { sha256: string; developerInstructionsSha256?: string }>;
      };
      assert.deepEqual(refreshedManifest.files['executor.toml'], initialEntry,
        'merged user content must not become the generated whole-file or body baseline');
      const doctor = await checkNativeAgentConfigDrift({
        codexHomeDir: join(wd, '.codex'),
        configPath: join(wd, '.codex', 'config.toml'),
        hooksPath: join(wd, '.codex', 'hooks.json'),
        promptsDir: join(wd, '.codex', 'prompts'),
        skillsDir: join(wd, '.codex', 'skills'),
        agentsDir: join(wd, '.codex', 'agents'),
        stateDir: join(wd, '.omx', 'state'),
      });
      assert.doesNotMatch(doctor.message, /executor\.toml has unsupported\/stale model/);
      assert.match(doctor.message, /executor\.toml contains a customized user developer_instructions version/);
      await setup({ scope: 'project' });
      assert.equal(await readFile(executorPath, 'utf-8'), refreshed,
        'repeated setup must be byte-identical for a preserved custom prompt');
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves a user-edited terminal resolved_model instruction line', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-user-resolved-model-line-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);
      await setup({ scope: 'project' });
      const codexHome = join(wd, '.codex');
      const executorPath = join(codexHome, 'agents', 'executor.toml');
      const original = await readFile(executorPath, 'utf-8');
      const customized = original.replace(/^- resolved_model: .*$/m, '- resolved_model: USER-MODIFIED-END');
      assert.notEqual(customized, original);
      await writeFile(executorPath, customized);
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({ agentModels: { executor: 'new-configured-model' } }));

      await setup({ scope: 'project' });

      const refreshed = await readFile(executorPath, 'utf-8');
      assert.match(refreshed, /^model = "new-configured-model"$/m);
      assert.match(refreshed, /^- resolved_model: USER-MODIFIED-END$/m);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves removal of the generated terminal model line in a valid continued TOML string', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-removed-resolved-model-line-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);
      await setup({ scope: 'project' });
      const codexHome = join(wd, '.codex');
      const executorPath = join(codexHome, 'agents', 'executor.toml');
      const original = await readFile(executorPath, 'utf-8');
      const customized = original.replace(/\n- resolved_model: [^\r\n]*\n"""$/m, '\\\n"""');
      assert.notEqual(customized, original);
      await writeFile(executorPath, customized);
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({ agentModels: { executor: 'line-removal-model' } }));

      await setup({ scope: 'project' });

      const refreshed = await readFile(executorPath, 'utf-8');
      assert.match(refreshed, /^model = "line-removal-model"$/m);
      assert.match(refreshed, /\\\r?\n"""$/m);
      const doctor = await checkNativeAgentConfigDrift({
        codexHomeDir: join(wd, '.codex'),
        configPath: join(wd, '.codex', 'config.toml'),
        hooksPath: join(wd, '.codex', 'hooks.json'),
        promptsDir: join(wd, '.codex', 'prompts'),
        skillsDir: join(wd, '.codex', 'skills'),
        agentsDir: join(wd, '.codex', 'agents'),
        stateDir: join(wd, '.omx', 'state'),
      });
      assert.match(doctor.message, /executor\.toml contains a customized user developer_instructions version/);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves a user-removed final decoded newline after resolved_model', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-removed-body-newline-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);
      await setup({ scope: 'project' });
      const codexHome = join(wd, '.codex');
      const executorPath = join(codexHome, 'agents', 'executor.toml');
      const original = await readFile(executorPath, 'utf-8');
      const customized = original.replace(/(\n- resolved_model: [^\r\n]*)\n"""$/m, '$1\\\n"""');
      assert.notEqual(customized, original);
      await writeFile(executorPath, customized);
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({ agentModels: { executor: 'newline-change-model' } }));

      await setup({ scope: 'project' });

      const refreshed = await readFile(executorPath, 'utf-8');
      assert.match(refreshed, /^model = "newline-change-model"$/m);
      assert.match(refreshed, /- resolved_model: [^\r\n]*\\\r?\n"""$/m);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('refreshes a native agent when only its generated model differs from the current config', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agent-model-refresh-'));
    const previousCwd = process.cwd();
    const previousFrontierModel = process.env.OMX_DEFAULT_FRONTIER_MODEL;
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);
      delete process.env.OMX_DEFAULT_FRONTIER_MODEL;

      await setup({ scope: 'project' });

      const codexHome = join(wd, '.codex');
      const plannerPath = join(codexHome, 'agents', 'planner.toml');
      const planner = await readFile(plannerPath, 'utf-8');
      const manifestPath = join(codexHome, '.omx', 'native-agents.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        files: Record<string, { sha256?: string; developerInstructionsSha256?: string; developerInstructionsPromptSha256?: string; generatedResolvedModel?: string }>;
      };
      delete manifest.files['planner.toml'].sha256;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const staleModel = 'legacy-frontier-model';
      const stalePlanner = planner
        .replace(/^model = ".*"$/m, `model = "${staleModel}"`)
        .replace(/^developer_instructions =/m, '# user formatting comment\n$&');
      await writeFile(plannerPath, stalePlanner);
      await writeFile(
        join(codexHome, '.omx-config.json'),
        JSON.stringify({ env: { OMX_DEFAULT_FRONTIER_MODEL: 'configured-frontier-model' } }),
      );

      await setup({ scope: 'project' });

      const refreshedPlanner = await readFile(plannerPath, 'utf-8');
      assert.match(refreshedPlanner, /^model = "configured-frontier-model"$/m);
      assert.match(refreshedPlanner, /^- resolved_model: configured-frontier-model$/m);
      assert.match(refreshedPlanner, /^# user formatting comment$/m);
      assert.doesNotMatch(refreshedPlanner, new RegExp(staleModel));

      const reloadedManifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        files: Record<string, { sha256?: string; developerInstructionsSha256?: string; developerInstructionsPromptSha256?: string; generatedResolvedModel?: string }>;
      };
      assert.equal(reloadedManifest.files['planner.toml'].sha256, undefined);
      assert.ok(reloadedManifest.files['planner.toml'].developerInstructionsSha256);
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({ env: { OMX_DEFAULT_FRONTIER_MODEL: 'second-configured-frontier-model' } }));
      await setup({ scope: 'project' });
      const refreshedAgain = await readFile(plannerPath, 'utf-8');
      assert.match(refreshedAgain, /^model = "second-configured-frontier-model"$/m);
      assert.match(refreshedAgain, /^- resolved_model: second-configured-frontier-model$/m);
      assert.match(refreshedAgain, /^# user formatting comment$/m);
    } finally {
      if (typeof previousFrontierModel === 'string') process.env.OMX_DEFAULT_FRONTIER_MODEL = previousFrontierModel;
      else delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed on valid but unsupported multiline header TOML', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agent-unsafe-toml-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);
      await setup({ scope: 'project' });
      const executorPath = join(wd, '.codex', 'agents', 'executor.toml');
      const generated = await readFile(executorPath, 'utf-8');
      const customized = generated
        .replace(/^description = .*$/m, 'description = """\nkeep this note:\nmodel = "not a top-level setting"\n"""')
        .replace(/^model = ".*"$/m, 'model = "manual-drift"');
      await writeFile(executorPath, customized);

      await setup({ scope: 'project' });

      assert.equal(await readFile(executorPath, 'utf-8'), customized,
        'unsupported but valid TOML must be preserved byte-for-byte rather than partially edited');
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not promote an untracked customized body into a generated baseline', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agent-legacy-baseline-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);
      await setup({ scope: 'project' });
      const executorPath = join(wd, '.codex', 'agents', 'executor.toml');
      const manifestPath = join(wd, '.codex', '.omx', 'native-agents.json');
      const generated = await readFile(executorPath, 'utf-8');
      await rm(manifestPath, { force: true });
      const customized = generated
        .replace(/^model = ".*"$/m, 'model = "manual-drift"')
        .replace('<identity>', '<identity>\nUntracked user prompt');
      await writeFile(executorPath, customized);

      await setup({ scope: 'project' });
      const once = await readFile(executorPath, 'utf-8');
      assert.match(once, /Untracked user prompt/);
      assert.doesNotMatch(once, /manual-drift/);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        files: Record<string, { sha256?: string; developerInstructionsSha256?: string }>;
      };
      assert.equal(manifest.files['executor.toml']?.sha256, undefined);
      assert.equal(manifest.files['executor.toml']?.developerInstructionsSha256, undefined);
      const doctor = await checkNativeAgentConfigDrift({
        codexHomeDir: join(wd, '.codex'),
        configPath: join(wd, '.codex', 'config.toml'),
        hooksPath: join(wd, '.codex', 'hooks.json'),
        promptsDir: join(wd, '.codex', 'prompts'),
        skillsDir: join(wd, '.codex', 'skills'),
        agentsDir: join(wd, '.codex', 'agents'),
        stateDir: join(wd, '.omx', 'state'),
      });
      assert.match(doctor.message, /executor\.toml developer_instructions provenance is ambiguous/);

      await setup({ scope: 'project' });
      assert.match(await readFile(executorPath, 'utf-8'), /Untracked user prompt/);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes stale model, provider, and reasoning pins for custom-provider agents', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-custom-provider-agent-refresh-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const codexHome = join(wd, '.codex');
      const configPath = join(codexHome, 'config.toml');
      const config = await readFile(configPath, 'utf-8');
      await writeFile(
        configPath,
        config.replace(
          /^model = ".*"$/m,
          'model = "custom-root-model"\nmodel_provider = "custom-provider"\n\n[model_providers.custom-provider]\nname = "Custom provider"\nbase_url = "https://example.invalid/v1"\nwire_api = "responses"',
        ),
      );

      const plannerPath = join(codexHome, 'agents', 'planner.toml');
      const planner = await readFile(plannerPath, 'utf-8');
      const legacyPlanner = planner
        .replace(/^model = ".*"$/m, 'model = "legacy-model"')
        .replace(/^model_reasoning_effort = ".*"$/m, 'model_reasoning_effort = "high"')
        .replace(
          /^(description = .*\n)/m,
          '$1model_provider = "legacy-provider"\n',
        );
      await writeFile(plannerPath, legacyPlanner);

      await setup({ scope: 'project' });

      const refreshedPlanner = await readFile(plannerPath, 'utf-8');
      assert.doesNotMatch(refreshedPlanner, /^model = /m);
      assert.doesNotMatch(refreshedPlanner, /^model_provider = /m);
      assert.match(refreshedPlanner, /^model_reasoning_effort = "medium"$/m);
      assert.match(refreshedPlanner, /^- resolved_model: custom-root-model$/m);
      assert.doesNotMatch(refreshedPlanner, /legacy-(?:model|provider)/);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('overwrites customized native agent TOMLs only when setup force is explicit', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const executorPath = join(wd, '.codex', 'agents', 'executor.toml');
      const installed = await readFile(executorPath, 'utf-8');
      const customized = installed
        .replace(/^model = ".*"$/m, 'model = "gpt-5.5"')
        .replace(/^model_reasoning_effort = ".*"$/m, 'model_reasoning_effort = "low"');
      await writeFile(executorPath, customized);

      await setup({ scope: 'project', force: true });

      const refreshed = await readFile(executorPath, 'utf-8');
      assert.notEqual(refreshed, customized);
      assert.match(refreshed, /^# oh-my-codex agent: executor$/m);
      assert.doesNotMatch(refreshed, /^model = "gpt-5\.4"$/m);
      assert.doesNotMatch(refreshed, /^model_reasoning_effort = "low"$/m);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('preserves setup-owned prompt assets and removes unknown prompts on --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const validPrompts = ['style-reviewer.md', 'quality-reviewer.md'];
      for (const validPrompt of validPrompts) {
        assert.equal(existsSync(join(wd, '.codex', 'prompts', validPrompt)), true);
      }

      const unknownPromptPath = join(wd, '.codex', 'prompts', 'unclassified-local.md');
      await writeFile(unknownPromptPath, '# unclassified local prompt\n');
      assert.equal(existsSync(unknownPromptPath), true);

      await setup({ scope: 'project', force: true });

      for (const validPrompt of validPrompts) {
        assert.equal(existsSync(join(wd, '.codex', 'prompts', validPrompt)), true);
      }
      assert.equal(existsSync(unknownPromptPath), false);
      assert.equal(existsSync(join(wd, '.codex', 'prompts', 'executor.md')), true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes stale merged native agents on --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const staleAgents = ['style-reviewer.toml', 'quality-reviewer.toml'];
      for (const staleAgent of staleAgents) {
        const stalePath = join(wd, '.codex', 'agents', staleAgent);
        await writeFile(stalePath, '# stale native agent\n');
        assert.equal(existsSync(stalePath), true);
      }

      await setup({ scope: 'project', force: true });

      for (const staleAgent of staleAgents) {
        assert.equal(existsSync(join(wd, '.codex', 'agents', staleAgent)), false);
      }
      assert.equal(existsSync(join(wd, '.codex', 'agents', 'executor.toml')), true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes generated non-installable native agents during normal setup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const stalePath = join(wd, '.codex', 'agents', 'style-reviewer.toml');
      await writeFile(
        stalePath,
        [
          '# oh-my-codex agent: style-reviewer',
          'name = "style-reviewer"',
          'description = "old generated merged role"',
          'developer_instructions = """old"""',
          '',
        ].join('\n'),
      );
      assert.equal(existsSync(stalePath), true);

      await setup({ scope: 'project' });

      assert.equal(existsSync(stalePath), false);
      assert.equal(existsSync(join(wd, '.codex', 'agents', 'executor.toml')), true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves user-authored non-installable native agents during normal setup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const userAuthoredPath = join(wd, '.codex', 'agents', 'style-reviewer.toml');
      await writeFile(
        userAuthoredPath,
        [
          '# user-authored local agent',
          'name = "style-reviewer"',
          'description = "custom local role"',
          '',
        ].join('\n'),
      );
      assert.equal(existsSync(userAuthoredPath), true);

      await setup({ scope: 'project' });

      assert.equal(existsSync(userAuthoredPath), true);
      assert.equal(existsSync(join(wd, '.codex', 'agents', 'executor.toml')), true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes stale native agents with the obsolete bridge field during normal setup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const stalePath = join(wd, '.codex', 'agents', 'legacy-skill-agent.toml');
      await writeFile(
        stalePath,
        [
          'name = "legacy-skill-agent"',
          'description = "obsolete generated bridge agent"',
          `${obsoleteNativeAgentField} = "skills/legacy"`,
          '',
        ].join('\n'),
      );
      assert.equal(existsSync(stalePath), true);

      await setup({ scope: 'project' });

      assert.equal(existsSync(stalePath), false);
      assert.equal(existsSync(join(wd, '.codex', 'agents', 'executor.toml')), true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });
});
