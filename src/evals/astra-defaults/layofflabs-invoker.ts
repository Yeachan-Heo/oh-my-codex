/**
 * Invoker for the Responses API using curl, with support for custom base URLs.
 * This bypasses @openai/codex and calls the Responses API directly.
 */

import { spawn } from 'node:child_process';
import type { CodexOutput } from './collector.js';

/**
 * Invokes the Responses API directly using curl.
 * Supports custom base URLs like https://api.layofflabs.com/v1
 */
export async function invokeResponsesAPI(
  args: string[],
  cwd: string,
  baseUrl: string = 'https://api.openai.com/v1',
): Promise<CodexOutput> {
  // Parse arguments to extract model and other details
  // Expected format: exec --json --skip-git-repo-check --ephemeral -m <model> -c reasoning_effort='<effort>' <prompt>
  
  let model = 'gpt-4';
  let reasoningEffort = 'medium';
  let prompt = '';
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' && i + 1 < args.length) {
      model = args[i + 1];
      i++;
    } else if (args[i].startsWith("reasoning_effort='") && args[i].endsWith("'")) {
      reasoningEffort = args[i].slice(18, -1);
    } else if (!args[i].startsWith('-') && args[i] !== 'exec' && args[i] !== '--json' && 
               args[i] !== '--skip-git-repo-check' && args[i] !== '--ephemeral' && !args[i].startsWith('-c')) {
      prompt = args[i];
    }
  }
  
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Error: OPENAI_API_KEY environment variable is not set',
    };
  }
  
  // Build the cURL command to call the Responses API
  const url = `${baseUrl}/responses`;
  const curlArgs = [
    '-X', 'POST',
    url,
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${apiKey}`,
    '-d', JSON.stringify({
      model,
      reasoning_effort: reasoningEffort,
      prompt,
    }),
  ];
  
  return new Promise((resolve) => {
    const child = spawn('curl', curlArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 16 * 60 * 1000,
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout?.on('data', (data) => {
      stdout += String(data);
    });
    
    child.stderr?.on('data', (data) => {
      stderr += String(data);
    });
    
    child.on('error', (err) => {
      stderr += err.message;
    });
    
    child.on('exit', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
      });
    });
    
    child.stdin?.end();
  });
}
