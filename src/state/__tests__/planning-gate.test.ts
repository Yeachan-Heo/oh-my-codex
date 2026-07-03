import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluatePreToolUseGate,
  isImplementationToolCall,
  isPlanningGateBypassActive,
  containsBypassPlanningGatePhrase,
  computeBypassExpiry,
  buildPlanningGateLogEvent,
  PLANNING_GATE_BYPASS_TTL_MS,
  BYPASS_PLANNING_GATE_PHRASE,
  type PlanningGateState,
  type PreToolUseGateInput,
} from '../workflow-transition.js';
import {
  DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS,
  DEEP_INTERVIEW_INPUT_LOCK_MESSAGE,
} from '../../hooks/keyword-detector.js';
import { evaluateWorkflowTransition } from '../workflow-transition.js';

describe('planning gate: tool classification', () => {
  it('classifies Edit, Write, NotebookEdit as implementation tools', () => {
    assert.equal(isImplementationToolCall({ tool_name: 'Edit' }), true);
    assert.equal(isImplementationToolCall({ tool_name: 'Write' }), true);
    assert.equal(isImplementationToolCall({ tool_name: 'NotebookEdit' }), true);
  });

  it('classifies Bash with git push / gh pr create / gh pr merge as implementation tools', () => {
    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: 'git push origin main' }), true);
    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: 'gh pr create --title "fix"' }), true);
    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: 'gh pr merge 42' }), true);
  });

  it('classifies same-command protected artifact write plus shell execution as implementation', () => {
    const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
#!/bin/sh
mkdir -p src
printf pwned > src/pwned.ts
SCRIPT
sh .omx/context/run.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan","state":{"deep_interview_gate":{"status":"complete","rationale":"done"}}}' --json`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies Python literal planning artifact write plus shell execution as implementation', () => {
    const command = `python3 - <<'PY'
from pathlib import Path
Path('.omx/plans/run.sh').write_text('echo pwned')
PY
sh .omx/plans/run.sh`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies Python literal tmp artifact write plus shell execution as implementation', () => {
    const command = `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/run.sh').write_text('echo pwned')
PY
sh .omx/tmp/sess/run.sh`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies Python literal tmp artifact write plus tsx execution as implementation', () => {
    const command = `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/run.ts').write_text('console.log(1)')
PY
tsx .omx/tmp/sess/run.ts`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies same-command tmp source runner and preload transports as implementation', () => {
    const commands = [
      `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/run.ts').write_text('console.log(1)')
PY
tsx --tsconfig tsconfig.json watch .omx/tmp/sess/run.ts`,
      `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/run.ts').write_text('console.log(1)')
PY
deno run .omx/tmp/sess/run.ts`,
      `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/run.txt').write_text('print(1)')
PY
python -X dev .omx/tmp/sess/run.txt`,
      `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/probe.go').write_text('package main')
PY
go run .omx/tmp/sess/probe.go`,
      `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/preload').write_text('')
PY
node --require .omx/tmp/sess/preload -e ''`,
      `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/rc').write_text('')
PY
bash --rcfile .omx/tmp/sess/rc -i -c true`,
    ];

    for (const command of commands) {
      assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true, command);
    }
  });

  it('classifies tmp stdin redirection into interpreters and shells as implementation', () => {
    const commands = [
      'python < .omx/tmp/s/run.txt',
      'node < .omx/tmp/s/run.txt',
      'ruby < .omx/tmp/s/run.txt',
      'perl < .omx/tmp/s/run.txt',
      'sh < .omx/tmp/s/run.txt',
      'bash < .omx/tmp/s/run.txt',
      '/usr/bin/python < .omx/tmp/s/run.txt',
      '/bin/sh < .omx/tmp/s/run.txt',
      'env /bin/bash < .omx/tmp/s/run.txt',
      'command /usr/bin/node < .omx/tmp/s/run.txt',
      `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/s/run.txt').write_text('print(1)')
PY
python < .omx/tmp/s/run.txt`,
    ];

    for (const command of commands) {
      assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true, command);
    }
  });

  it('does not classify Python literal tmp artifact write without execution as implementation', () => {
    const command = `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/notes.md').write_text('# Scratch notes\\n')
PY`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), false);
  });

  it('does not classify Python literal planning artifact write without execution as implementation', () => {
    const command = `python3 - <<'PY'
from pathlib import Path
Path('.omx/plans/notes.md').write_text('# Plan notes\\n')
PY`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), false);
  });

  it('classifies same-command protected artifact execution through cd plus timeout as implementation', () => {
    const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
echo pwned
SCRIPT
cd .omx/context && timeout 5 sh run.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies same-command protected artifact execution through cd shell wrappers and options as implementation', () => {
    const executionForms = [
      'command cd .omx/context && sh run.sh',
      'builtin cd .omx/context && sh run.sh',
      'cd -- .omx/context && sh run.sh',
      'cd -P .omx/context && sh run.sh',
      'cd -L .omx/context && sh run.sh',
    ];

    for (const executionForm of executionForms) {
      const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
echo pwned
SCRIPT
${executionForm}
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;

      assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true, executionForm);
    }
  });

  it('classifies grouped cwd same-command protected artifact executions as implementation', () => {
    const executionForms = [
      '(cd .omx/context && sh run.sh)',
      '{ cd .omx/context; sh run.sh; }',
      '(cd .omx/context; sh run.sh)',
    ];

    for (const executionForm of executionForms) {
      const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
echo pwned
SCRIPT
${executionForm}
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;

      assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true, executionForm);
    }
  });

  it('classifies same-command protected artifact execution through bash -lc as implementation', () => {
    const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
echo pwned
SCRIPT
bash -lc 'sh .omx/context/run.sh'
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies tee writes when the protected executable is a later output file', () => {
    const command = `mkdir -p .omx/context
printf 'echo pwned\n' | tee .omx/context/notes.md .omx/context/run.sh
sh .omx/context/run.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies same-command protected artifact execution through script interpreters as implementation', () => {
    const command = `mkdir -p .omx/context
cat > .omx/context/run.py <<'PY'
print('pwned')
PY
python3 .omx/context/run.py
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies shell script operands after shell options that consume the next word', () => {
    const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
echo pwned
SCRIPT
bash -o posix .omx/context/run.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies same-command protected artifact execution through attached env chdir as implementation', () => {
    const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
echo pwned
SCRIPT
env -C.omx/context sh run.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies same-command protected artifact execution through env -C as implementation', () => {
    const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
printf '%s\n' pwned > src/pwned.ts
SCRIPT
env -C .omx/context sh run.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan","state":{"deep_interview_gate":{"status":"complete","rationale":"done"}}}' --json`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies same-command protected artifact execution through env --chdir as implementation', () => {
    const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
printf '%s\n' pwned > src/pwned.ts
SCRIPT
env --chdir=.omx/context sh run.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan","state":{"deep_interview_gate":{"status":"complete","rationale":"done"}}}' --json`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies direct executable artifact paths through direct-exec wrappers as implementation', () => {
    for (const executionLine of [
      'command ./.omx/context/run.sh',
      'nohup ./.omx/context/run.sh',
      'time ./.omx/context/run.sh',
      'setsid ./.omx/context/run.sh',
    ]) {
      const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
printf '%s\n' pwned > src/pwned.ts
SCRIPT
${executionLine}
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan","state":{"deep_interview_gate":{"status":"complete","rationale":"done"}}}' --json`;

      assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true, executionLine);
    }
  });

  it('classifies same-command protected specs source through cwd-changing shell as implementation', () => {
    const command = `mkdir -p .omx/specs
printf 'export PWNED=1\n' > .omx/specs/env.sh
env --chdir=.omx/specs sh -c '. env.sh'
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('classifies same-command protected artifact write plus source as implementation', () => {
    const command = `mkdir -p .omx/specs
printf 'export PWNED=1\n' > .omx/specs/env.sh
source .omx/specs/env.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), true);
  });

  it('does not classify Read, Glob, Grep, or safe Bash as implementation tools', () => {
    assert.equal(isImplementationToolCall({ tool_name: 'Read' }), false);
    assert.equal(isImplementationToolCall({ tool_name: 'Glob' }), false);
    assert.equal(isImplementationToolCall({ tool_name: 'Grep' }), false);
    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: 'git status' }), false);
    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: 'npm test' }), false);
    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: 'ls -la' }), false);
  });

  it('does not classify protected artifact write plus ralplan handoff without execution as implementation', () => {
    const command = `mkdir -p .omx/context
cat > .omx/context/notes.md <<'EOF'
# Handoff notes
EOF
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;

    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: command }), false);
  });

  it('does not classify Bash without tool_input as implementation tool', () => {
    assert.equal(isImplementationToolCall({ tool_name: 'Bash' }), false);
  });
});

describe('planning gate: downstream_authority=plan_then_execute + no ralplan consensus artifact', () => {
  const gateState: PlanningGateState = {
    downstream_authority: 'plan_then_execute',
  };

  it('denies Edit when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Edit' }, gateState, false);
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
    assert.match(decision.reason!, /plan_then_execute/);
    assert.match(decision.reason!, /Edit denied/);
  });

  it('denies Write when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Write' }, gateState, false);
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
    assert.match(decision.reason!, /Write denied/);
  });

  it('denies Bash(git push) when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate(
      { tool_name: 'Bash', tool_input: 'git push origin fix/branch' },
      gateState,
      false,
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
    assert.match(decision.reason!, /Bash denied/);
  });

  it('denies Bash(gh pr create) when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate(
      { tool_name: 'Bash', tool_input: 'gh pr create --title "feature"' },
      gateState,
      false,
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
  });

  it('denies same-command protected artifact write plus execution when no ralplan consensus artifact exists', () => {
    const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
#!/bin/sh
mkdir -p src
printf pwned > src/pwned.ts
SCRIPT
sh .omx/context/run.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan","state":{"deep_interview_gate":{"status":"complete","rationale":"done"}}}' --json`;
    const decision = evaluatePreToolUseGate(
      { tool_name: 'Bash', tool_input: command },
      gateState,
      false,
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
    assert.match(decision.reason!, /Bash denied/);
  });

  it('denies same-command tmp TypeScript artifact execution through tsx when no ralplan consensus artifact exists', () => {
    const command = `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/run.ts').write_text('console.log(1)')
PY
tsx .omx/tmp/sess/run.ts`;
    const decision = evaluatePreToolUseGate(
      { tool_name: 'Bash', tool_input: command },
      gateState,
      false,
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
    assert.match(decision.reason!, /Bash denied/);
  });

  it('denies same-command tmp source runner and preload transports when no ralplan consensus artifact exists', () => {
    const commands = [
      `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/run.ts').write_text('console.log(1)')
PY
tsx --tsconfig tsconfig.json watch .omx/tmp/sess/run.ts`,
      `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/run.ts').write_text('console.log(1)')
PY
deno run .omx/tmp/sess/run.ts`,
      `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/run.txt').write_text('print(1)')
PY
python -X dev .omx/tmp/sess/run.txt`,
      `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/sess/probe.go').write_text('package main')
PY
go run .omx/tmp/sess/probe.go`,
    ];

    for (const command of commands) {
      const decision = evaluatePreToolUseGate(
        { tool_name: 'Bash', tool_input: command },
        gateState,
        false,
      );
      assert.equal(decision.allowed, false, command);
      assert.equal(decision.gate_fired, true, command);
      assert.match(decision.reason!, /Bash denied/);
    }
  });

  it('denies tmp stdin redirection into interpreters and shells when no ralplan consensus artifact exists', () => {
    const commands = [
      'python < .omx/tmp/s/run.txt',
      'node < .omx/tmp/s/run.txt',
      'ruby < .omx/tmp/s/run.txt',
      'perl < .omx/tmp/s/run.txt',
      'sh < .omx/tmp/s/run.txt',
      'bash < .omx/tmp/s/run.txt',
      `python3 - <<'PY'
from pathlib import Path
Path('.omx/tmp/s/run.txt').write_text('print(1)')
PY
python < .omx/tmp/s/run.txt`,
    ];

    for (const command of commands) {
      const decision = evaluatePreToolUseGate(
        { tool_name: 'Bash', tool_input: command },
        gateState,
        false,
      );
      assert.equal(decision.allowed, false, command);
      assert.equal(decision.gate_fired, true, command);
      assert.match(decision.reason!, /Bash denied/);
    }
  });

  it('denies review5 protected artifact write plus same-command execution probes', () => {
    const probes = [
      `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
echo pwned
SCRIPT
cd .omx/context && timeout 5 sh run.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`,
      `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
echo pwned
SCRIPT
bash -lc 'sh .omx/context/run.sh'
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`,
      `mkdir -p .omx/context
printf 'echo pwned\n' | tee .omx/context/notes.md .omx/context/run.sh
sh .omx/context/run.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`,
      `mkdir -p .omx/context
cat > .omx/context/run.py <<'PY'
print('pwned')
PY
python3 .omx/context/run.py
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`,
      `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
echo pwned
SCRIPT
bash -o posix .omx/context/run.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`,
      `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
echo pwned
SCRIPT
env -C.omx/context sh run.sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`,
    ];

    for (const command of probes) {
      const decision = evaluatePreToolUseGate(
        { tool_name: 'Bash', tool_input: command },
        gateState,
        false,
      );

      assert.equal(decision.allowed, false, command);
      assert.equal(decision.gate_fired, true, command);
      assert.match(decision.reason!, /Bash denied/);
    }
  });

  it('denies cd wrapper and option same-command protected artifact executions', () => {
    const probes = [
      'command cd .omx/context && sh run.sh',
      'builtin cd .omx/context && sh run.sh',
      'cd -- .omx/context && sh run.sh',
      'cd -P .omx/context && sh run.sh',
      'cd -L .omx/context && sh run.sh',
    ];

    for (const executionForm of probes) {
      const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
echo pwned
SCRIPT
${executionForm}
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;
      const decision = evaluatePreToolUseGate(
        { tool_name: 'Bash', tool_input: command },
        gateState,
        false,
      );

      assert.equal(decision.allowed, false, executionForm);
      assert.equal(decision.gate_fired, true, executionForm);
      assert.match(decision.reason!, /Bash denied/);
    }
  });

  it('denies grouped cwd same-command protected artifact executions', () => {
    const probes = [
      `(cd .omx/context && sh run.sh)`,
      `{ cd .omx/context; sh run.sh; }`,
      `(cd .omx/context; sh run.sh)`,
    ];

    for (const executionForm of probes) {
      const command = `mkdir -p .omx/context
cat > .omx/context/run.sh <<'SCRIPT'
echo pwned
SCRIPT
${executionForm}
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan"}' --json`;
      const decision = evaluatePreToolUseGate(
        { tool_name: 'Bash', tool_input: command },
        gateState,
        false,
      );

      assert.equal(decision.allowed, false, executionForm);
      assert.equal(decision.gate_fired, true, executionForm);
      assert.match(decision.reason!, /Bash denied/);
    }
  });

  it('allows Read when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Read' }, gateState, false);
    assert.equal(decision.allowed, true);
    assert.equal(decision.gate_fired, undefined);
  });

  it('allows Glob when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Glob' }, gateState, false);
    assert.equal(decision.allowed, true);
  });

  it('allows Grep when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Grep' }, gateState, false);
    assert.equal(decision.allowed, true);
  });

  it('allows safe Bash commands when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate(
      { tool_name: 'Bash', tool_input: 'npm test -- src/state/' },
      gateState,
      false,
    );
    assert.equal(decision.allowed, true);
  });
});

describe('planning gate: downstream_authority=plan_then_execute + fresh ralplan consensus artifact', () => {
  const gateState: PlanningGateState = {
    downstream_authority: 'plan_then_execute',
  };

  it('allows Edit when ralplan consensus artifact is present', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Edit' }, gateState, true);
    assert.equal(decision.allowed, true);
  });

  it('allows Write when ralplan consensus artifact is present', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Write' }, gateState, true);
    assert.equal(decision.allowed, true);
  });

  it('allows Bash(git push) when ralplan consensus artifact is present', () => {
    const decision = evaluatePreToolUseGate(
      { tool_name: 'Bash', tool_input: 'git push origin main' },
      gateState,
      true,
    );
    assert.equal(decision.allowed, true);
  });
});

describe('planning gate: bypass planning gate phrase + TTL', () => {
  it('detects bypass planning gate phrase case-insensitively', () => {
    assert.equal(containsBypassPlanningGatePhrase('please bypass planning gate for now'), true);
    assert.equal(containsBypassPlanningGatePhrase('BYPASS PLANNING GATE'), true);
    assert.equal(containsBypassPlanningGatePhrase('Bypass Planning Gate please'), true);
    assert.equal(containsBypassPlanningGatePhrase('just do it'), false);
  });

  it('allows implementation tools within TTL after bypass', () => {
    const now = new Date('2026-05-24T10:00:00.000Z');
    const gateState: PlanningGateState = {
      downstream_authority: 'plan_then_execute',
      bypass_planning_gate_until: new Date('2026-05-24T10:05:00.000Z').toISOString(),
    };

    const decision = evaluatePreToolUseGate({ tool_name: 'Edit' }, gateState, false, now);
    assert.equal(decision.allowed, true);
    assert.match(decision.reason!, /bypass_planning_gate active/);
  });

  it('denies implementation tools after TTL expires', () => {
    const now = new Date('2026-05-24T10:15:00.000Z');
    const gateState: PlanningGateState = {
      downstream_authority: 'plan_then_execute',
      bypass_planning_gate_until: new Date('2026-05-24T10:05:00.000Z').toISOString(),
    };

    const decision = evaluatePreToolUseGate({ tool_name: 'Edit' }, gateState, false, now);
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
  });

  it('computeBypassExpiry produces a TTL of 10 minutes', () => {
    const now = new Date('2026-05-24T10:00:00.000Z');
    const expiry = computeBypassExpiry(now);
    const expiryMs = Date.parse(expiry);
    assert.equal(expiryMs - now.getTime(), PLANNING_GATE_BYPASS_TTL_MS);
    assert.equal(PLANNING_GATE_BYPASS_TTL_MS, 10 * 60 * 1000);
  });

  it('isPlanningGateBypassActive returns false for empty or invalid bypass timestamps', () => {
    assert.equal(isPlanningGateBypassActive({ downstream_authority: 'plan_then_execute' }), false);
    assert.equal(
      isPlanningGateBypassActive({ downstream_authority: 'plan_then_execute', bypass_planning_gate_until: '' }),
      false,
    );
    assert.equal(
      isPlanningGateBypassActive({ downstream_authority: 'plan_then_execute', bypass_planning_gate_until: 'not-a-date' }),
      false,
    );
  });

  it('denies again after mode transition clears bypass (simulated by removing bypass field)', () => {
    const gateStateWithoutBypass: PlanningGateState = {
      downstream_authority: 'plan_then_execute',
    };

    const decision = evaluatePreToolUseGate(
      { tool_name: 'Edit' },
      gateStateWithoutBypass,
      false,
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
  });
});

describe('planning gate: execute_now downstream authority', () => {
  it('allows all tools when downstream_authority is execute_now', () => {
    const gateState: PlanningGateState = {
      downstream_authority: 'execute_now',
    };

    assert.equal(evaluatePreToolUseGate({ tool_name: 'Edit' }, gateState, false).allowed, true);
    assert.equal(evaluatePreToolUseGate({ tool_name: 'Write' }, gateState, false).allowed, true);
    assert.equal(
      evaluatePreToolUseGate({ tool_name: 'Bash', tool_input: 'git push' }, gateState, false).allowed,
      true,
    );
  });

  it('allows all tools when no gate state exists', () => {
    assert.equal(evaluatePreToolUseGate({ tool_name: 'Edit' }, null, false).allowed, true);
    assert.equal(evaluatePreToolUseGate({ tool_name: 'Write' }, undefined, false).allowed, true);
  });
});

describe('planning gate: telemetry log event', () => {
  it('builds a structured log event when gate fires', () => {
    const gateState: PlanningGateState = {
      downstream_authority: 'plan_then_execute',
    };
    const toolInput: PreToolUseGateInput = { tool_name: 'Edit' };
    const decision = evaluatePreToolUseGate(toolInput, gateState, false);
    const logEvent = buildPlanningGateLogEvent(decision, toolInput, gateState);

    assert.equal(logEvent.event, 'planning-gate-fired');
    assert.equal(logEvent.tool_name, 'Edit');
    assert.equal(logEvent.allowed, false);
    assert.equal(logEvent.downstream_authority, 'plan_then_execute');
    assert.equal(logEvent.bypass_active, false);
    assert.ok(logEvent.timestamp);
  });
});

describe('regression: explicit $ralplan top-level entry path is unaffected', () => {
  it('allows ralplan activation from empty state', () => {
    const decision = evaluateWorkflowTransition([], 'ralplan');
    assert.equal(decision.allowed, true);
    assert.equal(decision.kind, 'allow');
    assert.deepEqual(decision.resultingModes, ['ralplan']);
  });

  it('allows deep-interview -> ralplan auto-complete transition', () => {
    const decision = evaluateWorkflowTransition(['deep-interview'], 'ralplan');
    assert.equal(decision.allowed, true);
    assert.equal(decision.kind, 'auto-complete');
    assert.deepEqual(decision.autoCompleteModes, ['deep-interview']);
    assert.deepEqual(decision.resultingModes, ['ralplan']);
  });

  it('planning gate does not interfere with workflow transitions', () => {
    const gateState: PlanningGateState = {
      downstream_authority: 'plan_then_execute',
    };
    const readDecision = evaluatePreToolUseGate({ tool_name: 'Read' }, gateState, false);
    assert.equal(readDecision.allowed, true);

    const transitionDecision = evaluateWorkflowTransition([], 'ralplan');
    assert.equal(transitionDecision.allowed, true);
  });
});

describe('regression: existing DEEP_INTERVIEW_INPUT_LOCK_MESSAGE behavior unchanged', () => {
  it('DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS contains the expected blocked inputs', () => {
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('yes'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('y'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('proceed'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('continue'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('ok'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('sure'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('go ahead'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('next i should'));
  });

  it('DEEP_INTERVIEW_INPUT_LOCK_MESSAGE is the expected string', () => {
    assert.equal(
      DEEP_INTERVIEW_INPUT_LOCK_MESSAGE,
      'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.',
    );
  });

  it('planning gate is orthogonal to input lock — gate evaluates tool calls, not user inputs', () => {
    const gateState: PlanningGateState = {
      downstream_authority: 'plan_then_execute',
    };
    for (const blockedInput of DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS) {
      assert.equal(typeof blockedInput, 'string');
    }
    const decision = evaluatePreToolUseGate({ tool_name: 'Read' }, gateState, false);
    assert.equal(decision.allowed, true);
  });
});
