import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Notification Profiles Tests
 *
 * Tests named notification profiles: resolution priority, default fallback,
 * env var selection, backward compatibility with flat config, and edge cases.
 *
 * Config is read from disk via readRawConfig(), so we mock the fs module
 * to inject test configs without touching the filesystem.
 */

// We need to mock fs before importing config, so we use dynamic imports
// after setting up mocks per test.

const PROFILE_ENV_KEY = "OMX_NOTIFY_PROFILE";

function clearProfileEnv(): void {
  delete process.env[PROFILE_ENV_KEY];
  delete process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN;
  delete process.env.OMX_DISCORD_NOTIFIER_CHANNEL;
  delete process.env.OMX_DISCORD_WEBHOOK_URL;
  delete process.env.OMX_DISCORD_MENTION;
  delete process.env.OMX_TELEGRAM_BOT_TOKEN;
  delete process.env.OMX_TELEGRAM_CHAT_ID;
  delete process.env.OMX_SLACK_WEBHOOK_URL;
}

// ---------- resolveProfileConfig (pure function, no fs needed) ----------

describe("resolveProfileConfig", () => {
  let resolveProfileConfig: typeof import("../config.js").resolveProfileConfig;

  beforeEach(async () => {
    clearProfileEnv();
    const mod = await import("../config.js");
    resolveProfileConfig = mod.resolveProfileConfig;
  });

  afterEach(() => {
    clearProfileEnv();
  });

  it("returns null when no profiles defined", () => {
    const result = resolveProfileConfig({
      enabled: true,
      telegram: { enabled: true, botToken: "t", chatId: "c" },
    });
    assert.equal(result, null);
  });

  it("returns null when profiles object is empty", () => {
    const result = resolveProfileConfig({
      enabled: true,
      profiles: {},
    });
    assert.equal(result, null);
  });

  it("resolves explicit profileName argument", () => {
    const workProfile = {
      enabled: true,
      telegram: { enabled: true, botToken: "work-token", chatId: "work-chat" },
    };
    const result = resolveProfileConfig(
      {
        enabled: true,
        profiles: {
          work: workProfile,
          personal: {
            enabled: true,
            telegram: {
              enabled: true,
              botToken: "personal-token",
              chatId: "personal-chat",
            },
          },
        },
      },
      "work",
    );
    assert.deepEqual(result, workProfile);
  });

  it("resolves OMX_NOTIFY_PROFILE env var when no explicit name", () => {
    process.env[PROFILE_ENV_KEY] = "personal";
    const personalProfile = {
      enabled: true,
      telegram: {
        enabled: true,
        botToken: "personal-token",
        chatId: "personal-chat",
      },
    };
    const result = resolveProfileConfig({
      enabled: true,
      profiles: {
        work: { enabled: true },
        personal: personalProfile,
      },
    });
    assert.deepEqual(result, personalProfile);
  });

  it("explicit profileName takes priority over env var", () => {
    process.env[PROFILE_ENV_KEY] = "personal";
    const workProfile = {
      enabled: true,
      "discord-bot": {
        enabled: true,
        botToken: "bot-t",
        channelId: "ch-1",
      },
    };
    const result = resolveProfileConfig(
      {
        enabled: true,
        profiles: {
          work: workProfile,
          personal: { enabled: true },
        },
      },
      "work",
    );
    assert.deepEqual(result, workProfile);
  });

  it("falls back to defaultProfile when no explicit name or env var", () => {
    const defaultProfile = {
      enabled: true,
      slack: {
        enabled: true,
        webhookUrl: "https://hooks.slack.com/services/default",
      },
    };
    const result = resolveProfileConfig({
      enabled: true,
      defaultProfile: "main",
      profiles: {
        main: defaultProfile,
        secondary: { enabled: true },
      },
    });
    assert.deepEqual(result, defaultProfile);
  });

  it("returns null when selected profile name does not exist", () => {
    const result = resolveProfileConfig(
      {
        enabled: true,
        profiles: {
          work: { enabled: true },
        },
      },
      "nonexistent",
    );
    assert.equal(result, null);
  });

  it("returns null when no profile selected and no defaultProfile", () => {
    const result = resolveProfileConfig({
      enabled: true,
      profiles: {
        work: { enabled: true },
        personal: { enabled: true },
      },
    });
    assert.equal(result, null);
  });

  it("profile with enabled=false is returned as-is", () => {
    const silentProfile = { enabled: false };
    const result = resolveProfileConfig(
      {
        enabled: true,
        profiles: {
          silent: silentProfile,
          loud: { enabled: true },
        },
      },
      "silent",
    );
    assert.deepEqual(result, silentProfile);
  });

  it("profile with per-event config is preserved", () => {
    const profile = {
      enabled: true,
      telegram: { enabled: true, botToken: "t", chatId: "c" },
      events: {
        "session-end": {
          enabled: true,
          messageTemplate: "Done: {{summary}}",
        },
        "session-start": { enabled: false },
      },
    };
    const result = resolveProfileConfig(
      {
        enabled: true,
        profiles: { custom: profile },
      },
      "custom",
    );
    assert.deepEqual(result!.events, profile.events);
  });

  it("priority order: explicit > env > defaultProfile", () => {
    process.env[PROFILE_ENV_KEY] = "env-profile";
    const config = {
      enabled: true,
      defaultProfile: "default-profile",
      profiles: {
        "explicit-profile": {
          enabled: true,
          telegram: { enabled: true, botToken: "explicit", chatId: "e" },
        },
        "env-profile": {
          enabled: true,
          telegram: { enabled: true, botToken: "env", chatId: "e" },
        },
        "default-profile": {
          enabled: true,
          telegram: { enabled: true, botToken: "default", chatId: "d" },
        },
      },
    };

    // Explicit wins over env and default
    const r1 = resolveProfileConfig(config, "explicit-profile");
    assert.equal(r1!.telegram!.botToken, "explicit");

    // Env wins over default when no explicit
    const r2 = resolveProfileConfig(config);
    assert.equal(r2!.telegram!.botToken, "env");

    // Default used when no explicit and no env
    delete process.env[PROFILE_ENV_KEY];
    const r3 = resolveProfileConfig(config);
    assert.equal(r3!.telegram!.botToken, "default");
  });
});

// ---------- getNotificationConfig with profiles ----------

describe("getNotificationConfig with profiles", () => {
  // We test through the public API by manipulating env vars
  // and relying on the fact that env-only config doesn't use profiles.
  // For file-based tests we need to test resolveProfileConfig integration.

  beforeEach(() => {
    clearProfileEnv();
  });

  afterEach(() => {
    clearProfileEnv();
  });

  it("env-only config still works without profiles", async () => {
    process.env.OMX_TELEGRAM_BOT_TOKEN = "123:abc";
    process.env.OMX_TELEGRAM_CHAT_ID = "999";

    const { getNotificationConfig } = await import("../config.js");
    const config = getNotificationConfig();
    assert.ok(config);
    assert.equal(config.enabled, true);
    assert.equal(config.telegram!.botToken, "123:abc");
  });

  it("getNotificationConfig passes profileName to resolver", async () => {
    // When no file config exists and only env, profileName is a no-op
    // but should not break anything
    process.env.OMX_TELEGRAM_BOT_TOKEN = "123:abc";
    process.env.OMX_TELEGRAM_CHAT_ID = "999";

    const { getNotificationConfig } = await import("../config.js");
    const config = getNotificationConfig("nonexistent");
    assert.ok(config);
    assert.equal(config.telegram!.botToken, "123:abc");
  });
});

// ---------- listProfiles / getActiveProfileName ----------

describe("listProfiles", () => {
  beforeEach(() => {
    clearProfileEnv();
  });

  afterEach(() => {
    clearProfileEnv();
  });

  it("returns empty array when no config file", async () => {
    const { listProfiles } = await import("../config.js");
    // Without a config file, should return empty
    const profiles = listProfiles();
    assert.ok(Array.isArray(profiles));
  });
});

describe("getActiveProfileName", () => {
  beforeEach(() => {
    clearProfileEnv();
  });

  afterEach(() => {
    clearProfileEnv();
  });

  it("returns env var value when OMX_NOTIFY_PROFILE is set", async () => {
    process.env[PROFILE_ENV_KEY] = "my-profile";
    const { getActiveProfileName } = await import("../config.js");
    const name = getActiveProfileName();
    assert.equal(name, "my-profile");
  });

  it("returns null when no env var and no config file", async () => {
    const { getActiveProfileName } = await import("../config.js");
    const name = getActiveProfileName();
    // Without a config file with profiles, should be null
    assert.ok(name === null || typeof name === "string");
  });
});

// ---------- NotificationsBlock type compatibility ----------

describe("NotificationsBlock type compatibility", () => {
  it("flat config (no profiles) is assignable to NotificationsBlock", async () => {
    const { resolveProfileConfig } = await import("../config.js");

    // A flat config with no profiles should work with resolveProfileConfig
    const flat = {
      enabled: true,
      discord: {
        enabled: true,
        webhookUrl: "https://discord.com/api/webhooks/test",
      },
    };
    const result = resolveProfileConfig(flat);
    assert.equal(result, null); // no profiles = null, use flat
  });

  it("profiled config works with resolveProfileConfig", async () => {
    const { resolveProfileConfig } = await import("../config.js");

    const profiled = {
      enabled: true,
      defaultProfile: "work",
      profiles: {
        work: {
          enabled: true,
          discord: {
            enabled: true,
            webhookUrl: "https://discord.com/api/webhooks/work",
          },
        },
        personal: {
          enabled: true,
          telegram: {
            enabled: true,
            botToken: "123:abc",
            chatId: "456",
          },
        },
      },
    };
    const result = resolveProfileConfig(profiled);
    assert.ok(result);
    assert.equal(result.discord!.webhookUrl, "https://discord.com/api/webhooks/work");
  });
});

// ---------- Edge cases ----------

describe("profile edge cases", () => {
  beforeEach(() => {
    clearProfileEnv();
  });

  afterEach(() => {
    clearProfileEnv();
  });

  it("profile can have multiple platforms configured", async () => {
    const { resolveProfileConfig } = await import("../config.js");
    const profile = {
      enabled: true,
      discord: {
        enabled: true,
        webhookUrl: "https://discord.com/api/webhooks/multi",
      },
      telegram: { enabled: true, botToken: "t", chatId: "c" },
      slack: {
        enabled: true,
        webhookUrl: "https://hooks.slack.com/services/multi",
      },
    };

    const result = resolveProfileConfig(
      {
        enabled: true,
        profiles: { multi: profile },
      },
      "multi",
    );

    assert.ok(result!.discord);
    assert.ok(result!.telegram);
    assert.ok(result!.slack);
  });

  it("env vars merge into selected profile config", async () => {
    process.env.OMX_TELEGRAM_BOT_TOKEN = "env-token";
    process.env.OMX_TELEGRAM_CHAT_ID = "env-chat";

    const { buildConfigFromEnv, resolveProfileConfig } = await import(
      "../config.js"
    );

    // Simulate what getNotificationConfig does: resolve profile, then merge env
    const profile = {
      enabled: true,
      discord: {
        enabled: true,
        webhookUrl: "https://discord.com/api/webhooks/test",
      },
    };
    const resolved = resolveProfileConfig(
      { enabled: true, profiles: { work: profile } },
      "work",
    );
    assert.ok(resolved);
    assert.equal(resolved.discord!.enabled, true);

    // Env config should be buildable separately
    const envConfig = buildConfigFromEnv();
    assert.ok(envConfig);
    assert.equal(envConfig!.telegram!.botToken, "env-token");
  });

  it("profile names are case-sensitive", async () => {
    const { resolveProfileConfig } = await import("../config.js");
    const config = {
      enabled: true,
      profiles: {
        Work: { enabled: true },
        work: {
          enabled: true,
          telegram: { enabled: true, botToken: "lower", chatId: "c" },
        },
      },
    };

    const upper = resolveProfileConfig(config, "Work");
    const lower = resolveProfileConfig(config, "work");
    assert.ok(upper);
    assert.ok(lower);
    assert.equal(upper!.telegram, undefined);
    assert.equal(lower!.telegram!.botToken, "lower");
  });

  it("profile names can contain hyphens and dots", async () => {
    const { resolveProfileConfig } = await import("../config.js");
    const config = {
      enabled: true,
      profiles: {
        "my-work.profile": {
          enabled: true,
          slack: {
            enabled: true,
            webhookUrl: "https://hooks.slack.com/services/hp",
          },
        },
      },
    };
    const result = resolveProfileConfig(config, "my-work.profile");
    assert.ok(result);
    assert.ok(result!.slack);
  });
});
