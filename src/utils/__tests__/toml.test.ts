import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TOML from "@iarna/toml";
import { readTopLevelTomlString, upsertTopLevelTomlString } from "../toml.js";

describe("quoted TOML table boundaries", () => {
  for (const delimiter of ["'''", '\"\"\"']) {
    for (const existing of [true, false]) {
      it(`preserves multiline instructions (${delimiter}, existing=${existing})`, () => {
        const instructions = `developer_instructions = ${delimiter}\nmodel_reasoning_effort = "low"\n[example]\n${delimiter}\n`;
        const source = instructions + (existing ? 'model_reasoning_effort = "medium"\n' : "") + '[features]\nfoo = true\n';
        assert.equal(readTopLevelTomlString(source, "model_reasoning_effort"), existing ? "medium" : null);
        const updated = upsertTopLevelTomlString(source, "model_reasoning_effort", "high");
        const parsed = TOML.parse(updated);
        assert.equal(parsed.developer_instructions, TOML.parse(source).developer_instructions);
        assert.equal(parsed.model_reasoning_effort, "high");
        assert.deepEqual(parsed.features, { foo: true });
      });
    }
  }

  for (const header of [
    '[projects."/tmp/demo[1]"]',
    "[projects.'/tmp/demo[1]']",
    '[[entries."name[1]"]] # array of tables',
  ]) {
    it(`preserves the nested value and inserts at top level before ${header}`, () => {
      const source = `${header}\r\nmodel_reasoning_effort = "low"\r\n`;
      assert.equal(readTopLevelTomlString(source, "model_reasoning_effort"), null);
      const updated = upsertTopLevelTomlString(source, "model_reasoning_effort", "high");
      assert.equal(updated, `model_reasoning_effort = "high"\r\n${source}`);
      const { model_reasoning_effort, ...nested } = TOML.parse(updated);
      assert.equal(model_reasoning_effort, "high");
      assert.deepEqual(nested, TOML.parse(source));
    });
  }
});
