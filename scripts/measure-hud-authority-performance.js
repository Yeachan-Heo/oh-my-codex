#!/usr/bin/env node
/**
 * Measure HUD authority performance: idle CPU and child spawns.
 * 
 * Usage:
 *   node scripts/measure-hud-authority-performance.js <cwd> [num-huds] [duration-seconds]
 * 
 * Example:
 *   node scripts/measure-hud-authority-performance.js ~/.omx 5 60
 */

import { spawn, execSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { writeFileSync } from 'fs';

const cwd = process.argv[2] || process.cwd();
const numHuds = parseInt(process.argv[3], 10) || 1;
const durationSeconds = parseInt(process.argv[4], 10) || 60;
const warmupSeconds = 15;

console.log(`Measuring HUD authority performance:`);
console.log(`  CWD: ${cwd}`);
console.log(`  HUDs: ${numHuds}`);
console.log(`  Duration: ${durationSeconds}s (after ${warmupSeconds}s warmup)`);
console.log();

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getChildProcessCount() {
  try {
    // Count child processes of the Node process
    const result = execSync(`ps -o ppid= -p $$ | xargs ps -o pid= -P | wc -l`, { encoding: 'utf-8' });
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function getIdleCpuUsage() {
  try {
    // Get idle CPU percentage using top (average of 1 and 5 min loads)
    const result = execSync(`awk '{print $3, $4}' /proc/loadavg | awk '{print (1 - ($1 + $2) / (2 * $(NF - 1))) * 100}'`, { 
      encoding: 'utf-8', 
      shell: '/bin/bash' 
    });
    return parseFloat(result.trim()) || 0;
  } catch {
    return 0;
  }
}

async function runMeasurement() {
  const measurements = {
    cpuSamples: [],
    spawnCounts: [],
    startTime: Date.now(),
  };

  let lastSpawnCount = 0;

  // Warmup phase
  console.log(`[Warmup] Running for ${warmupSeconds}s...`);
  for (let i = 0; i < warmupSeconds; i++) {
    await sleep(1000);
    process.stdout.write('.');
  }
  console.log(' done\n');

  // Reset spawn counter after warmup
  lastSpawnCount = getChildProcessCount();
  measurements.startTime = Date.now();

  // Measurement phase
  console.log(`[Measurement] Collecting samples for ${durationSeconds}s...`);
  for (let i = 0; i < durationSeconds; i++) {
    const idleCpu = getIdleCpuUsage();
    measurements.cpuSamples.push(idleCpu);
    
    const childCount = getChildProcessCount();
    if (childCount !== lastSpawnCount) {
      measurements.spawnCounts.push({
        second: i,
        count: childCount - lastSpawnCount,
      });
      lastSpawnCount = childCount;
    }

    process.stdout.write('.');
    await sleep(1000);
  }
  console.log(' done\n');

  // Calculate statistics
  const avgCpu = measurements.cpuSamples.reduce((a, b) => a + b, 0) / measurements.cpuSamples.length;
  const minCpu = Math.min(...measurements.cpuSamples);
  const maxCpu = Math.max(...measurements.cpuSamples);
  const totalSpawns = measurements.spawnCounts.reduce((sum, s) => sum + s.count, 0);
  const spawnsPerMinute = (totalSpawns / durationSeconds) * 60;

  return {
    avgIdleCpu: avgCpu.toFixed(2),
    minIdleCpu: minCpu.toFixed(2),
    maxIdleCpu: maxCpu.toFixed(2),
    totalChildSpawns: totalSpawns,
    spawnsPerMinute: spawnsPerMinute.toFixed(2),
    sampleCount: measurements.cpuSamples.length,
  };
}

try {
  const results = await runMeasurement();
  
  console.log('\n=== Performance Results ===');
  console.log(`Idle CPU (avg):       ${results.avgIdleCpu}%`);
  console.log(`Idle CPU (min):       ${results.minIdleCpu}%`);
  console.log(`Idle CPU (max):       ${results.maxIdleCpu}%`);
  console.log(`Child process spawns: ${results.totalChildSpawns}`);
  console.log(`Spawns per minute:    ${results.spawnsPerMinute}`);
  console.log(`Sample count:         ${results.sampleCount}`);
  
  // Output JSON for easy comparison
  console.log('\n=== JSON Output ===');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('Measurement failed:', err.message);
  process.exit(1);
}
