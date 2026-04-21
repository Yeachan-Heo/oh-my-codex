export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
}>;

export const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  const headersObj: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headersObj[key] = value;
  });
  return {
    status: response.status,
    headers: headersObj,
    text: () => response.text(),
  };
};

export class HttpProviderError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = 'HttpProviderError';
    this.status = status;
    this.body = body;
  }
}

export async function httpPostJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  fetcher: FetchLike = defaultFetch,
): Promise<T> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new HttpProviderError(response.status, text);
  }
  return JSON.parse(text) as T;
}
