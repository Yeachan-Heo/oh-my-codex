import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_PROVIDERS,
  ORCAROUTER_PROVIDER_INFO,
  ORCAROUTER_PROVIDER_NAME,
  getKnownProvider,
  isKnownProvider,
} from "../providers.js";

test("exposes orcarouter as a first-class known provider", () => {
  assert.equal(ORCAROUTER_PROVIDER_NAME, "orcarouter");
  assert.equal(ORCAROUTER_PROVIDER_INFO.name, "orcarouter");
  assert.equal(ORCAROUTER_PROVIDER_INFO.envKey, "ORCAROUTER_API_KEY");
  assert.match(ORCAROUTER_PROVIDER_INFO.baseUrl ?? "", /^https:\/\/api\.orcarouter\.ai\//);
});

test("getKnownProvider returns metadata for known providers", () => {
  assert.equal(getKnownProvider("orcarouter")?.name, "orcarouter");
  assert.equal(getKnownProvider("openai")?.name, "openai");
  assert.equal(getKnownProvider("openai-chatgpt")?.name, "openai-chatgpt");
});

test("getKnownProvider returns undefined for unknown providers", () => {
  assert.equal(getKnownProvider("acme-gateway"), undefined);
  assert.equal(getKnownProvider(""), undefined);
  assert.equal(getKnownProvider(undefined), undefined);
});

test("isKnownProvider distinguishes known from unknown providers", () => {
  assert.equal(isKnownProvider("orcarouter"), true);
  assert.equal(isKnownProvider("acme-gateway"), false);
});

test("KNOWN_PROVIDERS includes orcarouter exactly once", () => {
  const names = KNOWN_PROVIDERS.map((provider) => provider.name);
  assert.ok(names.includes("orcarouter"));
  assert.equal(
    names.filter((name) => name === "orcarouter").length,
    1,
  );
});
