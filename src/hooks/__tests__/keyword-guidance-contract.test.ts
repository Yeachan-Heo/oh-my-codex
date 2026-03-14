import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { KEYWORD_TRIGGER_DEFINITIONS } from "../keyword-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const rootAgents = readFileSync(join(__dirname, "../../../AGENTS.md"), "utf-8");
const templateAgents = readFileSync(
	join(__dirname, "../../../templates/AGENTS.md"),
	"utf-8",
);

function extractKeywordTable(content: string): string {
	const match = content.match(
		/\| Keyword\(s\) \| Skill \| Action \|([\s\S]*?)\n\nDetection rules:/,
	);
	assert.ok(match, "Expected keyword table before Detection rules");
	return match[1] ?? "";
}

function parseKeywordSkillPairs(content: string): Set<string> {
	const table = extractKeywordTable(content);
	const pairs = new Set<string>();

	for (const line of table.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('| "')) continue;

		const cells = trimmed
			.split("|")
			.map((cell) => cell.trim())
			.filter(Boolean);
		assert.ok(
			cells.length >= 3,
			`Expected keyword table row with 3 cells: ${line}`,
		);

		const keywordsCell = cells[0] ?? "";
		const skillCell = cells[1] ?? "";
		const skillMatch = skillCell.match(/\$([a-z-]+)/i);
		assert.ok(skillMatch, `Expected skill token in row: ${line}`);
		const skill = skillMatch[1].toLowerCase();

		for (const keywordMatch of keywordsCell.matchAll(/"([^"]+)"/g)) {
			pairs.add(`${keywordMatch[1].toLowerCase()}=>${skill}`);
		}
	}

	return pairs;
}

function buildRegistryPairs(): Set<string> {
	return new Set(
		KEYWORD_TRIGGER_DEFINITIONS.map(
			({ keyword, skill }) =>
				`${keyword.toLowerCase()}=>${skill.toLowerCase()}`,
		),
	);
}

describe("keyword guidance contract", () => {
	const registryPairs = buildRegistryPairs();

	for (const [label, content] of [
		["root AGENTS", rootAgents],
		["template AGENTS", templateAgents],
	] as const) {
		it(`${label} enumerates every runtime keyword/skill pair`, () => {
			const documentedPairs = parseKeywordSkillPairs(content);
			assert.deepEqual(documentedPairs, registryPairs);
		});
	}
});
