#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

async function read(path: string): Promise<string> { return await readFile(path, 'utf-8'); }

function replaceBetween(text: string, startMarker: string, endMarker: string, replacement: string): string {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) throw new Error(`Markers not found: ${startMarker} .. ${endMarker}`);
  return text.slice(0, start + startMarker.length) + '\n' + replacement.trimEnd() + '\n' + text.slice(end);
}

async function main(): Promise<void> {
  const op = (await read('docs/prompt-guidance-fragments/core-operating-principles.md')).trim();
  const vs = (await read('docs/prompt-guidance-fragments/core-verification-and-sequencing.md')).trim();
  const exC = (await read('docs/prompt-guidance-fragments/executor-constraints.md')).trim();
  const exO = (await read('docs/prompt-guidance-fragments/executor-output.md')).trim();
  const plC = (await read('docs/prompt-guidance-fragments/planner-constraints.md')).trim();
  const plI = (await read('docs/prompt-guidance-fragments/planner-investigation.md')).trim();
  const plO = (await read('docs/prompt-guidance-fragments/planner-output.md')).trim();
  const vfC = (await read('docs/prompt-guidance-fragments/verifier-constraints.md')).trim();
  const vfI = (await read('docs/prompt-guidance-fragments/verifier-investigation.md')).trim();

  for (const file of ['AGENTS.md', 'templates/AGENTS.md']) {
    let text = await read(file);
    text = replaceBetween(text, '<!-- OMX:GUIDANCE:OPERATING:START -->', '<!-- OMX:GUIDANCE:OPERATING:END -->', op);
    text = replaceBetween(text, '<!-- OMX:GUIDANCE:VERIFYSEQ:START -->', '<!-- OMX:GUIDANCE:VERIFYSEQ:END -->', vs);
    await writeFile(file, text);
  }

  let text = await read('skills/executor/SKILL.md');
  text = replaceBetween(text, '<!-- OMX:GUIDANCE:EXECUTOR:CONSTRAINTS:START -->', '<!-- OMX:GUIDANCE:EXECUTOR:CONSTRAINTS:END -->', exC);
  text = replaceBetween(text, '<!-- OMX:GUIDANCE:EXECUTOR:OUTPUT:START -->', '<!-- OMX:GUIDANCE:EXECUTOR:OUTPUT:END -->', exO);
  await writeFile('skills/executor/SKILL.md', text);

  text = await read('skills/planner/SKILL.md');
  text = replaceBetween(text, '<!-- OMX:GUIDANCE:PLANNER:CONSTRAINTS:START -->', '<!-- OMX:GUIDANCE:PLANNER:CONSTRAINTS:END -->', plC);
  text = replaceBetween(text, '<!-- OMX:GUIDANCE:PLANNER:INVESTIGATION:START -->', '<!-- OMX:GUIDANCE:PLANNER:INVESTIGATION:END -->', plI);
  text = replaceBetween(text, '<!-- OMX:GUIDANCE:PLANNER:OUTPUT:START -->', '<!-- OMX:GUIDANCE:PLANNER:OUTPUT:END -->', plO);
  await writeFile('skills/planner/SKILL.md', text);

  text = await read('skills/verifier/SKILL.md');
  text = replaceBetween(text, '<!-- OMX:GUIDANCE:VERIFIER:CONSTRAINTS:START -->', '<!-- OMX:GUIDANCE:VERIFIER:CONSTRAINTS:END -->', vfC);
  text = replaceBetween(text, '<!-- OMX:GUIDANCE:VERIFIER:INVESTIGATION:START -->', '<!-- OMX:GUIDANCE:VERIFIER:INVESTIGATION:END -->', vfI);
  await writeFile('skills/verifier/SKILL.md', text);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
