import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const fullTarget = mkdtempSync(join(tmpdir(), "portable-codex-starter-full-"));
const coreTarget = mkdtempSync(join(tmpdir(), "portable-codex-starter-core-"));
const codexSkillsTarget = mkdtempSync(join(tmpdir(), "portable-codex-starter-codex-skills-"));
const bothSkillsTarget = mkdtempSync(join(tmpdir(), "portable-codex-starter-both-skills-"));

try {
  exec("node", ["scripts/generate-agents.mjs"], root);
  exec("node", ["scripts/install.mjs", "--target", fullTarget, "--with-config"], root);
  exec("node", ["scripts/doctor.mjs", "--target", fullTarget], root);

  exec(
    "node",
    ["scripts/install.mjs", "--target", coreTarget, "--with-config", "--core-only"],
    root,
  );
  exec("node", ["scripts/doctor.mjs", "--target", coreTarget, "--core-only"], root);

  exec(
    "node",
    ["scripts/install.mjs", "--target", codexSkillsTarget, "--with-config", "--skills-root=.codex"],
    root,
  );
  exec(
    "node",
    ["scripts/doctor.mjs", "--target", codexSkillsTarget, "--skills-root=.codex"],
    root,
  );

  exec(
    "node",
    ["scripts/install.mjs", "--target", bothSkillsTarget, "--with-config", "--skills-root=both"],
    root,
  );
  exec(
    "node",
    ["scripts/doctor.mjs", "--target", bothSkillsTarget, "--skills-root=both"],
    root,
  );

  console.log(`\nVerification succeeded. Smoke targets:`);
  console.log(`- full: ${fullTarget}`);
  console.log(`- core-only: ${coreTarget}`);
  console.log(`- codex-skills: ${codexSkillsTarget}`);
  console.log(`- both-skills: ${bothSkillsTarget}`);
} finally {
  rmSync(fullTarget, { recursive: true, force: true });
  rmSync(coreTarget, { recursive: true, force: true });
  rmSync(codexSkillsTarget, { recursive: true, force: true });
  rmSync(bothSkillsTarget, { recursive: true, force: true });
}

function exec(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
  });
}
