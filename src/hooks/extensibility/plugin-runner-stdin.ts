export async function readStdin(input: AsyncIterable<string | Buffer | Uint8Array> = process.stdin): Promise<string> {
  let raw = '';
  for await (const chunk of input) {
    raw += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
  }
  return raw.trim();
}
