import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK_LEASE_INSTRUCTIONS, TASK_LEASE_SHELL_FUNCTION } from '../task-lease.js';

async function runWrapper(mode: string, work: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-lease-shell-'));
  try {
    await writeFile(join(cwd, 'omx'), `#!/bin/sh
n=0; [ ! -f "$LEASE_TEST_DIR/count" ] || n=$(cat "$LEASE_TEST_DIR/count")
n=$((n+1)); echo "$n" > "$LEASE_TEST_DIR/count"
if [ "$n" -gt 1 ] || [ "$LEASE_TEST_MODE" = initial-rejection ]; then
  case "$LEASE_TEST_MODE" in
    inflight) trap '' TERM; echo $$ > "$LEASE_TEST_DIR/api-pid"; touch "$LEASE_TEST_DIR/inflight"; exec /bin/sleep 6 ;;
    catch-term|ignore-term) while [ ! -f "$LEASE_TEST_DIR/ready" ]; do /bin/sleep 0.01; done; echo '{"ok":true,"data":{"ok":false}}'; exit 0 ;;
    rejection|initial-rejection) echo '{"ok":true,"data":{"ok":false}}'; exit 0 ;;
    outer) echo '{"ok":false,"data":{"ok":true}}'; exit 0 ;;
    crash) exit 2 ;;
    malformed) echo nope; exit 0 ;;
  esac
fi
echo '{"ok":true,"data":{"ok":true}}'
`);
    await chmod(join(cwd, 'omx'), 0o755);
    await writeFile(join(cwd, 'sleep'), '#!/bin/sh\necho $$ >> "$LEASE_TEST_DIR/sleep-pids"\nexec /bin/sleep "$@"\n');
    await chmod(join(cwd, 'sleep'), 0o755);
    const wrapper = TASK_LEASE_SHELL_FUNCTION.replace('sleep 300', 'sleep 0.05')
      .replace('with_task_lease() (', 'with_task_lease() (\n  echo lease-wrapper-pid:$BASHPID')
      .replace('renew_check_pid=$!', 'renew_check_pid=$!; echo "$renew_check_pid" >> "$LEASE_TEST_DIR/check-pids"')
      .replace('wait "$work_pid";', 'echo lease-child-pid:$lease_pid; wait "$work_pid";');
    const script = `set -e\n${wrapper}\nwith_task_lease '{}' node -e '${work.replaceAll("'", "'\\''")}'\n`;
    const child = spawn('bash', ['-c', script], { cwd, env: {
      ...process.env, PATH: `${cwd}:${process.env.PATH}`, LEASE_TEST_DIR: cwd, LEASE_TEST_MODE: mode,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let signaled = false;
    child.stdout.on('data', (data) => {
      output += data;
      const wrapperPid = /lease-wrapper-pid:(\d+)/.exec(output);
      if (mode === 'signal' && !signaled && wrapperPid && /work-pid:/.test(output)) {
        signaled = true;
        process.kill(Number(wrapperPid[1]), 'SIGTERM');
      }
    });
    child.stderr.on('data', (data) => { output += data; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    clearTimeout(timeout);
    const count = Number(await readFile(join(cwd, 'count'), 'utf8'));
    const match = /work-pid:(\d+)/.exec(output);
    if (match) assert.throws(() => process.kill(Number(match[1]), 0), /ESRCH/, 'wrapper must not leave its work child alive');
    const leasePid = /lease-child-pid:(\d+)/.exec(output);
    if (leasePid) assert.throws(() => process.kill(Number(leasePid[1]), 0), /ESRCH/, 'wrapper must reap its renewal shell');
    for (const file of ['api-pid', 'check-pids']) {
      const pids = await readFile(join(cwd, file), 'utf8').catch(() => '');
      for (const pid of pids.trim().split('\n').filter(Boolean)) {
        assert.throws(() => process.kill(Number(pid), 0), /ESRCH/, 'wrapper must reap its renewal pipeline children');
      }
    }
    const sleepPids = await readFile(join(cwd, 'sleep-pids'), 'utf8').catch(() => '');
    for (const pid of sleepPids.trim().split('\n').filter(Boolean)) {
      assert.throws(() => process.kill(Number(pid), 0), /ESRCH/, 'wrapper must not leave sleeping renewer children alive');
    }
    return { code, count, output };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const work = 'console.log("work-pid:"+process.pid);setTimeout(()=>console.log("finished"),450)';
describe('generated task lease Bash wrapper', () => {
  it('accepts fresh claims and validated leader handoffs without requiring another claim', () => {
    assert.match(TASK_LEASE_INSTRUCTIONS, /freshly claimed token.*current claim token from a leader handoff/);
    assert.match(TASK_LEASE_INSTRUCTIONS, /validate the task file owner, claim token, version, and unexpired lease/);
    assert.match(TASK_LEASE_INSTRUCTIONS, /do not claim again just to renew a valid handoff/);
    assert.doesNotMatch(TASK_LEASE_INSTRUCTIONS, /After claiming|returned claimToken/);
  });

  it('renews before and during work, then cleans up its sleeping renewer', async () => {
    const result = await runWrapper('success', `
console.log('work-pid:' + process.pid);
const fs = require('node:fs');
const timer = setInterval(() => {
  if (Number(fs.readFileSync(process.env.LEASE_TEST_DIR + '/count', 'utf8')) < 2) return;
  clearInterval(timer);
  console.log('finished');
}, 10);
setTimeout(() => process.exit(2), 5000).unref();
`);
    assert.equal(result.code, 0, result.output);
    assert.ok(result.count >= 2);
    assert.match(result.output, /finished/);
  });
  for (const mode of ['rejection', 'outer', 'crash', 'malformed']) {
    it(`fails closed and stops its work child on ${mode}`, async () => {
      const result = await runWrapper(mode, work);
      assert.notEqual(result.code, 0, result.output);
      assert.equal(result.count, 2);
      assert.doesNotMatch(result.output, /finished/);
    });
  }
  it('propagates renewal failure even when work catches TERM and exits successfully', async () => {
    const result = await runWrapper('catch-term', 'console.log("work-pid:"+process.pid);process.on("SIGTERM",()=>{console.log("caught-term");process.exit(0)});require("node:fs").writeFileSync(process.env.LEASE_TEST_DIR+"/ready","");setTimeout(()=>console.log("finished"),450)');
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /caught-term/);
    assert.doesNotMatch(result.output, /finished/);
  });
  it('kills and reaps a direct child that ignores TERM within a bounded grace period', async () => {
    const started = Date.now();
    const result = await runWrapper('ignore-term', 'console.log("work-pid:"+process.pid);process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.env.LEASE_TEST_DIR+"/ready","");setInterval(()=>{},100)');
    assert.notEqual(result.code, 0, result.output);
    assert.ok(Date.now() - started < 5000, result.output);
  });
  it('does not start work when the initial renewal is rejected', async () => {
    const result = await runWrapper('initial-rejection', work);
    assert.notEqual(result.code, 0);
    assert.equal(result.count, 1);
    assert.doesNotMatch(result.output, /work-pid/);
  });
  it('cleans up only its owned direct children on termination', async () => {
    const result = await runWrapper('signal', work);
    assert.equal(result.code, 143, result.output);
    assert.doesNotMatch(result.output, /finished/);
  });
  for (const status of [0, 7]) {
    it(`returns work status ${status} within the cleanup bound when renewal API is in flight`, async () => {
      const started = Date.now();
      const result = await runWrapper('inflight', `console.log("work-pid:"+process.pid);const timer=setInterval(()=>{if(require("node:fs").existsSync(process.env.LEASE_TEST_DIR+"/inflight")){clearInterval(timer);console.log("finished");process.exit(${status})}},10)`);
      assert.equal(result.code, status, result.output);
      assert.equal(result.count, 2);
      assert.match(result.output, /finished/);
      assert.ok(Date.now() - started < 4000, result.output);
    });
  }
  it('propagates command failure', async () => {
    assert.equal((await runWrapper('success', 'process.exit(7)')).code, 7);
  });
});
