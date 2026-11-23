import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nativeRuntimeCommand } from "../native-runtime.js";

describe("native runtime command", () => {
  it("hydrates in the foreground and reports the verified cache path", async () => {
    let hydrated = false;
    const logs: string[] = [];
    const errors: string[] = [];
    const exitCodes: number[] = [];

    await nativeRuntimeCommand(["hydrate"], {
      hydrateRuntime: async () => {
        hydrated = true;
        return "/cache/omx-runtime";
      },
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      setExitCode: (code) => exitCodes.push(code),
    });

    assert.equal(hydrated, true);
    assert.deepEqual(logs, ["[omx] Hydrated omx-runtime for this platform: /cache/omx-runtime"]);
    assert.deepEqual(errors, []);
    assert.deepEqual(exitCodes, []);
  });

  it("prints hydration causes and fails when foreground hydration throws", async () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];

    await nativeRuntimeCommand(["hydrate"], {
      hydrateRuntime: async () => {
        throw new Error("timed out after 120000 ms; cause: This operation was aborted");
      },
      error: (message) => errors.push(message),
      setExitCode: (code) => exitCodes.push(code),
    });

    assert.deepEqual(errors, [
      "[omx] Foreground omx-runtime hydration failed: timed out after 120000 ms; cause: This operation was aborted",
    ]);
    assert.deepEqual(exitCodes, [1]);
  });

  it("rejects an unavailable runtime instead of reporting a successful repair", async () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];

    await nativeRuntimeCommand(["hydrate"], {
      hydrateRuntime: async () => undefined,
      error: (message) => errors.push(message),
      setExitCode: (code) => exitCodes.push(code),
    });

    assert.match(errors[0] ?? "", /omx-runtime is unavailable for /);
    assert.deepEqual(exitCodes, [1]);
  });
});
