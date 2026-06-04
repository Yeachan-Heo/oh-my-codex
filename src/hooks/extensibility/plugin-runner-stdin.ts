import { TextDecoder } from 'node:util';

export async function readStdin(input: AsyncIterable<string | Buffer | Uint8Array> = process.stdin): Promise<string> {
  const decoder = new TextDecoder('utf-8');
  let raw = '';

  for await (const chunk of input) {
    if (typeof chunk === 'string') {
      raw += decoder.decode();
      raw += chunk;
      continue;
    }

    raw += decoder.decode(chunk, { stream: true });
  }

  raw += decoder.decode();
  return raw.trim();
}
