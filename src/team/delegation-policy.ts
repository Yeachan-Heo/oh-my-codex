import { getTeamChildModel } from '../config/models.js';
import type { TeamTask, TeamTaskDelegationPlan } from './state.js';

const BROAD_TASK_PATTERNS = [
  /\b(broad|large|cross[-\s]?cutting|end[-\s]?to[-\s]?end)\b/i,
  /\bdebug|root[-\s]?cause|flaky|failure|regression|bug\b/i,
  /\breview|audit|assess|validate\b/i,
  /\bsearch|map|trace|find references|repo[-\s]?wide\b/i,
  /\btest|coverage|verify|qa\b/i,
  /\brefactor|cleanup|deslop|simplif(?:y|ication)\b/i,
  /\bmigrat(?:e|ion)|upgrade|port\b/i,
  /\binvestigat(?:e|ion)|analy[sz]e|diagnos(?:e|is)\b/i,
];

const NARROW_TASK_PATTERNS = [
  /\btypo\b/i,
  /\bcopy\b/i,
  /\bsingle[-\s]?file\b/i,
  /\bone[-\s]?(line|word|sentence|file)\b/i,
  /\breadme\b.*\btypo\b/i,
];

const SIMPLE_SCOPE_PATTERNS = [
  /\bfix\b.*\btypo\b/i,
  /\bupdate\b.*\bcopy\b/i,
  /\brename\b.*\bsingle\b/i,
];

function taskText(task: Pick<TeamTask, 'subject' | 'description' | 'role'>): string {
  return [task.subject, task.description, task.role].filter(Boolean).join('\n');
}

function isNarrowTask(text: string): boolean {
  return NARROW_TASK_PATTERNS.some((pattern) => pattern.test(text))
    && (SIMPLE_SCOPE_PATTERNS.some((pattern) => pattern.test(text)) || !/\b(search|debug|investigate|refactor|migration|review|test)\b/i.test(text));
}

function isBroadTask(text: string): boolean {
  return BROAD_TASK_PATTERNS.some((pattern) => pattern.test(text));
}

function roleAwareSubtaskCandidates(task: Pick<TeamTask, 'subject' | 'description' | 'role'>): string[] {
  const text = taskText(task);
  const candidates: string[] = [];

  if (/\bdebug|root[-\s]?cause|flaky|failure|regression|bug|investigat/i.test(text)) {
    candidates.push('Debug/root-cause probe: trace likely failure paths and summarize evidence.');
  }
  if (/\bsearch|map|find references|repo[-\s]?wide|investigat/i.test(text)) {
    candidates.push('Repository map probe: find relevant files, symbols, and ownership boundaries.');
  }
  if (/\breview|audit|security|quality/i.test(text)) {
    candidates.push('Review probe: inspect risks, edge cases, and contract violations.');
  }
  if (/\btest|coverage|verify|qa/i.test(text)) {
    candidates.push('Test probe: identify existing coverage and missing regression checks.');
  }
  if (/\brefactor|cleanup|deslop|simplif|migrat|upgrade|port/i.test(text)) {
    candidates.push('Change-slice probe: isolate safe implementation slices and migration hazards.');
  }

  if (candidates.length === 0) {
    candidates.push('Context probe: map the relevant code paths and summarize recommended next steps.');
  }

  return candidates.slice(0, 4);
}

export function synthesizeDelegationPlan(task: Pick<TeamTask, 'subject' | 'description' | 'role'>): TeamTaskDelegationPlan {
  const text = taskText(task);

  if (isNarrowTask(text)) {
    return { mode: 'none' };
  }

  if (isBroadTask(text)) {
    return {
      mode: 'auto',
      max_parallel_subtasks: 3,
      required_parallel_probe: true,
      spawn_before_serial_search_threshold: 3,
      child_model_policy: 'standard',
      child_model: getTeamChildModel(),
      subtask_candidates: roleAwareSubtaskCandidates(task),
      child_report_format: 'bullets',
      skip_allowed_reason_required: true,
    };
  }

  return {
    mode: 'optional',
    max_parallel_subtasks: 2,
    child_model_policy: 'standard',
    child_model: getTeamChildModel(),
  };
}
