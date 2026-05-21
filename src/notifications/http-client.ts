import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { connect as netConnect } from "net";
import { connect as tlsConnect } from "tls";
import type { IncomingMessage } from "http";
import type { Socket } from "net";

export interface ProxyEnv {
  [key: string]: string | undefined;
}

export interface ProxyConfig {
  url: URL;
}

export interface JsonHttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface JsonHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

class BufferedHttpResponse implements JsonHttpResponse {
  ok: boolean;

  constructor(
    public status: number,
    private readonly bodyText: string,
  ) {
    this.ok = status >= 200 && status < 300;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.bodyText);
  }

  async text(): Promise<string> {
    return this.bodyText;
  }
}

function firstEnv(env: ProxyEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function normalizeProxyUrl(value: string): URL | undefined {
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `http://${value}`;
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function splitNoProxyEntry(entry: string): { host: string; port?: string } {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed) return { host: "" };
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end !== -1) {
      const host = trimmed.slice(1, end);
      const rest = trimmed.slice(end + 1);
      return { host, port: rest.startsWith(":") ? rest.slice(1) : undefined };
    }
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && trimmed.indexOf(":") === colon) {
    const maybePort = trimmed.slice(colon + 1);
    if (/^\d+$/.test(maybePort)) {
      return { host: trimmed.slice(0, colon), port: maybePort };
    }
  }
  return { host: trimmed };
}

export function noProxyMatches(target: URL, noProxyValue: string | undefined): boolean {
  if (!noProxyValue) return false;
  const targetHost = target.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const targetPort = target.port || (target.protocol === "https:" ? "443" : "80");

  for (const rawEntry of noProxyValue.split(",")) {
    const { host, port } = splitNoProxyEntry(rawEntry);
    if (!host) continue;
    if (host === "*") return true;
    if (port && port !== targetPort) continue;

    if (host.startsWith(".")) {
      const suffix = host.slice(1);
      if (targetHost === suffix || targetHost.endsWith(`.${suffix}`)) return true;
      continue;
    }

    if (targetHost === host || targetHost.endsWith(`.${host}`)) return true;
  }

  return false;
}

export function getProxyForUrl(targetUrl: string | URL, env: ProxyEnv = process.env): ProxyConfig | undefined {
  const target = typeof targetUrl === "string" ? new URL(targetUrl) : targetUrl;
  const noProxy = firstEnv(env, ["no_proxy", "NO_PROXY"]);
  if (noProxyMatches(target, noProxy)) return undefined;

  const proxyValue =
    target.protocol === "https:"
      ? firstEnv(env, ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"])
      : firstEnv(env, ["http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]);
  if (!proxyValue) return undefined;

  const url = normalizeProxyUrl(proxyValue);
  return url ? { url } : undefined;
}

function collectIncoming(
  res: IncomingMessage,
  timeout: NodeJS.Timeout,
  resolve: (value: JsonHttpResponse) => void,
  reject: (reason?: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  const cleanup = () => {
    clearTimeout(timeout);
    res.off("data", onData);
    res.off("end", onEnd);
    res.off("error", onError);
  };
  const onData = (chunk: Buffer) => chunks.push(chunk);
  const onEnd = () => {
    cleanup();
    resolve(new BufferedHttpResponse(res.statusCode ?? 0, Buffer.concat(chunks).toString("utf-8")));
  };
  const onError = (error: Error) => {
    cleanup();
    reject(error);
  };
  res.on("data", onData);
  res.once("end", onEnd);
  res.once("error", onError);
}

async function requestDirect(url: URL, options: JsonHttpRequestOptions): Promise<JsonHttpResponse> {
  if (globalThis.fetch) {
    return globalThis.fetch(url, {
      method: options.method ?? "POST",
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs),
    }) as Promise<JsonHttpResponse>;
  }

  return new Promise<JsonHttpResponse>((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    let timedOut = false;
    const cleanup = () => {
      clearTimeout(timeout);
      req.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(timedOut ? new Error("Request timeout") : error);
    };
    const req = request(
      url,
      {
        method: options.method ?? "POST",
        headers: options.headers,
        timeout: options.timeoutMs,
      },
      (res) => collectIncoming(
        res,
        timeout,
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      ),
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error("Request timeout"));
      req.socket?.destroy();
    }, options.timeoutMs);
    req.on("error", onError);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function proxyAuthority(proxy: URL): { host: string; port: number } {
  return {
    host: proxy.hostname,
    port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
  };
}

function openProxySocket(proxy: URL, timeoutMs: number): Promise<Socket> {
  const { host, port } = proxyAuthority(proxy);
  return new Promise((resolve, reject) => {
    const socket = proxy.protocol === "https:"
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port });
    const readyEvent = proxy.protocol === "https:" ? "secureConnect" : "connect";
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off(readyEvent, onReady);
      socket.off("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Proxy connection timeout"));
    }, timeoutMs);
    socket.once(readyEvent, onReady);
    socket.once("error", onError);
  });
}

function proxyAuthorizationHeader(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const user = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function readUntilHeaders(socket: Socket, timeoutMs: number): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Proxy response timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      cleanup();
      resolve({
        head: buffer.slice(0, headerEnd).toString("latin1"),
        rest: buffer.slice(headerEnd + 4),
      });
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function decodeChunked(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const sizeText = body.slice(offset, lineEnd).toString("ascii").split(";", 1)[0]?.trim() ?? "";
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) break;
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(body.slice(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

async function sendRawHttp(socket: Socket, rawRequest: string, timeoutMs: number): Promise<JsonHttpResponse> {
  socket.write(rawRequest);
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer) => chunks.push(chunk);
    const onEnd = () => {
      cleanup();
      const buffer = Buffer.concat(chunks);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        reject(new Error("Invalid HTTP response"));
        return;
      }
      const head = buffer.slice(0, headerEnd).toString("latin1");
      const status = Number(head.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] ?? 0);
      const isChunked = /^transfer-encoding:\s*chunked$/im.test(head);
      const rawBody = buffer.slice(headerEnd + 4);
      const body = isChunked ? decodeChunked(rawBody) : rawBody;
      resolve(new BufferedHttpResponse(status, body.toString("utf-8")));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Request timeout"));
    }, timeoutMs);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

function formatHeaders(headers: Record<string, string>, target: URL, body?: string): string {
  const allHeaders: Record<string, string> = {
    Host: target.host,
    Connection: "close",
    ...headers,
  };
  if (body !== undefined && !Object.keys(allHeaders).some((key) => key.toLowerCase() === "content-length")) {
    allHeaders["Content-Length"] = String(Buffer.byteLength(body));
  }
  return Object.entries(allHeaders)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\r\n");
}

async function requestViaProxy(url: URL, proxy: URL, options: JsonHttpRequestOptions): Promise<JsonHttpResponse> {
  const method = options.method ?? "POST";
  const body = options.body ?? "";
  const auth = proxyAuthorizationHeader(proxy);

  if (url.protocol === "https:") {
    const proxySocket = await openProxySocket(proxy, options.timeoutMs);
    const targetPort = url.port || "443";
    const connectHeaders = [`CONNECT ${url.hostname}:${targetPort} HTTP/1.1`, `Host: ${url.hostname}:${targetPort}`, "Proxy-Connection: close"];
    if (auth) connectHeaders.push(`Proxy-Authorization: ${auth}`);
    proxySocket.write(`${connectHeaders.join("\r\n")}\r\n\r\n`);
    const connectResponse = await readUntilHeaders(proxySocket, options.timeoutMs);
    const status = Number(connectResponse.head.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] ?? 0);
    if (status < 200 || status >= 300) {
      proxySocket.destroy();
      throw new Error(`Proxy CONNECT failed with HTTP ${status}`);
    }
    const tlsSocket = tlsConnect({ socket: proxySocket, servername: url.hostname });
    await new Promise<void>((resolve, reject) => {
      tlsSocket.once("secureConnect", resolve);
      tlsSocket.once("error", reject);
    });
    const path = `${url.pathname}${url.search}` || "/";
    const raw = `${method} ${path} HTTP/1.1\r\n${formatHeaders(options.headers ?? {}, url, body)}\r\n\r\n${body}`;
    return sendRawHttp(tlsSocket, raw, options.timeoutMs);
  }

  const socket = await openProxySocket(proxy, options.timeoutMs);
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (auth) headers["Proxy-Authorization"] = auth;
  const raw = `${method} ${url.href} HTTP/1.1\r\n${formatHeaders(headers, url, body)}\r\n\r\n${body}`;
  return sendRawHttp(socket, raw, options.timeoutMs);
}

export async function requestJson(
  url: string,
  options: JsonHttpRequestOptions,
  env: ProxyEnv = process.env,
): Promise<JsonHttpResponse> {
  const target = new URL(url);
  const proxy = getProxyForUrl(target, env);
  if (!proxy) return requestDirect(target, options);
  return requestViaProxy(target, proxy.url, options);
}
