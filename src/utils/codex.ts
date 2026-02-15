export function codexExecutable(): string {
  return process.platform === 'win32' ? 'codex.cmd' : 'codex';
}

