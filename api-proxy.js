#!/usr/bin/env node
/**
 * HTTP proxy that redirects OpenAI API calls to a custom endpoint (e.g., layofflabs)
 * Usage: node api-proxy.js [--target-url <url>] [--port <port>]
 */

const http = require('http');
const https = require('https');
const url = require('url');

const targetUrl = process.argv.includes('--target-url')
  ? process.argv[process.argv.indexOf('--target-url') + 1]
  : 'https://api.layofflabs.com/v1';

const port = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1], 10)
  : 8899;

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error('Error: OPENAI_API_KEY environment variable is not set');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // Parse the incoming request URL
  const incomingUrl = new url.URL(`http://api.openai.com${req.url}`);
  
  // Build the target URL (layofflabs or custom)
  const targetUrlObj = new url.URL(targetUrl);
  targetUrlObj.pathname = incomingUrl.pathname;
  targetUrlObj.search = incomingUrl.search;

  console.log(`[${new Date().toISOString()}] ${req.method} ${incomingUrl.pathname} -> ${targetUrlObj.href}`);

  // Build the request options
  const requestOptions = {
    method: req.method,
    headers: {
      ...req.headers,
      'Authorization': `Bearer ${apiKey}`,
      'host': targetUrlObj.host,
    },
  };

  // Remove the Host header set by Node.js to avoid conflicts
  delete requestOptions.headers['host'];

  // Make the actual request to the target API
  const protocol = targetUrlObj.protocol === 'https:' ? https : http;
  const proxyReq = protocol.request(targetUrlObj.href, requestOptions, (proxyRes) => {
    // Forward status and headers
    res.writeHead(proxyRes.statusCode, proxyRes.headers);

    // Forward the response body
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    console.error(`[${new Date().toISOString()}] Error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  });

  // Forward the request body
  req.pipe(proxyReq);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`\nOpenAI API Proxy started on http://127.0.0.1:${port}`);
  console.log(`Forwarding requests to: ${targetUrl}`);
  console.log(`API Key: ${apiKey.slice(0, 10)}...`);
  console.log(`\nSet environment variable to use this proxy:`);
  console.log(`export OPENAI_API_BASE=http://127.0.0.1:${port}`);
  console.log(`export OPENAI_BASE_URL=http://127.0.0.1:${port}`);
  console.log(`\nOr in your code, configure the OpenAI client to use:`);
  console.log(`baseURL: 'http://127.0.0.1:${port}'`);
  console.log('');
});

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});
