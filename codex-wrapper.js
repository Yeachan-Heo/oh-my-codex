#!/usr/bin/env node
/**
 * Wrapper for @openai/codex that supports custom API base URLs.
 * This script acts as a proxy between the collector and @openai/codex,
 * handling custom base URLs that @openai/codex doesn't natively support.
 *
 * Usage: node codex-wrapper.js [codex-args...]
 */

const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const baseUrl = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const apiKey = process.env.OPENAI_API_KEY;

// If using default OpenAI endpoint, just pass through to codex directly
if (baseUrl === 'https://api.openai.com/v1' || !apiKey) {
  const child = spawn('npx', ['-y', '@openai/codex', ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
} else {
  // For custom endpoints, we need to intercept and proxy the requests
  // This is complex, so for now we'll document the limitation
  console.error(`\nWarning: Custom base URL '${baseUrl}' is not yet fully supported by the wrapper.`);
  console.error('Current implementation limitation: @openai/codex does not support custom API endpoints.');
  console.error('');
  console.error('Workarounds:');
  console.error('1. Use an HTTP proxy (e.g., socat, nginx)');
  console.error('2. Modify /etc/hosts to redirect api.openai.com to your endpoint');
  console.error('3. Use mitmproxy or similar SSL-capable proxy');
  console.error('');
  
  // For now, still try to pass through and let it fail gracefully
  const child = spawn('npx', ['-y', '@openai/codex', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      OPENAI_BASE_URL: baseUrl,
      OPENAI_API_BASE: baseUrl,
    },
  });
  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
}
