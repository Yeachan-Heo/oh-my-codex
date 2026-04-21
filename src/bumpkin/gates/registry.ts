import type { Gate, GateContext, GateVerdict, CommandRunner } from './types.js';

function commandGate(
  name: string,
  cmd: string,
  args: readonly string[],
  failureMessage: string,
): Gate {
  return {
    name,
    async run(ctx: GateContext): Promise<GateVerdict> {
      const result = await ctx.run(cmd, args, { cwd: ctx.workspacePath });
      if (result.code === 0) {
        return { pass: true, reason: `${name} passed`, artifacts: { stdout: result.stdout } };
      }
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      return {
        pass: false,
        reason: `${failureMessage}: ${detail}`,
        artifacts: { stdout: result.stdout, stderr: result.stderr, exitCode: result.code },
      };
    },
  };
}

export function testsPassGate(
  opts: { command?: readonly [string, ...string[]] } = {},
): Gate {
  const [cmd, ...args] = opts.command ?? ['npm', 'test'];
  return commandGate('verify-tests', cmd, args, 'test suite failed');
}

export function typeCheckGate(
  opts: { command?: readonly [string, ...string[]] } = {},
): Gate {
  const [cmd, ...args] = opts.command ?? ['npx', 'tsc', '--noEmit'];
  return commandGate('verify-types', cmd, args, 'type check failed');
}

export function buildGate(
  opts: { command?: readonly [string, ...string[]] } = {},
): Gate {
  const [cmd, ...args] = opts.command ?? ['npm', 'run', 'build'];
  return commandGate('verify-build', cmd, args, 'build failed');
}

export function lintGate(
  opts: {
    command?: readonly [string, ...string[]];
    baselineWarningsKey?: string;
    parseWarnings?: (stdout: string, stderr: string) => number;
  } = {},
): Gate {
  const [cmd, ...args] = opts.command ?? ['npm', 'run', 'lint'];
  const key = opts.baselineWarningsKey ?? 'lintWarnings';
  const parse =
    opts.parseWarnings ??
    ((stdout: string, stderr: string) => {
      const match = `${stdout}\n${stderr}`.match(/(\d+)\s+warnings?/i);
      return match && match[1] ? Number.parseInt(match[1], 10) : 0;
    });
  return {
    name: 'verify-lint',
    async run(ctx: GateContext): Promise<GateVerdict> {
      const result = await ctx.run(cmd, args, { cwd: ctx.workspacePath });
      if (result.code !== 0) {
        return {
          pass: false,
          reason: `lint failed: exit ${result.code}`,
          artifacts: { stdout: result.stdout, stderr: result.stderr },
        };
      }
      const warnings = parse(result.stdout, result.stderr);
      const baseline = (ctx.baseline?.[key] as number | undefined) ?? 0;
      if (warnings > baseline) {
        return {
          pass: false,
          reason: `lint warnings regressed: ${warnings} > baseline ${baseline}`,
          artifacts: { warnings, baseline },
        };
      }
      return {
        pass: true,
        reason: `lint clean (warnings=${warnings} ≤ baseline ${baseline})`,
        artifacts: { warnings, baseline },
      };
    },
  };
}

export interface BundleSizeOpts {
  measure: (workspacePath: string, run: CommandRunner) => Promise<number>;
  baselineKey?: string;
  maxIncreaseRatio?: number;
}

export function bundleSizeGate(opts: BundleSizeOpts): Gate {
  const key = opts.baselineKey ?? 'bundleBytes';
  const ratio = opts.maxIncreaseRatio ?? 1.1;
  return {
    name: 'verify-bundle-size',
    async run(ctx: GateContext): Promise<GateVerdict> {
      const bytes = await opts.measure(ctx.workspacePath, ctx.run);
      const baseline = ctx.baseline?.[key] as number | undefined;
      if (baseline == null) {
        return {
          pass: true,
          reason: `no baseline recorded; bundle=${bytes} bytes`,
          artifacts: { bundleBytes: bytes, baseline: null },
        };
      }
      const limit = baseline * ratio;
      if (bytes > limit) {
        return {
          pass: false,
          reason: `bundle grew from ${baseline} to ${bytes} bytes (>${ratio.toFixed(2)}x)`,
          artifacts: { bundleBytes: bytes, baseline, ratio },
        };
      }
      return {
        pass: true,
        reason: `bundle=${bytes} bytes within ${ratio.toFixed(2)}x of baseline ${baseline}`,
        artifacts: { bundleBytes: bytes, baseline, ratio },
      };
    },
  };
}

export interface PreviewDeployOpts {
  checkPreview: (workspacePath: string) => Promise<{ ok: boolean; url?: string; message?: string }>;
}

export function previewDeployGate(opts: PreviewDeployOpts): Gate {
  return {
    name: 'verify-preview',
    async run(ctx: GateContext): Promise<GateVerdict> {
      const result = await opts.checkPreview(ctx.workspacePath);
      if (result.ok) {
        return {
          pass: true,
          reason: `preview deploy ok${result.url ? ` (${result.url})` : ''}`,
          artifacts: { url: result.url },
        };
      }
      return {
        pass: false,
        reason: `preview deploy failed: ${result.message ?? 'unknown'}`,
        artifacts: { url: result.url, message: result.message },
      };
    },
  };
}
