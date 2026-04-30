import { dirname } from "node:path";
import { createInterface } from "readline/promises";
import {
	type AutoresearchKeepPolicy,
	slugifyMissionName,
} from "../autoresearch/contracts.js";
import {
	OmxQuestionError,
	type OmxQuestionSuccessPayload,
} from "../question/client.js";
import { evaluateQuestionPolicy } from "../question/policy.js";
import type { QuestionType } from "../question/types.js";
import { runDeepInterviewQuestion } from "../question/deep-interview.js";
import {
	type AutoresearchDeepInterviewResult,
	type AutoresearchSeedInputs,
	isLaunchReadyEvaluatorCommand,
	writeAutoresearchDeepInterviewArtifacts,
} from "./autoresearch-intake.js";

export interface InitAutoresearchOptions {
	topic: string;
	evaluatorCommand: string;
	keepPolicy: AutoresearchKeepPolicy;
	slug: string;
	repoRoot: string;
}

export interface InitAutoresearchResult {
	slug: string;
	artifactDir: string;
	missionArtifactPath: string;
	sandboxArtifactPath: string;
	resultPath: string;
}

export interface AutoresearchQuestionIO {
	question(prompt: string): Promise<string>;
	close(): void;
}

export interface AutoresearchStructuredQuestionInput {
	header?: string;
	question: string;
	options: Array<{ label: string; value: string; description?: string }>;
	allow_other: boolean;
	other_label?: string;
	multi_select?: boolean;
	type?: QuestionType;
	source?: string;
}

export type AutoresearchStructuredQuestionAsker = (
	input: AutoresearchStructuredQuestionInput,
) => Promise<OmxQuestionSuccessPayload>;

function primaryStructuredAnswer(response: OmxQuestionSuccessPayload): OmxQuestionSuccessPayload["answers"][number]["answer"] {
	const answer = response.answers[0]?.answer ?? response.answer;
	if (!answer) throw new Error("Structured question returned no answer.");
	return answer;
}

function createQuestionIO(): AutoresearchQuestionIO {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return {
		question(prompt: string) {
			return rl.question(prompt);
		},
		close() {
			rl.close();
		},
	};
}

async function promptWithDefault(
	io: AutoresearchQuestionIO,
	prompt: string,
	currentValue?: string,
	structuredQuestion?: AutoresearchStructuredQuestionAsker,
): Promise<string> {
	if (structuredQuestion) {
		const trimmedCurrentValue = currentValue?.trim() || "";
		const response = await structuredQuestion({
			header: "Deep Interview / Autoresearch",
			question: prompt,
			options: trimmedCurrentValue
				? [
						{
							label: "Keep current value",
							value: trimmedCurrentValue,
							description: trimmedCurrentValue,
						},
				  ]
				: [],
			allow_other: true,
			other_label: trimmedCurrentValue
				? "Enter a different value"
				: "Enter your response",
			source: "deep-interview",
		});
		const answer = primaryStructuredAnswer(response);
		const answerValue = answer.other_text?.trim()
			|| (typeof answer.value === "string" ? answer.value.trim() : "");
		return answerValue || trimmedCurrentValue || "";
	}

	const suffix = currentValue?.trim() ? ` [${currentValue.trim()}]` : "";
	const answer = await io.question(`${prompt}${suffix}\n> `);
	return answer.trim() || currentValue?.trim() || "";
}

async function promptAction(
	io: AutoresearchQuestionIO,
	launchReady: boolean,
	structuredQuestion?: AutoresearchStructuredQuestionAsker,
): Promise<"launch" | "refine"> {
	if (structuredQuestion) {
		const response = await structuredQuestion({
			header: "Deep Interview / Autoresearch",
			question: `Next step (default: ${launchReady ? "launch" : "refine further"})`,
			options: [
				{
					label: "Launch",
					value: "launch",
					description: "Finalize artifacts and hand off to $autoresearch.",
				},
				{
					label: "Refine further",
					value: "refine",
					description: "Keep clarifying before launch.",
				},
			],
			allow_other: false,
			source: "deep-interview",
		});
		const answer = primaryStructuredAnswer(response);
		const answerValue = typeof answer.value === "string"
			? answer.value.trim().toLowerCase()
			: "";
		if (answerValue === "launch") return "launch";
		if (answerValue === "refine") return "refine";
		throw new Error('Structured question returned an invalid next-step answer.');
	}

	const answer = (
		await io.question(
			`\nNext step [launch/refine further] (default: ${launchReady ? "launch" : "refine further"})\n> `,
		)
	)
		.trim()
		.toLowerCase();
	if (!answer) return launchReady ? "launch" : "refine";
	if (answer === "launch") return "launch";
	if (answer === "refine further" || answer === "refine" || answer === "r")
		return "refine";
	throw new Error('Please choose either "launch" or "refine further".');
}

function createStructuredQuestionAsker(
	repoRoot: string,
): AutoresearchStructuredQuestionAsker {
	return (input) =>
		runDeepInterviewQuestion(
			{
				header: input.header,
				question: input.question,
				options: input.options,
				allow_other: input.allow_other,
				other_label: input.other_label ?? "Other",
				type: input.type,
				multi_select: input.multi_select ?? false,
				source: input.source ?? "deep-interview",
			},
			{ cwd: repoRoot },
		);
}

async function ensureStructuredQuestionFallbackAllowed(
	repoRoot: string,
): Promise<void> {
	const policy = await evaluateQuestionPolicy({ cwd: repoRoot });
	if (policy.allowed || policy.fallbackAllowed !== false) return;
	throw new OmxQuestionError(
		policy.code ?? "question_policy_denied",
		policy.message ?? "Structured questions are unavailable in the current OMX workflow context.",
	);
}

function shouldFallbackFromStructuredQuestion(error: unknown): boolean {
	if (error instanceof OmxQuestionError) {
		if (
			error.code === "worker_blocked"
			|| error.code === "team_blocked"
			|| error.code === "active_execution_mode_blocked"
		) {
			return false;
		}
		return true;
	}

	const message = error instanceof Error ? error.message : String(error);
	return /omx question/i.test(message);
}

function ensureLaunchReadyEvaluator(command: string): void {
	if (!isLaunchReadyEvaluatorCommand(command)) {
		throw new Error(
			"Evaluator command is still a placeholder/template. Refine further before launch.",
		);
	}
}

export function buildAutoresearchDeepInterviewPrompt(
	seedInputs: AutoresearchSeedInputs = {},
): string {
	const seedLines = [
		`- topic: ${seedInputs.topic?.trim() || "(none)"}`,
		`- evaluator: ${seedInputs.evaluatorCommand?.trim() || "(none)"}`,
		`- keep_policy: ${seedInputs.keepPolicy || "(none)"}`,
		`- slug: ${seedInputs.slug?.trim() || "(none)"}`,
	];

	return [
		"$deep-interview --autoresearch",
		"Run the deep-interview skill in autoresearch mode for `$autoresearch`.",
		"Guide the user through research topic definition, evaluator readiness, keep policy, and slug/session naming.",
		"Do not launch tmux or run `omx autoresearch` yourself; direct CLI launch is deprecated. Hand off to `$autoresearch` after confirmation.",
		"When the user confirms launch and the evaluator is concrete, write/update these canonical artifacts under `.omx/specs/`:",
		"- `deep-interview-autoresearch-{slug}.md`",
		"- `autoresearch-{slug}/mission.md`",
		"- `autoresearch-{slug}/sandbox.md`",
		"- `autoresearch-{slug}/result.json`",
		"Use the contract and helper functions in `src/cli/autoresearch-intake.ts` for the artifact shape.",
		"If the evaluator command still contains placeholders or the user has not confirmed launch, keep refining instead of finalizing launch-ready output.",
		"",
		"Seed inputs:",
		...seedLines,
	].join("\n");
}

export async function materializeAutoresearchDeepInterviewResult(
	result: AutoresearchDeepInterviewResult,
): Promise<InitAutoresearchResult> {
	ensureLaunchReadyEvaluator(result.compileTarget.evaluatorCommand);
	return {
		slug: result.compileTarget.slug,
		artifactDir: dirname(result.resultPath),
		missionArtifactPath: result.missionArtifactPath,
		sandboxArtifactPath: result.sandboxArtifactPath,
		resultPath: result.resultPath,
	};
}

export function parseInitArgs(
	args: readonly string[],
): Partial<InitAutoresearchOptions> {
	const result: Partial<InitAutoresearchOptions> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = args[i + 1];
		if (arg === "--topic" && next) {
			result.topic = next;
			i++;
		} else if (arg === "--evaluator" && next) {
			result.evaluatorCommand = next;
			i++;
		} else if (arg === "--keep-policy" && next) {
			const normalized = next.trim().toLowerCase();
			if (normalized !== "pass_only" && normalized !== "score_improvement") {
				throw new Error(
					"--keep-policy must be one of: score_improvement, pass_only",
				);
			}
			result.keepPolicy = normalized;
			i++;
		} else if (arg === "--slug" && next) {
			result.slug = slugifyMissionName(next);
			i++;
		} else if (arg.startsWith("--topic=")) {
			result.topic = arg.slice("--topic=".length);
		} else if (arg.startsWith("--evaluator=")) {
			result.evaluatorCommand = arg.slice("--evaluator=".length);
		} else if (arg.startsWith("--keep-policy=")) {
			const normalized = arg
				.slice("--keep-policy=".length)
				.trim()
				.toLowerCase();
			if (normalized !== "pass_only" && normalized !== "score_improvement") {
				throw new Error(
					"--keep-policy must be one of: score_improvement, pass_only",
				);
			}
			result.keepPolicy = normalized;
		} else if (arg.startsWith("--slug=")) {
			result.slug = slugifyMissionName(arg.slice("--slug=".length));
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown init flag: ${arg.split("=")[0]}`);
		}
	}
	return result;
}

export async function runAutoresearchNoviceBridge(
	repoRoot: string,
	seedInputs: AutoresearchSeedInputs = {},
	io: AutoresearchQuestionIO = createQuestionIO(),
	structuredQuestion?: AutoresearchStructuredQuestionAsker,
): Promise<InitAutoresearchResult> {
	if (!process.stdin.isTTY) {
		throw new Error(
			"Guided setup requires an interactive terminal. Use `--topic/--evaluator/--keep-policy/--slug` to seed deep-interview intake before launching `$autoresearch`.",
		);
	}

	let topic = seedInputs.topic?.trim() || "";
	let evaluatorCommand = seedInputs.evaluatorCommand?.trim() || "";
	let keepPolicy: AutoresearchKeepPolicy =
		seedInputs.keepPolicy || "score_improvement";
	let slug = seedInputs.slug?.trim() || "";
	let activeStructuredQuestion = structuredQuestion;
	let warnedAboutStructuredQuestionFallback = false;

	const withStructuredQuestionFallback = async <T>(
		operation: (question?: AutoresearchStructuredQuestionAsker) => Promise<T>,
	): Promise<T> => {
		if (!activeStructuredQuestion) return operation();
		try {
			return await operation(activeStructuredQuestion);
		} catch (error) {
			if (!shouldFallbackFromStructuredQuestion(error)) throw error;
			activeStructuredQuestion = undefined;
			if (!warnedAboutStructuredQuestionFallback) {
				warnedAboutStructuredQuestionFallback = true;
				console.warn(
					`[omx] warning: structured question UI unavailable (${error instanceof Error ? error.message : String(error)}). Falling back to plain terminal prompts.`,
				);
			}
			return operation();
		}
	};

	try {
		while (true) {
			topic = await withStructuredQuestionFallback((question) =>
				promptWithDefault(io, "Research topic/goal", topic, question),
			);
			if (!topic) {
				throw new Error("Research topic is required.");
			}

			const evaluatorIntent = await withStructuredQuestionFallback((question) =>
				promptWithDefault(
					io,
					"\nHow should OMX judge success? Describe it in plain language",
					topic,
					question,
				),
			);
			evaluatorCommand = await withStructuredQuestionFallback((question) =>
				promptWithDefault(
					io,
					"\nEvaluator command (leave placeholder to refine further; must output {pass:boolean, score?:number} JSON before launch)",
					evaluatorCommand ||
						`TODO replace with evaluator command for: ${evaluatorIntent}`,
					question,
				),
			);

			const keepPolicyInput = await withStructuredQuestionFallback((question) =>
				promptWithDefault(
					io,
					"\nKeep policy [score_improvement/pass_only]",
					keepPolicy,
					question,
				),
			);
			keepPolicy =
				keepPolicyInput.trim().toLowerCase() === "pass_only"
					? "pass_only"
					: "score_improvement";

			slug = await withStructuredQuestionFallback((question) =>
				promptWithDefault(
					io,
					"\nMission slug",
					slug || slugifyMissionName(topic),
					question,
				),
			);
			slug = slugifyMissionName(slug);

			const deepInterview = await writeAutoresearchDeepInterviewArtifacts({
				repoRoot,
				topic,
				evaluatorCommand,
				keepPolicy,
				slug,
				seedInputs,
			});

			console.log(`\nDraft saved: ${deepInterview.draftArtifactPath}`);
			console.log(
				`Launch readiness: ${deepInterview.launchReady ? "ready" : deepInterview.blockedReasons.join(" ")}`,
			);

			const action = await withStructuredQuestionFallback((question) =>
				promptAction(io, deepInterview.launchReady, question),
			);
			if (action === "refine") continue;
			return materializeAutoresearchDeepInterviewResult(deepInterview);
		}
	} finally {
		io.close();
	}
}

export async function guidedAutoresearchSetup(
	repoRoot: string,
): Promise<InitAutoresearchResult> {
	await ensureStructuredQuestionFallbackAllowed(repoRoot);
	return runAutoresearchNoviceBridge(
		repoRoot,
		{},
		createQuestionIO(),
		createStructuredQuestionAsker(repoRoot),
	);
}
