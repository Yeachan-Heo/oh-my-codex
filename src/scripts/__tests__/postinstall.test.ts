import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeUserInstallStamp } from "../../cli/update.js";
import {
  hydrateOmxRuntimeNonFatal,
  isGlobalInstallLifecycle,
  runPostinstall,
} from "../postinstall.js";

describe("isGlobalInstallLifecycle", () => {
  it("accepts npm_config_global=true", () => {
    assert.equal(isGlobalInstallLifecycle({ npm_config_global: "true" }), true);
  });

  it("accepts npm_config_location=global", () => {
    assert.equal(isGlobalInstallLifecycle({ npm_config_location: "global" }), true);
  });

  it("rejects local installs", () => {
    assert.equal(isGlobalInstallLifecycle({ npm_config_global: "false" }), false);
  });
});

describe("runPostinstall", () => {
  it("reports the macOS ARM runtime asset and cause when hydration times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-postinstall-timeout-"));
    const logs: string[] = [];
    const version = "0.21.43";
    const target = "aarch64-apple-darwin";
    const manifestUrl = "https://example.test/native-release-manifest.json";
    const archive = `omx-runtime-${target}.tar.xz`;
    const assetUrl = `https://example.test/releases/${archive}?token=must-not-be-logged`;
    const manifest = {
      manifest_version: 1,
      version,
      tag: `v${version}`,
      assets: [{
        product: "omx-runtime",
        version,
        platform: "darwin",
        arch: "arm64",
        target,
        archive,
        binary: "omx-runtime",
        binary_path: "omx-runtime",
        sha256: "0".repeat(64),
        size: 1,
        download_url: assetUrl,
      }],
    };
    const originalFetch = globalThis.fetch;
    let assetFetchStarted = false;
    const keepAlive = setInterval(() => {}, 1_000);

    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version }));
      globalThis.fetch = (async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === manifestUrl) return new Response(JSON.stringify(manifest));
        assetFetchStarted = true;
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("expected hydration abort signal"));
            return;
          }
          const rejectAborted = () => {
            const error = new Error("This operation was aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal.aborted) rejectAborted();
          else signal.addEventListener("abort", rejectAborted, { once: true });
        });
      }) as typeof fetch;

      const result = await hydrateOmxRuntimeNonFatal({
        packageRoot: root,
        env: {
          OMX_NATIVE_MANIFEST_URL: manifestUrl,
          OMX_NATIVE_CACHE_DIR: join(root, "cache"),
        },
        platform: "darwin",
        arch: "arm64",
        timeoutMs: 250,
        log: (message) => logs.push(message),
      });

      assert.equal(result, undefined);
      assert.equal(assetFetchStarted, true, "the timeout must occur while downloading the asset");
      assert.match(logs.join("\n"), /timed out after 250 ms/);
      assert.match(logs.join("\n"), new RegExp(archive));
      assert.match(logs.join("\n"), /cause: This operation was aborted/);
      assert.doesNotMatch(logs.join("\n"), /must-not-be-logged/);
    } finally {
      clearInterval(keepAlive);
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears stale Bun provenance for a global replacement while printing an explicit opt-in setup hint", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-postinstall-"));
    const stampPath = join(root, ".codex", ".omx", "install-state.json");
    const logs: string[] = [];

    try {
      const result = await runPostinstall({
        env: { npm_config_global: "true" },
        getCurrentVersion: async () => "0.14.1",
        hydrateRuntime: async () => "/cache/omx-runtime",
        log: (message) => logs.push(message),
        readStamp: async () => ({
          installed_version: "0.14.0",
          setup_completed_version: "0.14.0",
          package_manager: "bun",
          updated_at: "2026-04-20T00:00:00.000Z",
        }),
        writeStamp: async (stamp) => writeUserInstallStamp(stamp, stampPath),
      });

      assert.equal(result.status, "hinted");
      assert.match(logs.join("\n"), /Hydrated omx-runtime/);
      assert.match(logs.join("\n"), /OMX setup is explicit opt-in; run `omx setup` or `omx update` when you're ready/);

      const stamp = JSON.parse(await readFile(stampPath, "utf-8")) as {
        installed_version: string;
        setup_completed_version: string;
        package_manager?: string;
      };
      assert.equal(stamp.installed_version, "0.14.1");
      assert.equal(stamp.setup_completed_version, "0.14.0");
      assert.equal(stamp.package_manager, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records the installed version and preserves prior setup state when printing the postinstall hint", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-postinstall-"));
    const stampPath = join(root, ".codex", ".omx", "install-state.json");
    const logs: string[] = [];

    try {
      const result = await runPostinstall({
        env: { npm_config_global: "true" },
        getCurrentVersion: async () => "0.14.1",
        hydrateRuntime: async () => "/cache/omx-runtime",
        log: (message) => logs.push(message),
        readStamp: async () => ({
          installed_version: "0.14.0",
          setup_completed_version: "0.14.0",
          updated_at: "2026-04-20T00:00:00.000Z",
        }),
        writeStamp: async (stamp) => writeUserInstallStamp(stamp, stampPath),
      });

      assert.equal(result.status, "hinted");
      assert.match(logs.join("\n"), /run `omx setup` or `omx update` when you're ready/i);

      const stamp = JSON.parse(await readFile(stampPath, "utf-8")) as {
        installed_version: string;
        setup_completed_version: string;
      };
      assert.equal(stamp.installed_version, "0.14.1");
      assert.equal(stamp.setup_completed_version, "0.14.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not infer Bun provenance from a Bun user agent", async () => {
    let writtenStamp: { package_manager?: "npm" | "bun" } | undefined;

    const result = await runPostinstall({
      env: {
        npm_config_global: "true",
        npm_config_user_agent: "bun/1.2.0 npm/? node/v22.0.0 linux x64",
      },
      getCurrentVersion: async () => "0.14.1",
      hydrateRuntime: async () => "/cache/omx-runtime",
      readStamp: async () => null,
      writeStamp: async (stamp) => {
        writtenStamp = stamp;
      },
    });

    assert.equal(result.status, "hinted");
    assert.equal(writtenStamp?.package_manager, undefined);
  });

  it("skips local installs", async () => {
    const result = await runPostinstall({
      env: { npm_config_global: "false" },
      getCurrentVersion: async () => "0.14.1",
      hydrateRuntime: async () => "/cache/omx-runtime",
    });

    assert.equal(result.status, "noop-local");
  });

  it("does not rerun setup when the installed version matches the saved stamp", async () => {
    let hydrated = false;
    const result = await runPostinstall({
      env: { npm_config_global: "true" },
      getCurrentVersion: async () => "0.14.1",
      hydrateRuntime: async () => {
        hydrated = true;
        return "/cache/omx-runtime";
      },
      readStamp: async () => ({
        installed_version: "0.14.1",
        setup_completed_version: "0.14.1",
        updated_at: "2026-04-20T00:00:00.000Z",
      }),
    });

    assert.equal(result.status, "noop-same-version");
    assert.equal(hydrated, true, "same-version reinstalls must repair a missing native runtime cache");
  });

  it("keeps global installation non-fatal when runtime hydration fails", async () => {
    const logs: string[] = [];
    const result = await runPostinstall({
      env: { npm_config_global: "true" },
      getCurrentVersion: async () => "0.14.1",
      hydrateRuntime: async () => {
        throw new Error("offline");
      },
      log: (message) => logs.push(message),
      readStamp: async () => null,
      writeStamp: async () => {},
    });

    assert.equal(result.status, "hinted");
    assert.match(logs.join("\n"), /hydration failed non-fatally: offline/);
  });
});
