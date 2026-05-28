import { listNotifyCanonicalActiveTeams, type NotifyCanonicalActiveTeam } from '../scripts/notify-hook/active-team.js';
import { readCurrentSessionId } from '../mcp/state-paths.js';
import { listActiveSkills, readVisibleSkillActiveState } from '../state/skill-active.js';
import { readActiveWorkflowModes } from '../state/workflow-transition.js';
import {
  AUTOPILOT_DEEP_INTERVIEW_QUESTION_OWNER_ENV,
  canStartAutopilotDeepInterviewQuestion,
} from './autopilot-wait.js';

const BLOCKED_EXECUTION_SKILLS = new Set([
  'autopilot',
  'autoresearch',
  'team',
  'ralph',
  'ultrawork',
  'ultraqa',
]);

export interface QuestionPolicyDecision {
  allowed: boolean;
  sessionId?: string;
  code?: 'worker_blocked' | 'team_blocked' | 'active_execution_mode_blocked';
  message?: string;
  fallbackAllowed?: boolean;
  activeModes: string[];
  activeSkills: string[];
  activeTeams: NotifyCanonicalActiveTeam[];
}

export interface EvaluateQuestionPolicyOptions {
  cwd: string;
  explicitSessionId?: string;
  env?: NodeJS.ProcessEnv;
  questionSource?: string;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function hasWorkerContext(env: NodeJS.ProcessEnv): boolean {
  return safeString(env.OMX_TEAM_WORKER).trim() !== '';
}

function onlyControlledAutopilotQuestionBlock(blocked: string[]): boolean {
  return blocked.length > 0 && blocked.every((entry) => entry === 'autopilot');
}

export async function evaluateQuestionPolicy(
  options: EvaluateQuestionPolicyOptions,
): Promise<QuestionPolicyDecision> {
  const env = options.env ?? process.env;
  const sessionId = options.explicitSessionId || await readCurrentSessionId(options.cwd);

  if (hasWorkerContext(env)) {
    return {
      allowed: false,
      sessionId,
      code: 'worker_blocked',
      message: 'omx question is unavailable for OMX team workers; only non-team leader sessions may ask user questions.',
      fallbackAllowed: false,
      activeModes: [],
      activeSkills: [],
      activeTeams: [],
    };
  }

  const [activeModes, skillState, activeTeams] = await Promise.all([
    readActiveWorkflowModes(options.cwd, sessionId),
    readVisibleSkillActiveState(options.cwd, sessionId),
    sessionId ? listNotifyCanonicalActiveTeams(options.cwd, sessionId) : Promise.resolve([]),
  ]);

  const activeSkills = listActiveSkills(skillState ?? {}).map((entry) => entry.skill);

  if (activeTeams.length > 0) {
    const summary = activeTeams.map((team) => `${team.teamName} (${team.phase})`).join(', ');
    return {
      allowed: false,
      sessionId,
      code: 'team_blocked',
      message: `omx question is unavailable while this session owns active team mode: ${summary}.`,
      fallbackAllowed: false,
      activeModes,
      activeSkills,
      activeTeams,
    };
  }

  const blockedModes = activeModes.filter((mode) => BLOCKED_EXECUTION_SKILLS.has(mode));
  const blockedSkills = activeSkills.filter((skill) => BLOCKED_EXECUTION_SKILLS.has(skill));
  const blocked = [...new Set([...blockedModes, ...blockedSkills])];

  if (blocked.length > 0) {
    const source = safeString(options.questionSource).trim();
    if (source === 'deep-interview' && onlyControlledAutopilotQuestionBlock(blocked)) {
      const canStartAutopilotQuestion = await canStartAutopilotDeepInterviewQuestion(
        options.cwd,
        sessionId,
        { ownerObligationId: env[AUTOPILOT_DEEP_INTERVIEW_QUESTION_OWNER_ENV] },
      );
      if (canStartAutopilotQuestion) {
        return {
          allowed: true,
          fallbackAllowed: true,
          sessionId,
          activeModes,
          activeSkills,
          activeTeams,
        };
      }
    }

    return {
      allowed: false,
      sessionId,
      code: 'active_execution_mode_blocked',
      message: `omx question is unavailable while auto-executing workflows are active: ${blocked.join(', ')}.`,
      fallbackAllowed: false,
      activeModes,
      activeSkills,
      activeTeams,
    };
  }

  return {
    allowed: true,
    fallbackAllowed: true,
    sessionId,
    activeModes,
    activeSkills,
    activeTeams,
  };
}
