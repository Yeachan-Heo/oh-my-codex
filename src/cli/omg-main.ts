import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOAL_HARNESS_HELP, goalHarnessCommand } from './goal-harness.js';

export const OMG_HELP = `omg - Oh My Goal, a Codex goal-native autonomy harness

Usage:
  omg refine [--objective <text> | --objective-file <path>] [--json]
  omg interview [--slug <slug> | --objective <text> | --objective-file <path>] [--json]
  omg plan [--slug <slug> | --objective <text> | --objective-file <path>] [--json]
  omg create [--objective <text> | --objective-file <path>] [--slug <slug>] [--force] [--json]
  omg start --slug <slug> [--json]
  omg status --slug <slug> [--json]
  omg sync-goal --slug <slug> --codex-goal-json <json-or-path> [--evidence <text>] [--json]
  omg summary --slug <slug> [--json]
  omg next --slug <slug> [--json]
  omg record-trajectory --slug <slug> --summary <text> --evidence <text> [--source <leader|worker>] [--role <role>] [--score <0-100>] [--novelty-score <0-100>] [--status <candidate|accepted|rejected|blocked>] [--id <id>] [--json]
  omg select --slug <slug> --trajectory-id <id> --evidence <text> [--json]
  omg step --slug <slug> --outcome <progress|blocked|ready-for-late-gate|needs-team-pressure> --evidence <text> [--action <text>] [--next-action <text>] [--json]
  omg perturb --slug <slug> [--blocker <text>] [--json]
  omg team-plan --slug <slug> [--task <text>] [--json]
  omg team-packet --slug <slug> [--plan-id <id>] [--json]
  omg import-worker-result --slug <slug> --result <path> [--id <id>] [--status <candidate|accepted|rejected|blocked>] [--json]
  omg challenge [--objective <text>] [--phase <early|middle|late|stuck>] [--json]
  omg worker-instruction --role <researcher|implementer|tester|critic|architect|replanner> --task <text> [--context <text>] [--json]
  omg gate [--slug <slug>] --evidence-json <json-or-path> [--json]
  omg complete --slug <slug> --codex-goal-json <json-or-path> [--evidence <text>] [--json]
  omg version

npx:
  npx -p oh-my-codex omg --help
  npx -p oh-my-codex omg refine --objective "Ship this safely"

Boundary:
  OMG is a sibling product surface to omx for the goal-native harness. It keeps
  one Codex goal as the top-level objective; workers never call create_goal or
  update_goal. The equivalent OMX surface is: omx goal-harness <command>.
`;

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(here, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
  return pkg.version ?? 'unknown';
}

function translateHelp(command: string): string {
  return command === 'help' || command === '--help' || command === '-h'
    ? 'help'
    : command;
}

export async function main(args: string[]): Promise<void> {
  const command = translateHelp(args[0] ?? 'help');
  if (command === 'help') {
    console.log(OMG_HELP);
    return;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(packageVersion());
    return;
  }
  if (command === 'omx-help') {
    console.log(GOAL_HARNESS_HELP);
    return;
  }

  await goalHarnessCommand(args);
}
