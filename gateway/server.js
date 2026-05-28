import http from 'node:http';

const PORT = Number(process.env.PORT || process.env.CLAUDE_CACHE_LENS_PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const CLAUDE_BASE_URL = (process.env.CLAUDE_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const AUTO_CACHE = String(process.env.CLAUDE_CACHE_AUTO_MODE || '').toLowerCase() === 'true';
const CACHE_TTL = process.env.CLAUDE_CACHE_TTL === '1h' ? '1h' : null;
const MAX_USAGE_ITEMS = Number(process.env.CLAUDE_CACHE_USAGE_LIMIT || 200);

const usageLog = [];

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        autoCache: AUTO_CACHE,
        baseUrl: CLAUDE_BASE_URL,
      });
      return;
    }

    if (url.pathname === '/cache-lens/usage') {
      if (req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          summary: summarizeUsage(),
          recent: usageLog.slice(-25),
        });
        return;
      }
      if (req.method === 'DELETE') {
        usageLog.length = 0;
        sendJson(res, 200, { ok: true, summary: summarizeUsage() });
        return;
      }
    }

    if (url.pathname === '/v1/messages') {
      await proxyClaudeMessages(req, res);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[Claude Cache Lens Gateway] listening at http://${HOST}:${PORT}`);
});

async function proxyClaudeMessages(req, res) {
  if (!CLAUDE_API_KEY) {
    sendJson(res, 500, { ok: false, error: 'CLAUDE_API_KEY or ANTHROPIC_API_KEY is required' });
    return;
  }

  const rawBody = await readBody(req);
  let body = JSON.parse(rawBody || '{}');
  body = maybeApplyAutomaticCache(body);

  const upstream = await fetch(`${CLAUDE_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: buildClaudeHeaders(req),
    body: JSON.stringify(body),
  });

  const contentType = upstream.headers.get('content-type') || 'application/json';
  res.writeHead(upstream.status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });

  if (body.stream && upstream.body) {
    const chunks = [];
    for await (const chunk of upstream.body) {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      res.write(buffer);
    }
    res.end();
    recordUsage({
      status: upstream.status,
      model: body.model,
      usage: extractUsageFromAnthropicSse(Buffer.concat(chunks).toString('utf8')),
      streamed: true,
      autoCache: AUTO_CACHE,
    });
    return;
  }

  const text = await upstream.text();
  res.end(text);

  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  recordUsage({
    status: upstream.status,
    model: body.model,
    usage: payload?.usage || null,
    streamed: false,
    autoCache: AUTO_CACHE,
  });
}

function maybeApplyAutomaticCache(body) {
  if (!AUTO_CACHE || body.cache_control) {
    return body;
  }
  const cacheControl = { type: 'ephemeral' };
  if (CACHE_TTL) {
    cacheControl.ttl = CACHE_TTL;
  }
  return {
    ...body,
    cache_control: cacheControl,
  };
}

function buildClaudeHeaders(req) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': CLAUDE_API_KEY,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  };
  if (req.headers['anthropic-beta']) {
    headers['anthropic-beta'] = req.headers['anthropic-beta'];
  }
  return headers;
}

function extractUsageFromAnthropicSse(text) {
  let usage = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') {
      continue;
    }
    try {
      const payload = JSON.parse(data);
      if (payload.usage) {
        usage = { ...(usage || {}), ...payload.usage };
      }
      if (payload.message?.usage) {
        usage = { ...(usage || {}), ...payload.message.usage };
      }
    } catch {
      // Ignore non-JSON event data.
    }
  }
  return usage;
}

function recordUsage(item) {
  usageLog.push({
    at: new Date().toISOString(),
    ...item,
  });
  while (usageLog.length > MAX_USAGE_ITEMS) {
    usageLog.shift();
  }
}

function summarizeUsage() {
  return usageLog.reduce((summary, item) => {
    const usage = item.usage || {};
    summary.count += 1;
    summary.cacheReadTokens += Number(usage.cache_read_input_tokens || 0);
    summary.cacheCreationTokens += Number(usage.cache_creation_input_tokens || 0);
    summary.inputTokens += Number(usage.input_tokens || 0);
    summary.outputTokens += Number(usage.output_tokens || 0);
    summary.lastAt = item.at;
    return summary;
  }, {
    count: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastAt: null,
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function setCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,anthropic-version,anthropic-beta,x-api-key');
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}
