import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { OmxQuestionError } from "../../question/client.js";
import {
	type AutoresearchStructuredQuestionAsker,
	type AutoresearchQuestionIO,
	buildAutoresearchDeepInterviewPrompt,
	parseInitArgs,
	runAutoresearchNoviceBridge,
} from "../autoresearch-guided.js";
import {
	isLaunchReadyEvaluatorCommand,
	resolveAutoresearchDeepInterviewResult,
	writeAutoresearchDeepInterviewArtifacts,
	writeAutoresearchDraftArtifact,
} from "../autoresearch-intake.js";

async function initWorkspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), "omx-autoresearch-guided-test-"));
}

function withMockedTty<T>(fn: () => Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", {
		configurable: true,
		value: true,
	});
	return fn().finally(() => {
		if (descriptor) {
			Object.defineProperty(process.stdin, "isTTY", descriptor);
		} else {
			Object.defineProperty(process.stdin, "isTTY", {
				configurable: true,
				value: false,
			});
		}
	});
}

function makeFakeIo(answers: string[]): AutoresearchQuestionIO {
	const queue = [...answers];
	return {
		async question(): Promise<string> {
			return queue.shift() ?? "";
		},
		close(): void {},
	};
}

function makeFakeStructuredQuestionAsker(
	answers: string[],
	questions: Array<{ question: string; options: string[]; allowOther: boolean }> = [],
): AutoresearchStructuredQuestionAsker {
	const queue = [...answers];
	return async (input) => {
		questions.push({
			question: input.question,
			options: input.options.map((option) => option.value),
			allowOther: input.allow_other,
		});
		const next = queue.shift() ?? "";
		const matchingOption = input.options.find((option) => option.value === next);
		if (matchingOption) {
			const answer = {
				kind: "option" as const,
				value: matchingOption.value,
				selected_labels: [matchingOption.label],
				selected_values: [matchingOption.value],
			};
			return {
				ok: true,
				question_id: `q-${questions.length}`,
				questions: [{
					id: "q-1",
					header: input.header,
					question: input.question,
					options: input.options,
					allow_other: input.allow_other,
					other_label: input.other_label ?? "Other",
					multi_select: input.multi_select ?? false,
					type: input.type ?? (input.multi_select ? "multi-answerable" : "single-answerable"),
				}],
				answers: [{ question_id: "q-1", index: 0, answer }],
				prompt: {
					header: input.header,
					question: input.question,
					options: input.options,
					allow_other: input.allow_other,
					other_label: input.other_label ?? "Other",
					multi_select: input.multi_select ?? false,
					source: input.source,
				},
				answer,
			};
		}

		const answer = {
			kind: "other" as const,
			value: next,
			selected_labels: [input.other_label ?? "Other"],
			selected_values: [next],
			other_text: next,
		};
		return {
			ok: true,
			question_id: `q-${questions.length}`,
			questions: [{
				id: "q-1",
				header: input.header,
				question: input.question,
				options: input.options,
				allow_other: input.allow_other,
				other_label: input.other_label ?? "Other",
				multi_select: input.multi_select ?? false,
				type: input.type ?? (input.multi_select ? "multi-answerable" : "single-answerable"),
			}],
			answers: [{ question_id: "q-1", index: 0, answer }],
			prompt: {
				header: input.header,
				question: input.question,
				options: input.options,
				allow_other: input.allow_other,
				other_label: input.other_label ?? "Other",
				multi_select: input.multi_select ?? false,
				source: input.source,
			},
			answer,
		};
	};
}

describe("parseInitArgs", () => {
	it("parses all flags with space-separated values", () => {
		const result = parseInitArgs([
			"--topic",
			"my topic",
			"--evaluator",
			"node eval.js",
			"--keep-policy",
			"pass_only",
			"--slug",
			"my-slug",
		]);
		assert.equal(result.topic, "my topic");
		assert.equal(result.evaluatorCommand, "node eval.js");
		assert.equal(result.keepPolicy, "pass_only");
		assert.equal(result.slug, "my-slug");
	});

	it("parses all flags with = syntax", () => {
		const result = parseInitArgs([
			"--topic=my topic",
			"--evaluator=node eval.js",
			"--keep-policy=score_improvement",
			"--slug=my-slug",
		]);
		assert.equal(result.topic, "my topic");
		assert.equal(result.evaluatorCommand, "node eval.js");
		assert.equal(result.keepPolicy, "score_improvement");
		assert.equal(result.slug, "my-slug");
	});

	it("returns partial result when some flags are missing", () => {
		const result = parseInitArgs(["--topic", "my topic"]);
		assert.equal(result.topic, "my topic");
		assert.equal(result.evaluatorCommand, undefined);
		assert.equal(result.keepPolicy, undefined);
		assert.equal(result.slug, undefined);
	});

	it("throws on invalid keep-policy", () => {
		assert.throws(
			() => parseInitArgs(["--keep-policy", "invalid"]),
			/must be one of/,
		);
	});

	it("throws on unknown flags", () => {
		assert.throws(
			() => parseInitArgs(["--unknown-flag", "value"]),
			/Unknown init flag: --unknown-flag/,
		);
	});

	it("sanitizes slug via slugifyMissionName", () => {
		const result = parseInitArgs(["--slug", "../../etc/cron.d/omx"]);
		assert.ok(result.slug);
		assert.doesNotMatch(result.slug!, /\.\./);
		assert.doesNotMatch(result.slug!, /\//);
	});
});

describe("autoresearch intake draft artifacts", () => {
	it("writes a canonical deep-interview autoresearch draft artifact from vague input", async () => {
		const repo = await initWorkspace();
		try {
			const artifact = await writeAutoresearchDraftArtifact({
				repoRoot: repo,
				topic: "Improve onboarding for first-time contributors",
				keepPolicy: "score_improvement",
				seedInputs: { topic: "Improve onboarding for first-time contributors" },
			});

			assert.match(
				artifact.path,
				/\.omx\/specs\/deep-interview-autoresearch-improve-onboarding-for-first-time-contributors\.md$/,
			);
			assert.equal(artifact.launchReady, false);
			assert.match(artifact.content, /## Mission Draft/);
			assert.match(artifact.content, /## Evaluator Draft/);
			assert.match(artifact.content, /## Launch Readiness/);
			assert.match(artifact.content, /## Seed Inputs/);
			assert.match(artifact.content, /## Confirmation Bridge/);
			assert.match(artifact.content, /TODO replace with evaluator command/i);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("rejects placeholder evaluator commands and accepts concrete commands", () => {
		assert.equal(isLaunchReadyEvaluatorCommand("TODO replace me"), false);
		assert.equal(isLaunchReadyEvaluatorCommand("node scripts/eval.js"), true);
		assert.equal(isLaunchReadyEvaluatorCommand("bash scripts/eval.sh"), true);
	});

	it("writes launch-consumable mission/sandbox/result artifacts and resolves them back", async () => {
		const repo = await initWorkspace();
		try {
			const artifacts = await writeAutoresearchDeepInterviewArtifacts({
				repoRoot: repo,
				topic: "Measure onboarding friction",
				evaluatorCommand: "node scripts/eval.js",
				keepPolicy: "pass_only",
				slug: "onboarding-friction",
				seedInputs: { topic: "Measure onboarding friction" },
			});

			assert.match(
				artifacts.draftArtifactPath,
				/deep-interview-autoresearch-onboarding-friction\.md$/,
			);
			assert.match(
				artifacts.missionArtifactPath,
				/autoresearch-onboarding-friction\/mission\.md$/,
			);
			assert.match(
				artifacts.sandboxArtifactPath,
				/autoresearch-onboarding-friction\/sandbox\.md$/,
			);
			assert.match(
				artifacts.resultPath,
				/autoresearch-onboarding-friction\/result\.json$/,
			);

			const resolved = await resolveAutoresearchDeepInterviewResult(repo, {
				slug: "onboarding-friction",
			});
			assert.ok(resolved);
			assert.equal(resolved?.compileTarget.slug, "onboarding-friction");
			assert.equal(resolved?.compileTarget.keepPolicy, "pass_only");
			assert.equal(resolved?.launchReady, true);
			assert.match(
				resolved?.missionContent || "",
				/Measure onboarding friction/,
			);
			assert.match(
				resolved?.sandboxContent || "",
				/command: node scripts\/eval\.js/,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});

describe("buildAutoresearchDeepInterviewPrompt", () => {
	it("activates deep-interview --autoresearch and includes seed inputs", () => {
		const prompt = buildAutoresearchDeepInterviewPrompt({
			topic: "Investigate flaky tests",
			evaluatorCommand: "node scripts/eval.js",
			keepPolicy: "score_improvement",
			slug: "flaky-tests",
		});

		assert.match(prompt, /\$deep-interview --autoresearch/);
		assert.match(
			prompt,
			/Do not launch tmux or run `omx autoresearch` yourself/,
		);
		assert.match(prompt, /deep-interview-autoresearch-\{slug\}\.md/);
		assert.match(prompt, /autoresearch-\{slug\}\/mission\.md/);
		assert.match(prompt, /- topic: Investigate flaky tests/);
		assert.match(prompt, /- evaluator: node scripts\/eval\.js/);
		assert.match(prompt, /- keep_policy: score_improvement/);
		assert.match(prompt, /- slug: flaky-tests/);
	});
});

describe("runAutoresearchNoviceBridge", () => {
	it("falls back to plain terminal prompts when omx question is unavailable", async () => {
		const repo = await initWorkspace();
		try {
			const result = await withMockedTty(() =>
				runAutoresearchNoviceBridge(
					repo,
					{},
					makeFakeIo([
						"Improve evaluator UX",
						"Passing evaluator output",
						"node scripts/eval.js",
						"pass_only",
						"ux-eval",
						"launch",
					]),
					async () => {
						throw new Error("omx question requires tmux for OMX-owned question UI rendering in this session.");
					},
				),
			);

			assert.equal(result.slug, "ux-eval");
			assert.equal(result.resultPath, join(repo, ".omx", "specs", "autoresearch-ux-eval", "result.json"));
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("does not fall back to plain prompts when question policy denies structured questions", async () => {
		const repo = await initWorkspace();
		try {
			await mkdir(join(repo, ".omx", "state", "sessions", "sess-autoresearch"), {
				recursive: true,
			});
			await writeFile(
				join(repo, ".omx", "state", "session.json"),
				JSON.stringify({ session_id: "sess-autoresearch" }),
			);
			await writeFile(
				join(
					repo,
					".omx",
					"state",
					"sessions",
					"sess-autoresearch",
					"autoresearch-state.json",
				),
				JSON.stringify({ mode: "autoresearch", active: true }),
			);

			await assert.rejects(
				() =>
					withMockedTty(() =>
						runAutoresearchNoviceBridge(
							repo,
							{},
							makeFakeIo([
								"should not be used",
								"should not be used",
							]),
							async () => {
								throw new OmxQuestionError(
									"active_execution_mode_blocked",
									"omx question is unavailable while auto-executing workflows are active: autoresearch.",
								);
							},
						),
					),
				(error) => {
					assert.ok(error instanceof OmxQuestionError);
					assert.equal(error.code, "active_execution_mode_blocked");
					return true;
				},
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("uses structured omx-question prompts and resumes from returned stdout answers", async () => {
		const repo = await initWorkspace();
		const askedQuestions: Array<{ question: string; options: string[]; allowOther: boolean }> = [];
		try {
			const result = await withMockedTty(() =>
				runAutoresearchNoviceBridge(
					repo,
					{},
					makeFakeIo([]),
					makeFakeStructuredQuestionAsker(
						[
							"Improve evaluator UX",
							"Passing evaluator output",
							"node scripts/eval.js",
							"pass_only",
							"ux-eval",
							"launch",
						],
						askedQuestions,
					),
				),
			);

			assert.equal(result.slug, "ux-eval");
			assert.equal(result.resultPath, join(repo, ".omx", "specs", "autoresearch-ux-eval", "result.json"));
			assert.equal(askedQuestions.length, 6);
			assert.equal(askedQuestions[0]?.question, "Research topic/goal");
			assert.deepEqual(askedQuestions[0]?.options, []);
			assert.equal(askedQuestions[0]?.allowOther, true);
			assert.match(askedQuestions[5]?.question || "", /Next step/);
			assert.deepEqual(askedQuestions[5]?.options, ["launch", "refine"]);
			assert.equal(askedQuestions[5]?.allowOther, false);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("loops through refine further before launching and writes canonical spec artifacts", async () => {
		const repo = await initWorkspace();
		try {
			const result = await withMockedTty(() =>
				runAutoresearchNoviceBridge(
					repo,
					{},
					makeFakeIo([
						"Improve evaluator UX",
						"Make success measurable",
						"TODO replace with evaluator command",
						"score_improvement",
						"ux-eval",
						"refine further",
						"Improve evaluator UX",
						"Passing evaluator output",
						"node scripts/eval.js",
						"pass_only",
						"ux-eval",
						"launch",
					]),
				),
			);

			const draftContent = await readFile(
				join(repo, ".omx", "specs", "deep-interview-autoresearch-ux-eval.md"),
				"utf-8",
			);
			const resultContent = await readFile(result.resultPath, "utf-8");
			const missionContent = await readFile(
				result.missionArtifactPath,
				"utf-8",
			);
			const sandboxContent = await readFile(
				result.sandboxArtifactPath,
				"utf-8",
			);

			assert.equal(
				result.artifactDir,
				join(repo, ".omx", "specs", "autoresearch-ux-eval"),
			);
			assert.equal(result.slug, "ux-eval");
			assert.match(draftContent, /Launch-ready: yes/);
			assert.match(resultContent, /"launchReady": true/);
			assert.match(missionContent, /Improve evaluator UX/);
			assert.match(sandboxContent, /command: node scripts\/eval\.js/);
			assert.match(sandboxContent, /keep_policy: pass_only/);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("uses seeded novice inputs while still requiring confirmation-driven launch", async () => {
		const repo = await initWorkspace();
		try {
			const result = await withMockedTty(() =>
				runAutoresearchNoviceBridge(
					repo,
					{
						topic: "Seeded topic",
						evaluatorCommand: "node scripts/eval.js",
						keepPolicy: "score_improvement",
						slug: "seeded-topic",
					},
					makeFakeIo(["", "", "", "", "", "launch"]),
				),
			);

			const draftContent = await readFile(
				join(
					repo,
					".omx",
					"specs",
					"deep-interview-autoresearch-seeded-topic.md",
				),
				"utf-8",
			);
			assert.equal(
				result.resultPath,
				join(repo, ".omx", "specs", "autoresearch-seeded-topic", "result.json"),
			);
			assert.equal(result.slug, "seeded-topic");
			assert.match(draftContent, /- topic: Seeded topic/);
			assert.match(draftContent, /- evaluator: node scripts\/eval\.js/);
			assert.match(draftContent, /Launch-ready: yes/);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});
