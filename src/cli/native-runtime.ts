import { hydrateOmxRuntime } from "../scripts/postinstall.js";

const USAGE = "Usage: omx native-runtime hydrate";

export interface NativeRuntimeCommandDependencies {
  hydrateRuntime: () => Promise<string | undefined>;
  log: (message: string) => void;
  error: (message: string) => void;
  setExitCode: (code: number) => void;
}

const defaultDependencies: NativeRuntimeCommandDependencies = {
  hydrateRuntime: () => hydrateOmxRuntime(),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export async function nativeRuntimeCommand(
  args: string[],
  dependencies: Partial<NativeRuntimeCommandDependencies> = {},
): Promise<void> {
  const resolved = { ...defaultDependencies, ...dependencies };
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    resolved.log(`${USAGE}\nRetry hydration of the cached native runtime in the foreground.`);
    return;
  }
  if (args.length !== 1 || args[0] !== "hydrate") {
    resolved.error(USAGE);
    resolved.setExitCode(1);
    return;
  }

  try {
    const runtimePath = await resolved.hydrateRuntime();
    if (!runtimePath) {
      throw new Error(
        `omx-runtime is unavailable for ${process.platform}-${process.arch}; check that native auto-fetch is enabled and a release asset exists for this platform.`,
      );
    }
    resolved.log(`[omx] Hydrated omx-runtime for this platform: ${runtimePath}`);
  } catch (error) {
    resolved.error(
      `[omx] Foreground omx-runtime hydration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    resolved.setExitCode(1);
  }
}
