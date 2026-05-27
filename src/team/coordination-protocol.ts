import { posix as pathPosix } from "path";
import type {
	TeamTask,
	TeamTaskCoordinationMechanism,
	TeamTaskCoordinationPlan,
} from "./state.js";

export const DEFAULT_COORDINATION_MECHANISMS: TeamTaskCoordinationMechanism[] =
	[
		"shared_mental_model",
		"closed_loop_communication",
		"mutual_performance_monitoring",
		"backup_behavior",
		"adaptability_checkpoint",
		"team_orientation",
	];

const INTERDEPENDENCE_PATTERNS = [
	/\b(interdepend(?:ent|ence)|cross[-\s]?boundary|cross[-\s]?functional|shared\s+(file|surface|module|contract|state)|common\s+(file|surface|module|contract|state))\b/i,
	/\b(hand[-\s]?off|handoff|interface|integration|merge|conflict|coordination|coordinate|dependency|depends\s+on|blocked\s+by)\b/i,
	/\b(end[-\s]?to[-\s]?end|e2e|workflow|pipeline|system[-\s]?wide|repo[-\s]?wide|multi[-\s]?(file|module|agent|lane|worker))\b/i,
	/\b(adapt(?:ability|ive|ation)|reassign|backup|fallback|boundary|contract|single source of truth|source of truth)\b/i,
];

const LIGHTWEIGHT_FANOUT_PATTERNS = [
	/\b(independent|embarrassingly parallel|fan[-\s]?out|separate lanes|isolated|read[-\s]?only sweep)\b/i,
	/\b(each worker|per[-\s]?(file|module|doc|package)|one file each|no shared files|no dependencies)\b/i,
	/\bno[-\s]*shared[-\s]*files?\b/i,
	/\bno[-\s]*dependenc(?:y|ies)\b/i,
];

const SIMPLE_TASK_PATTERNS = [
	/\b(typo|copy edit|single[-\s]?file|one[-\s]?(line|word|sentence|file)|formatting)\b/i,
];

export type TeamCoordinationTaskInput = Pick<
	TeamTask,
	| "subject"
	| "description"
	| "role"
	| "depends_on"
	| "blocked_by"
	| "filePaths"
	| "domains"
> & {
	symbolic_depends_on?: string[];
};

function taskText(
	task: Pick<TeamTask, "subject" | "description" | "role">,
): string {
	return [task.subject, task.description, task.role].filter(Boolean).join("\n");
}

function hasDependencies(
	task: Pick<TeamTask, "depends_on" | "blocked_by"> & {
		symbolic_depends_on?: string[];
	},
): boolean {
	return (
		(task.depends_on?.length ?? 0) > 0 ||
		(task.blocked_by?.length ?? 0) > 0 ||
		(task.symbolic_depends_on?.length ?? 0) > 0
	);
}

function explicitLightweightFanout(text: string): boolean {
	return LIGHTWEIGHT_FANOUT_PATTERNS.some((pattern) => pattern.test(text));
}

function isSimpleTask(text: string): boolean {
	return SIMPLE_TASK_PATTERNS.some((pattern) => pattern.test(text));
}

function hasInterdependenceSignal(text: string): boolean {
	return INTERDEPENDENCE_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizedFileScope(value: string): string {
	const normalized = pathPosix.normalize(value.trim().replace(/\\/g, "/"));
	return normalized === "." ? "" : normalized.replace(/^(\.\/)+/, "");
}

function normalizedScopeValue(
	value: string,
	field: "filePaths" | "domains",
): string {
	return field === "filePaths"
		? normalizedFileScope(value)
		: value.trim().toLowerCase();
}

function normalizedValues(
	values: string[] | undefined,
	field: "filePaths" | "domains",
): string[] {
	return [
		...new Set(
			(values ?? [])
				.map((value) => normalizedScopeValue(value, field))
				.filter(Boolean),
		),
	];
}

function addOverlapReasons(
	tasks: readonly TeamCoordinationTaskInput[],
	reasonsByIndex: Map<number, Set<string>>,
	field: "filePaths" | "domains",
	reason: string,
): void {
	const ownersByValue = new Map<string, number[]>();
	tasks.forEach((task, index) => {
		for (const value of normalizedValues(task[field], field)) {
			const owners = ownersByValue.get(value) ?? [];
			owners.push(index);
			ownersByValue.set(value, owners);
		}
	});

	for (const owners of ownersByValue.values()) {
		if (owners.length < 2) continue;
		for (const ownerIndex of owners) {
			const reasons = reasonsByIndex.get(ownerIndex) ?? new Set<string>();
			reasons.add(reason);
			reasonsByIndex.set(ownerIndex, reasons);
		}
	}
}

function coordinationPlanFromReasons(
	task: TeamCoordinationTaskInput,
	reasons: string[],
): TeamTaskCoordinationPlan {
	const text = taskText(task);
	const hasTaskDependencies = hasDependencies(task);
	const hasExplicitLightweightFanout = explicitLightweightFanout(text);
	const hasSimpleScope = isSimpleTask(text);
	const activationReasons = [...new Set(reasons)];
	const structuralCoordination =
		activationReasons.length > 0 || hasTaskDependencies;

	if (
		!structuralCoordination &&
		(hasExplicitLightweightFanout || hasSimpleScope)
	) {
		return {
			mode: "lightweight",
			activation_reasons: [
				hasExplicitLightweightFanout
					? "explicit_independent_fanout"
					: "simple_narrow_scope",
			],
			source: "synthesized",
		};
	}

	if (hasTaskDependencies) activationReasons.push("task_dependencies");
	if (hasInterdependenceSignal(text))
		activationReasons.push("cross_boundary_or_handoff_language");

	const uniqueReasons = [...new Set(activationReasons)];
	if (uniqueReasons.length === 0) {
		if (hasExplicitLightweightFanout)
			uniqueReasons.push("explicit_independent_fanout");
		else if (hasSimpleScope) uniqueReasons.push("simple_narrow_scope");
		else uniqueReasons.push("no_interdependence_signal");
		return {
			mode: "lightweight",
			activation_reasons: uniqueReasons,
			source: "synthesized",
		};
	}

	return {
		mode: "coordinated",
		activation_reasons: uniqueReasons,
		required_mechanisms: [...DEFAULT_COORDINATION_MECHANISMS],
		source: "synthesized",
	};
}

export function synthesizeCoordinationPlan(
	task: TeamCoordinationTaskInput,
): TeamTaskCoordinationPlan {
	return coordinationPlanFromReasons(task, []);
}

export function synthesizeCoordinationPlans(
	tasks: readonly TeamCoordinationTaskInput[],
): TeamTaskCoordinationPlan[] {
	const reasonsByIndex = new Map<number, Set<string>>();
	addOverlapReasons(tasks, reasonsByIndex, "filePaths", "shared_file_scope");
	addOverlapReasons(tasks, reasonsByIndex, "domains", "shared_domain_scope");

	return tasks.map((task, index) =>
		coordinationPlanFromReasons(task, [...(reasonsByIndex.get(index) ?? [])]),
	);
}

export function taskNeedsCoordinationProtocol(
	task: Pick<TeamTask, "coordination">,
): boolean {
	return task.coordination?.mode === "coordinated";
}

export function isTeamTaskCoordinationPlan(
	value: unknown,
): value is TeamTaskCoordinationPlan {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const plan = value as Record<string, unknown>;
	if (plan.mode !== "lightweight" && plan.mode !== "coordinated") return false;
	if (
		!Array.isArray(plan.activation_reasons) ||
		!plan.activation_reasons.every((reason) => typeof reason === "string")
	)
		return false;
	if (
		plan.required_mechanisms !== undefined &&
		(!Array.isArray(plan.required_mechanisms) ||
			!plan.required_mechanisms.every(isTeamTaskCoordinationMechanism))
	)
		return false;
	return true;
}

export function isTeamTaskCoordinationMechanism(
	value: unknown,
): value is TeamTaskCoordinationMechanism {
	return (
		typeof value === "string" &&
		(DEFAULT_COORDINATION_MECHANISMS as readonly string[]).includes(value)
	);
}

export function normalizeTeamTaskCoordinationPlanForRender(
	value: unknown,
): TeamTaskCoordinationPlan | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const plan = value as Record<string, unknown>;
	if (plan.mode !== "lightweight" && plan.mode !== "coordinated") return null;
	if (
		!Array.isArray(plan.activation_reasons) ||
		!plan.activation_reasons.every((reason) => typeof reason === "string")
	)
		return null;
	const validMechanisms = Array.isArray(plan.required_mechanisms)
		? plan.required_mechanisms.filter(isTeamTaskCoordinationMechanism)
		: undefined;
	const hasInvalidMechanism = Array.isArray(plan.required_mechanisms)
		? validMechanisms?.length !== plan.required_mechanisms.length
		: false;
	let required_mechanisms: TeamTaskCoordinationMechanism[] | undefined;
	if (hasInvalidMechanism && plan.mode === "coordinated") {
		required_mechanisms = [...DEFAULT_COORDINATION_MECHANISMS];
	} else if (validMechanisms && validMechanisms.length > 0) {
		required_mechanisms = validMechanisms;
	} else if (
		plan.required_mechanisms !== undefined &&
		plan.mode === "coordinated"
	) {
		required_mechanisms = [...DEFAULT_COORDINATION_MECHANISMS];
	}

	return {
		mode: plan.mode,
		activation_reasons: plan.activation_reasons,
		required_mechanisms,
		source:
			plan.source === "explicit" || plan.source === "synthesized"
				? plan.source
				: undefined,
	};
}

export function normalizeTeamTaskCoordinationPlanForStorage(
	value: unknown,
): TeamTaskCoordinationPlan | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const plan = value as Record<string, unknown>;
	if (plan.mode !== "lightweight" && plan.mode !== "coordinated")
		return undefined;
	if (
		!Array.isArray(plan.activation_reasons) ||
		!plan.activation_reasons.every((reason) => typeof reason === "string")
	) {
		return undefined;
	}
	const activation_reasons = [
		...new Set(
			plan.activation_reasons.map((reason) => reason.trim()).filter(Boolean),
		),
	];
	if (activation_reasons.length === 0) return undefined;
	const source =
		plan.source === "explicit" || plan.source === "synthesized"
			? plan.source
			: undefined;

	if (plan.mode === "lightweight") {
		return {
			mode: "lightweight",
			activation_reasons,
			...(source ? { source } : {}),
		};
	}

	const required_mechanisms = Array.isArray(plan.required_mechanisms)
		? [
				...new Set(
					plan.required_mechanisms.filter(isTeamTaskCoordinationMechanism),
				),
			]
		: undefined;
	const hasInvalidMechanism = Array.isArray(plan.required_mechanisms)
		? (required_mechanisms?.length ?? 0) !== plan.required_mechanisms.length
		: false;
	const normalizedRequiredMechanisms =
		!hasInvalidMechanism && required_mechanisms && required_mechanisms.length > 0
			? required_mechanisms
			: [...DEFAULT_COORDINATION_MECHANISMS];

	return {
		mode: "coordinated",
		activation_reasons,
		required_mechanisms: normalizedRequiredMechanisms,
		...(source ? { source } : {}),
	};
}

function normalizedList(values: readonly string[] | undefined): string[] {
	return [...new Set(values ?? [])].sort();
}

export function coordinationPlansEqual(
	left: TeamTaskCoordinationPlan | undefined,
	right: TeamTaskCoordinationPlan,
): boolean {
	if (!isTeamTaskCoordinationPlan(left)) return false;
	if (left.mode !== right.mode) return false;
	if (
		normalizedList(left.activation_reasons).join("\0") !==
		normalizedList(right.activation_reasons).join("\0")
	)
		return false;
	return (
		normalizedList(left.required_mechanisms).join("\0") ===
		normalizedList(right.required_mechanisms).join("\0")
	);
}
