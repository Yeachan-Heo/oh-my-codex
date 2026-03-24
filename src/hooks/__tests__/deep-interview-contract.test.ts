import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readProjectAgents(startDir: string): string {
	let currentDir = startDir;

	while (true) {
		const candidate = join(currentDir, "AGENTS.md");
		if (existsSync(candidate)) {
			const content = readFileSync(candidate, "utf-8");
			if (!/Team Worker Runtime Instructions/i.test(content)) {
				return content;
			}
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			break;
		}
		currentDir = parentDir;
	}

	return readFileSync(join(startDir, "AGENTS.md"), "utf-8");
}

const deepInterviewSkill = readFileSync(
	join(__dirname, "../../../skills/deep-interview/SKILL.md"),
	"utf-8",
);
const autopilotSkill = readFileSync(
	join(__dirname, "../../../skills/autopilot/SKILL.md"),
	"utf-8",
);
const rootAgents = readProjectAgents(join(__dirname, "../../.."));
const templateAgents = readFileSync(
	join(__dirname, "../../../templates/AGENTS.md"),
	"utf-8",
);

describe("deep-interview Ouroboros contract", () => {
	it("includes ambiguity gate math and intent-first scoring", () => {
		assert.match(deepInterviewSkill, /ambiguity/i);
		assert.match(deepInterviewSkill, /threshold/i);
		assert.match(deepInterviewSkill, /Greenfield: `ambiguity =/);
		assert.match(deepInterviewSkill, /Brownfield: `ambiguity =/);
		assert.match(deepInterviewSkill, /intent × 0\.30/i);
		assert.match(deepInterviewSkill, /Decision Boundaries/i);
	});

	it("adds intent-first concepts and readiness gates", () => {
		assert.match(deepInterviewSkill, /Intent \(why the user wants this\)/i);
		assert.match(deepInterviewSkill, /Desired Outcome/i);
		assert.match(deepInterviewSkill, /Out-of-Scope \/ Non-goals/i);
		assert.match(deepInterviewSkill, /Decision Boundaries/i);
		assert.match(deepInterviewSkill, /Reduce user effort/i);
		assert.match(deepInterviewSkill, /must be explicit/i);
		assert.match(deepInterviewSkill, /pressure pass/i);
	});

	it("prioritizes intent-boundary questioning before implementation detail", () => {
		const intentFirstIndex = deepInterviewSkill.indexOf(
			"Ask about intent and boundaries before implementation detail",
		);
		const weakDimIndex = deepInterviewSkill.indexOf(
			"Target the lowest-scoring dimension, but respect stage priority",
		);
		const artifactIndex = deepInterviewSkill.indexOf("Spec should include:");

		assert.notEqual(intentFirstIndex, -1);
		assert.notEqual(weakDimIndex, -1);
		assert.notEqual(artifactIndex, -1);
		assert.ok(intentFirstIndex < artifactIndex);
		assert.ok(weakDimIndex < artifactIndex);
	});
	it("includes challenge mode structure", () => {
		assert.match(deepInterviewSkill, /Contrarian/i);
		assert.match(deepInterviewSkill, /Simplifier/i);
		assert.match(deepInterviewSkill, /Ontologist/i);
	});

	it("strengthens questioning pressure on all four analysis axes", () => {
		assert.match(
			deepInterviewSkill,
			/Treat every answer as a claim to pressure-test before moving on/i,
		);
		assert.match(
			deepInterviewSkill,
			/demand evidence or examples, expose a hidden assumption, force a tradeoff or boundary, or reframe root cause vs symptom/i,
		);
		assert.match(
			deepInterviewSkill,
			/Do not rotate to a new clarity dimension just for coverage/i,
		);
		assert.match(
			deepInterviewSkill,
			/Prefer staying on the same thread for multiple rounds when it has the highest leverage/i,
		);
		assert.match(
			deepInterviewSkill,
			/Do not offer early exit before the first explicit assumption probe and one persistent follow-up have happened/i,
		);
		assert.match(
			deepInterviewSkill,
			/Round 4\+: allow explicit early exit with risk warning/i,
		);
	});

	it("moves challenge modes and preserved evidence discipline earlier", () => {
		assert.match(
			deepInterviewSkill,
			/Contrarian.*round 2\+.*untested assumption/i,
		);
		assert.match(
			deepInterviewSkill,
			/Simplifier.*round 4\+.*scope expands faster than outcome clarity/i,
		);
		assert.match(
			deepInterviewSkill,
			/Ontologist.*round 5\+.*ambiguity > 0\.25.*describing symptoms/i,
		);
		assert.match(
			deepInterviewSkill,
			/Brownfield evidence vs inference notes/i,
		);
	});

	it("includes contract-style execution bridge and no-direct-implementation guard", () => {
		assert.match(deepInterviewSkill, /Execution Bridge/i);
		assert.match(deepInterviewSkill, /\$ralplan/i);
		assert.match(deepInterviewSkill, /\$autopilot/i);
		assert.match(deepInterviewSkill, /\$ralph/i);
		assert.match(deepInterviewSkill, /\$team/i);
		assert.match(deepInterviewSkill, /Input Artifact/i);
		assert.match(deepInterviewSkill, /Invocation/i);
		assert.match(deepInterviewSkill, /Consumer Behavior/i);
		assert.match(deepInterviewSkill, /Skipped \/ Already-Satisfied Stages/i);
		assert.match(deepInterviewSkill, /Expected Output/i);
		assert.match(deepInterviewSkill, /Best When/i);
		assert.match(deepInterviewSkill, /Next Recommended Step/i);
		assert.match(deepInterviewSkill, /Residual-Risk Rule/i);
		assert.match(deepInterviewSkill, /Do NOT implement directly/i);
	});

	it("preserves clarified intent and boundary constraints across execution handoff", () => {
		assert.match(
			deepInterviewSkill,
			/preserve intent, non-goals, decision boundaries, acceptance criteria/i,
		);
		assert.match(deepInterviewSkill, /binding context/i);
		assert.match(deepInterviewSkill, /team verification path/i);
	});

	it("uses OMX-native output paths", () => {
		assert.match(deepInterviewSkill, /\.omx\/interviews\//);
		assert.match(deepInterviewSkill, /\.omx\/specs\//);
	});

	it("requires preflight context intake before interview rounds", () => {
		assert.match(deepInterviewSkill, /Phase 0: Preflight Context Intake/i);
		assert.match(
			deepInterviewSkill,
			/preflight context intake before the first interview question/i,
		);
		assert.match(
			deepInterviewSkill,
			/\.omx\/context\/\{slug\}-\{timestamp\}\.md/,
		);
		assert.match(deepInterviewSkill, /context_snapshot_path/i);
	});

	it("documents the autoresearch specialization contract", () => {
		assert.match(deepInterviewSkill, /Autoresearch specialization/i);
		assert.match(deepInterviewSkill, /Accepted seed inputs/i);
		assert.match(deepInterviewSkill, /topic/i);
		assert.match(deepInterviewSkill, /evaluator/i);
		assert.match(deepInterviewSkill, /keep-policy/i);
		assert.match(deepInterviewSkill, /slug/i);
		assert.match(deepInterviewSkill, /mission clarity/i);
		assert.match(deepInterviewSkill, /evaluator readiness/i);
		assert.match(
			deepInterviewSkill,
			/\.omx\/specs\/deep-interview-autoresearch-\{slug\}\.md/i,
		);
		assert.match(deepInterviewSkill, /Mission Draft/i);
		assert.match(deepInterviewSkill, /Evaluator Draft/i);
		assert.match(deepInterviewSkill, /Launch Readiness/i);
		assert.match(deepInterviewSkill, /Seed Inputs/i);
		assert.match(deepInterviewSkill, /Confirmation Bridge/i);
		assert.match(deepInterviewSkill, /refine further/i);
		assert.match(deepInterviewSkill, /launch/i);
		assert.match(
			deepInterviewSkill,
			/do not launch detached tmux until the user explicitly confirms/i,
		);
		assert.match(deepInterviewSkill, /<\.\.\.>/i);
		assert.match(deepInterviewSkill, /TODO/i);
		assert.match(deepInterviewSkill, /TBD/i);
		assert.match(deepInterviewSkill, /REPLACE_ME/i);
		assert.match(deepInterviewSkill, /CHANGEME/i);
		assert.match(deepInterviewSkill, /your-command-here/i);
	});
});

describe("cross-skill and AGENTS coherence for deep-interview", () => {
	it("autopilot references deep-interview handoff", () => {
		assert.match(autopilotSkill, /deep-interview/i);
		assert.match(autopilotSkill, /Socratic/i);
	});

	it("root and template AGENTS include ouroboros keyword and updated description", () => {
		assert.match(rootAgents, /ouroboros/i);
		assert.match(templateAgents, /ouroboros/i);
		assert.match(rootAgents, /Socratic deep interview/i);
		assert.match(templateAgents, /Socratic deep interview/i);
	});
});
