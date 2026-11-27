#!/usr/bin/env node
/**
 * Measure HUD authority performance directly.
 * Tests:
 * 1. Idle CPU during repeated ticks
 * 2. Number of child process spawns
 * 
 * Usage: node scripts/measure-authority.js [num-ticks] [branch]
 */

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runHudAuthorityTick } from '../dist/hud/authority.js';

const numTicks = parseInt(process.argv[2], 10) || 60;
const testDir = mkdtempSync(join(tmpdir(), 'omx-authority-measure-'));\n\ntry {\n  console.log(`Measuring HUD authority with ${numTicks} ticks`);\n  console.log(`Working directory: ${testDir}\\n`);\n  \n  // Warm up\n  console.log('Warming up...');\n  for (let i = 0; i < 3; i++) {\n    try {\n      await runHudAuthorityTick({ cwd: testDir });\n    } catch (e) {\n      // Ignore errors during warmup\n    }\n  }\n  \n  console.log('Measuring...');\n  const startTime = Date.now();\n  const startCpuUsage = process.cpuUsage();\n  let spawnErrors = 0;\n  let successfulTicks = 0;\n  \n  for (let i = 0; i < numTicks; i++) {\n    if ((i + 1) % 10 === 0) {\n      process.stdout.write(`${i + 1}.`);\n    }\n    \n    try {\n      await runHudAuthorityTick({ cwd: testDir });\n      successfulTicks++;\n    } catch (err) {\n      // Count spawn errors\n      if (err?.code === 'ENOENT' || err?.message?.includes('spawn')) {\n        spawnErrors++;\n      }\n    }\n  }\n  \n  console.log(' done\\n');\n  \n  const endTime = Date.now();\n  const endCpuUsage = process.cpuUsage(startCpuUsage);\n  \n  const elapsedMs = endTime - startTime;\n  const elapsedSeconds = elapsedMs / 1000;\n  const cpuUserMs = endCpuUsage.user / 1000;\n  const cpuSystemMs = endCpuUsage.system / 1000;\n  const cpuTotalMs = cpuUserMs + cpuSystemMs;\n  const cpuPercent = (cpuTotalMs / elapsedMs) * 100;\n  \n  console.log('=== Performance Metrics ===');\n  console.log(`Successful ticks: ${successfulTicks}`);\n  console.log(`Spawn errors:     ${spawnErrors}`);\n  console.log(`Total time:       ${elapsedSeconds.toFixed(2)}s`);\n  console.log(`CPU user:         ${cpuUserMs.toFixed(1)}ms`);\n  console.log(`CPU system:       ${cpuSystemMs.toFixed(1)}ms`);\n  console.log(`CPU total:        ${cpuTotalMs.toFixed(1)}ms`);\n  console.log(`CPU usage:        ${cpuPercent.toFixed(2)}%`);\n  console.log(`Avg time/tick:    ${(elapsedMs / numTicks).toFixed(2)}ms`);\n  console.log();\n  console.log('Note: spawnErrors include Node processes that fail to initialize,');\n  console.log('which is expected when running without actual notify-fallback-watcher.');\n  \n} finally {\n  rmSync(testDir, { recursive: true, force: true });\n}\n