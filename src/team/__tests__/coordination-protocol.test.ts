import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	normalizeTeamTaskCoordinationPlanForStorage,
	synthesizeCoordinationPlan,
	synthesizeCoordinationPlans,
	type TeamCoordinationTaskInput,
} from "../coordination-protocol.js";
import type { TeamTask } from "../state.js";

function task(
	overrides: Partial<TeamTask> & { symbolic_depends_on?: string[] },
): TeamCoordinationTaskInput {
	return {
		id: "1",
		subject: "subject",
		description: "description",
		status: "pending",
		created_at: new Date(0).toISOString(),
		...overrides,
	};
}

describe("team coordination protocol gating", () => {
	it("keeps explicit independent fan-out lightweight", () => {
		const plan = synthesizeCoordinationPlan(
			task({
				subject: "Independent docs sweep",
				description:
					"Fan-out read-only sweep: each worker checks one separate doc, no shared files and no dependencies.",
			}),
		);

		assert.equal(plan.mode, "lightweight");
		assert.ok(plan.activation_reasons.includes("explicit_independent_fanout"));
		assert.equal(plan.required_mechanisms, undefined);
	});

	it("lets singular no-shared-file/no-dependency wording stay lightweight", () => {
		const plan = synthesizeCoordinationPlan(
			task({
				subject: "Fixture lane",
				description: "No shared file/no dependency lane.",
			}),
		);

		assert.equal(plan.mode, "lightweight");
		assert.ok(plan.activation_reasons.includes("explicit_independent_fanout"));
	});

	it("lets hyphenated no-shared-file/no-dependency wording stay lightweight", () => {
		const plan = synthesizeCoordinationPlan(
			task({
				subject: "Fixture lane",
				description: "No-shared-file/no-dependency lane.",
			}),
		);

		assert.equal(plan.mode, "lightweight");
		assert.ok(plan.activation_reasons.includes("explicit_independent_fanout"));
	});

	it("keeps simple narrow tasks lightweight", () => {
		const plan = synthesizeCoordinationPlan(
			task({
				subject: "Fix typo",
				description: "Fix one typo in README.md",
			}),
		);

		assert.equal(plan.mode, "lightweight");
		assert.ok(plan.activation_reasons.includes("simple_narrow_scope"));
	});

	it("activates coordinated protocol for dependency and handoff work", () => {
		const plan = synthesizeCoordinationPlan(
			task({
				subject: "Integrate parser and verification lanes",
				description:
					"Coordinate handoff across shared parser contract and e2e verification.",
				depends_on: ["1"],
			}),
		);

		assert.equal(plan.mode, "coordinated");
		assert.ok(plan.activation_reasons.includes("task_dependencies"));
		assert.ok(
			plan.activation_reasons.includes("cross_boundary_or_handoff_language"),
		);
		assert.deepEqual(plan.required_mechanisms, [
			"shared_mental_model",
			"closed_loop_communication",
			"mutual_performance_monitoring",
			"backup_behavior",
			"adaptability_checkpoint",
			"team_orientation",
		]);
	});

	it("activates coordinated protocol for overlapping file paths across sibling tasks", () => {
		const plans = synthesizeCoordinationPlans([
			task({
				subject: "Update parser",
				description: "Implement parser change",
				filePaths: ["src/parser.ts"],
			}),
			task({
				subject: "Update parser tests",
				description: "Add tests",
				filePaths: ["src/parser.ts"],
			}),
			task({
				subject: "Independent docs",
				description: "Fan-out read-only doc check",
				filePaths: ["docs/usage.md"],
			}),
		]);

		assert.equal(plans[0]?.mode, "coordinated");
		assert.equal(plans[1]?.mode, "coordinated");
		assert.ok(plans[0]?.activation_reasons.includes("shared_file_scope"));
		assert.ok(plans[1]?.activation_reasons.includes("shared_file_scope"));
		assert.equal(plans[2]?.mode, "lightweight");
	});

	it("canonicalizes equivalent file paths before detecting sibling overlap", () => {
		const plans = synthesizeCoordinationPlans([
			task({
				subject: "Update parser",
				description: "Implement parser change",
				filePaths: ["./src/parser.ts"],
			}),
			task({
				subject: "Update parser tests",
				description: "Add tests",
				filePaths: ["src/./parser.ts"],
			}),
		]);

		assert.equal(plans[0]?.mode, "coordinated");
		assert.equal(plans[1]?.mode, "coordinated");
		assert.ok(plans[0]?.activation_reasons.includes("shared_file_scope"));
		assert.ok(plans[1]?.activation_reasons.includes("shared_file_scope"));
	});

	it("activates coordinated protocol for overlapping domains across sibling tasks", () => {
		const plans = synthesizeCoordinationPlans([
			task({
				subject: "Runtime lane A",
				description: "Implement update",
				domains: ["team-runtime"],
			}),
			task({
				subject: "Runtime lane B",
				description: "Verify update",
				domains: ["team-runtime"],
			}),
		]);

		assert.equal(plans[0]?.mode, "coordinated");
		assert.equal(plans[1]?.mode, "coordinated");
		assert.ok(plans[0]?.activation_reasons.includes("shared_domain_scope"));
		assert.ok(plans[1]?.activation_reasons.includes("shared_domain_scope"));
	});

	it("activates coordinated protocol for symbolic dependencies before DAG remapping", () => {
		const plan = synthesizeCoordinationPlan(
			task({
				subject: "Dependent verification",
				description: "Run verification after implementation",
				symbolic_depends_on: ["impl"],
			}),
		);

		assert.equal(plan.mode, "coordinated");
		assert.ok(plan.activation_reasons.includes("task_dependencies"));
	});

	it("treats mixed invalid coordination mechanisms as an untrusted override", () => {
		const plan = normalizeTeamTaskCoordinationPlanForStorage({
			mode: "coordinated",
			activation_reasons: [
				" cross_boundary_or_handoff_language ",
				"cross_boundary_or_handoff_language",
			],
			required_mechanisms: ["closed_loop_communication", "bogus-mechanism"],
		});

		assert.deepEqual(plan, {
			mode: "coordinated",
			activation_reasons: ["cross_boundary_or_handoff_language"],
			required_mechanisms: [
				"shared_mental_model",
				"closed_loop_communication",
				"mutual_performance_monitoring",
				"backup_behavior",
				"adaptability_checkpoint",
				"team_orientation",
			],
		});
	});

	it("falls back to the full mechanism checklist when metadata has no valid mechanisms", () => {
		const plan = normalizeTeamTaskCoordinationPlanForStorage({
			mode: "coordinated",
			activation_reasons: ["cross_boundary_or_handoff_language"],
			required_mechanisms: ["bogus-mechanism"],
		});

		assert.deepEqual(plan?.required_mechanisms, [
			"shared_mental_model",
			"closed_loop_communication",
			"mutual_performance_monitoring",
			"backup_behavior",
			"adaptability_checkpoint",
			"team_orientation",
		]);
	});
});
