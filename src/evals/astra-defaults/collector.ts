import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalConfig, EvalFixture, RunRecord } from './types.js';
import { scoreResponse } from './suite.js';

export interface CollectorOptions {
  timeoutMs?: number;
  /** Called to invoke Codex CLI. Default: npx -y @openai/codex */
  invokeCodex?: (args: string[], cwd: string) => Promise<CodexOutput>;
  /** Custom provider name to route through (e.g., 'layofflabs') */
  provider?: string;
  /** API key environment variable name when using custom provider */
  apiKeyEnv?: string;
  /** Skip git clone (for testing). Default: false */
  skipGitClone?: boolean;
}

export interface CodexOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CollectionResult {
  record: RunRecord;
  error?: string;
}

/**
 * Collects a single RunRecord by executing Codex CLI against a fixture/config pair.
 * Clones the pinned OMX revision, seeds it with fixture inputs, runs Codex,
 * captures output/token usage/latency, and grades against fixture checks.
 */
export async function collectRecord(
  fixture: EvalFixture,
  config: EvalConfig,
  options: CollectorOptions = {},
): Promise<CollectionResult> {
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000; // 15 minutes default
  const invokeCodex = options.invokeCodex ?? defaultCodexInvoker;
  
  // Auto-detect if we need layofflabs provider for OMX-internal model names
  const roleConfig = config.roles[fixture.surface];
  const modelName = roleConfig?.model ?? '';
  const isOmxInternalModel = !modelName.includes('/') && /^(gpt-[0-9]|gpt-[0-9]\.[0-9]|o[0-9]\d?-[a-z])/.test(modelName);
  
  const provider = options.provider ?? (isOmxInternalModel ? 'layofflabs' : undefined);
  const apiKeyEnv = options.apiKeyEnv ?? 'OPENAI_API_KEY';

  const startTime = Date.now();
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-eval-'));
  let output: CodexOutput | null = null;
  const skipGitClone = options.skipGitClone ?? false;

  try {
    // Clone the pinned OMX revision into the temp workspace (unless testing)
    if (!skipGitClone) {
      const gitUrl = 'origin' in process.env ? process.env.origin : 'https://github.com/Yeachan-Heo/oh-my-codex';
      const gitRef = config.omxRevision;
      try {
        execSync(`git clone --depth 1 --branch-point ${gitRef} ${gitUrl} .`, {
          cwd: tempDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        // Branch-point not supported, try direct clone with shallow history
        try {
          execSync(`git clone ${gitUrl} .`, {
            cwd: tempDir,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          execSync(`git checkout ${gitRef}`, {
            cwd: tempDir,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (e) {
          throw new Error(`Failed to clone OMX at revision ${gitRef}: ${(e as Error).message}`);
        }
      }
    }

    // Seed temp workspace with fixture inputs (overlay on repo)
    for (const [name, content] of Object.entries(fixture.inputs)) {
      writeFileSync(join(tempDir, name), content, 'utf-8');
    }

    // Build Codex args with config model/reasoning overrides
    // Use the surface from the fixture to select the right role config
    if (!roleConfig) {
      throw new Error(`No role config for surface "${fixture.surface}" in config "${config.id}"`);
    }

    // Build args for: codex exec --json -m <model> -c reasoning_effort=<effort> <prompt>
    // Use the cloned repo context (do NOT use --skip-git-repo-check or --ephemeral)
    const args = [
      'exec',
      '--json',
      '-m',
      roleConfig.model,
      '-c',
      `reasoning_effort='${roleConfig.reasoningEffort}'`,
    ];

    // Add custom provider config if specified
    if (provider) {
      // Resolve API key from environment
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        throw new Error(`${apiKeyEnv} environment variable not set for provider "${provider}"`);
      }

      // Add provider configuration via -c flags
      // These override codex's default model_providers configuration
      args.push(
        '-c', `model_providers.${provider}.name=${provider}`,
        '-c', `model_providers.${provider}.base_url=https://api.layofflabs.com/v1`,
        '-c', `model_providers.${provider}.env_key=${apiKeyEnv}`,
        '-c', `model_providers.${provider}.wire_api=responses`,
        '-c', `model_provider=${provider}`,
      );
    }

    // Construct the full prompt with fixture inputs embedded
    let fullPrompt = fixture.prompt;
    const inputKeys = Object.keys(fixture.inputs);
    if (inputKeys.length > 0) {
      // Append fixture inputs to the prompt for context
      const inputContext = inputKeys
        .map((key) => `${key}:\n${fixture.inputs[key]}`)
        .join('\n\n');
      fullPrompt = `${fullPrompt}\n\n${inputContext}`;
    }
    args.push(fullPrompt);

    // Run Codex CLI with timeout
    output = await Promise.race([
      invokeCodex(args, tempDir),
      new Promise<CodexOutput>((_, reject) =>
        setTimeout(() => reject(new Error(`Codex execution timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    // Parse output and grade response
    const latencyMs = Date.now() - startTime;

    if (output.exitCode !== 0) {
      // Codex failed; record error outcome
      return {
        record: {
          fixtureId: fixture.id,
          configId: config.id,
          outcome: 'error',
          checks: [],
          requiredChecksPassed: null,
          retries: 0,
          latencyMs,
          usage: null, // No usage data on error
          operatorMinutes: null,
          difficult: false,
          notes: `Codex exit code ${output.exitCode}; stderr: ${output.stderr.slice(0, 200)}`,
        },
      };
    }

    // Parse JSONL output (--json outputs one JSON object per line)
    // The final event should contain the agent's final response
    let finalEvent: Record<string, unknown> | null = null;
    try {
      const lines = output.stdout.trim().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          finalEvent = JSON.parse(line);
        }
      }
    } catch (e) {
      return {
        record: {
          fixtureId: fixture.id,
          configId: config.id,
          outcome: 'error',
          checks: [],
          requiredChecksPassed: null,
          retries: 0,
          latencyMs,
          usage: null,
          operatorMinutes: null,
          difficult: false,
          notes: `Failed to parse Codex JSONL output: ${(e as Error).message}`,
        },
      };
    }

    if (!finalEvent) {
      return {
        record: {
          fixtureId: fixture.id,
          configId: config.id,
          outcome: 'error',
          checks: [],
          requiredChecksPassed: null,
          retries: 0,
          latencyMs,
          usage: null,
          operatorMinutes: null,
          difficult: false,
          notes: 'No output from Codex exec',
        },
      };
    }

    // Extract response text and usage from final event
    // The structure depends on what Codex outputs
    const responseText = String(finalEvent.response ?? finalEvent.message ?? '');
    const usageData = finalEvent.usage as Record<string, number> | undefined;

    // Grade response
    const checks = scoreResponse(fixture, responseText);
    const passed = checks.every((check) => check.passed);

    // Build usage record from Codex output
    const usage = usageData
      ? {
          inputTokens: usageData.input_tokens ?? null,
          outputTokens: usageData.output_tokens ?? null,
          uncachedInputTokens: usageData.uncached_input_tokens ?? null,
          cacheReadTokens: usageData.cache_read_tokens ?? null,
          cacheWriteTokens: usageData.cache_write_tokens ?? null,
          source: 'codex exec --json',
        }
      : null;

    return {
      record: {
        fixtureId: fixture.id,
        configId: config.id,
        outcome: passed ? 'pass' : 'fail',
        checks,
        requiredChecksPassed: null, // Fixture repos not evaluated in this pass
        retries: 0,
        latencyMs,
        usage,
        operatorMinutes: null,
        difficult: false,
      },
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    return {
      record: {
        fixtureId: fixture.id,
        configId: config.id,
        outcome: 'error',
        checks: [],
        requiredChecksPassed: null,
        retries: 0,
        latencyMs,
        usage: null,
        operatorMinutes: null,
        difficult: false,
        notes: `Collection failed: ${(error as Error).message}`,
      },
      error: (error as Error).message,
    };
  } finally {
    // Clean up temp workspace
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Best effort cleanup
    }
  }
}

/**
 * Default Codex invoker using npx -y @openai/codex
 */
async function defaultCodexInvoker(args: string[], cwd: string): Promise<CodexOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['-y', '@openai/codex', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 16 * 60 * 1000, // 16 min hard timeout in spawn
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += String(data);
    });

    child.stderr?.on('data', (data) => {
      stderr += String(data);
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('exit', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Collects RunRecords for a matrix of fixtures x configs.
 * Yields results as they complete, allowing progress reporting and early abort.
 */
export async function* collectMatrix(
  fixtures: EvalFixture[],
  configs: EvalConfig[],
  options: CollectorOptions = {},
): AsyncGenerator<{ fixture: EvalFixture; config: EvalConfig; result: CollectionResult }> {
  for (const config of configs) {
    for (const fixture of fixtures) {
      const result = await collectRecord(fixture, config, options);
      yield { fixture, config, result };
    }
  }
}
