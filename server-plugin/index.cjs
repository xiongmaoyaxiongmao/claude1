'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const MAX_ITEMS = 100;
const snapshots = [];
const patcherState = {
  installed: false,
  patchedRequests: 0,
  skippedRequests: 0,
  lastPatchedAt: null,
  lastTarget: null,
  lastUserId: null,
};
const originalRequest = {
  http: http.request,
  https: https.request,
};

async function init(router) {
  router.get('/diagnose', (_req, res) => {
    res.json({
      ok: true,
      summary: summarize(),
      recent: snapshots.slice(-20),
    });
  });

  router.post('/diagnose', (req, res) => {
    const payload = {
      receivedAt: new Date().toISOString(),
      snapshot: req.body?.snapshot || null,
      analysis: req.body?.analysis || null,
    };
    snapshots.push(payload);
    while (snapshots.length > MAX_ITEMS) {
      snapshots.shift();
    }
    res.json({
      ok: true,
      summary: summarize(),
    });
  });

  router.delete('/diagnose', (_req, res) => {
    snapshots.length = 0;
    res.json({ ok: true, summary: summarize() });
  });

  router.get('/config', (_req, res) => {
    try {
      const configPath = findConfigPath();
      const exists = fs.existsSync(configPath);
      res.json({
        ok: true,
        writable: exists ? canWrite(configPath) : canWrite(path.dirname(configPath)),
        configPath,
        exists,
        current: exists ? readClaudeConfig(fs.readFileSync(configPath, 'utf8')) : null,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  });

  router.post('/config', (req, res) => {
    try {
      const settings = normalizeClaudeSettings(req.body?.settings || req.body || {});
      const result = applyClaudeConfig(settings);
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message || String(error) });
    }
  });

  router.get('/patcher', (_req, res) => {
    res.json({
      ok: true,
      ...patcherState,
      userId: getMetadataUserId(),
    });
  });

  installRequestPatcher();
  console.log('[Claude Cache Lens] server plugin loaded');
  return Promise.resolve();
}

async function exit() {
  snapshots.length = 0;
  restoreRequestPatcher();
  return Promise.resolve();
}

function summarize() {
  const riskCounts = snapshots.reduce((result, item) => {
    const risk = item.analysis?.risk || 'Unknown';
    result[risk] = (result[risk] || 0) + 1;
    return result;
  }, {});
  const last = snapshots.at(-1) || null;
  return {
    count: snapshots.length,
    riskCounts,
    lastReceivedAt: last?.receivedAt || null,
    lastRisk: last?.analysis?.risk || null,
    lastRecommendation: last?.analysis?.recommendations || null,
  };
}

function findConfigPath() {
  const candidates = [
    path.resolve(process.cwd(), 'config.yaml'),
    path.resolve(__dirname, '..', '..', 'config.yaml'),
    path.resolve(__dirname, '..', 'config.yaml'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function canWrite(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeClaudeSettings(input) {
  const depth = Number(input.cachingAtDepth ?? 2);
  if (!Number.isInteger(depth) || depth < -1) {
    throw new Error('cachingAtDepth must be -1, 0, or a positive integer');
  }
  return {
    enableSystemPromptCache: Boolean(input.enableSystemPromptCache ?? true),
    cachingAtDepth: depth,
    extendedTTL: Boolean(input.extendedTTL ?? false),
  };
}

function applyClaudeConfig(settings) {
  const configPath = findConfigPath();
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const backupPath = `${configPath}.bak.claude-cache-lens-${timestamp()}`;
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, backupPath);
  }
  const updated = updateConfigYaml(original, settings);
  fs.writeFileSync(configPath, updated, 'utf8');
  return {
    configPath,
    backupPath: fs.existsSync(backupPath) ? backupPath : null,
    settings,
    current: readClaudeConfig(updated),
    restartRequired: true,
  };
}

function updateConfigYaml(original, settings) {
  const normalized = String(original || '').replace(/\r\n/g, '\n');
  const block = buildClaudeBlock(settings);
  const lines = normalized.split('\n');
  const start = lines.findIndex((line) => /^claude:\s*(?:#.*)?$/.test(line));

  if (start === -1) {
    const prefix = normalized.trimEnd();
    return `${prefix}${prefix ? '\n\n' : ''}${block}\n`;
  }

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^[A-Za-z0-9_-]+:\s*/.test(line)) {
      break;
    }
    end += 1;
  }

  lines.splice(start, end - start, ...block.split('\n'));
  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

function buildClaudeBlock(settings) {
  return [
    'claude:',
    `  enableSystemPromptCache: ${settings.enableSystemPromptCache}`,
    `  cachingAtDepth: ${settings.cachingAtDepth}`,
    `  extendedTTL: ${settings.extendedTTL}`,
  ].join('\n');
}

function readClaudeConfig(text) {
  const match = String(text || '').match(/^claude:\n((?:^[ \t]+.*\n?)*)/m);
  if (!match) {
    return null;
  }
  const result = {};
  for (const line of match[1].split('\n')) {
    const item = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!item) continue;
    const key = item[1];
    const raw = item[2];
    if (raw === 'true' || raw === 'false') {
      result[key] = raw === 'true';
    } else if (/^-?\d+$/.test(raw)) {
      result[key] = Number(raw);
    } else {
      result[key] = raw;
    }
  }
  return result;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function installRequestPatcher() {
  if (patcherState.installed) {
    return;
  }
  http.request = makePatchedRequest('http:', originalRequest.http);
  https.request = makePatchedRequest('https:', originalRequest.https);
  patcherState.installed = true;
}

function restoreRequestPatcher() {
  if (!patcherState.installed) {
    return;
  }
  http.request = originalRequest.http;
  https.request = originalRequest.https;
  patcherState.installed = false;
}

function makePatchedRequest(protocol, original) {
  return function patchedRequest(...args) {
    const requestInfo = getRequestInfo(protocol, args);
    const req = original.apply(this, args);
    if (!requestInfo || !shouldCaptureTarget(requestInfo)) {
      return req;
    }

    const chunks = [];
    const originalWrite = req.write.bind(req);
    const originalEnd = req.end.bind(req);

    req.write = function patchedWrite(chunk, encoding, callback) {
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      if (typeof callback === 'function') {
        callback();
      }
      return true;
    };

    req.end = function patchedEnd(chunk, encoding, callback) {
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
        encoding = undefined;
      } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }

      const originalBody = Buffer.concat(chunks);
      const patchResult = patchClaudeCacheRequestBuffer(originalBody, requestInfo);
      if (patchResult.changed) {
        req.setHeader('content-length', Buffer.byteLength(patchResult.body));
        patcherState.patchedRequests += 1;
        patcherState.lastPatchedAt = new Date().toISOString();
        patcherState.lastTarget = requestInfo.href;
        patcherState.lastUserId = patchResult.userId;
      } else {
        patcherState.skippedRequests += 1;
      }

      return originalEnd(patchResult.changed ? patchResult.body : originalBody, encoding, callback);
    };

    return req;
  };
}

function patchClaudeCacheRequestBuffer(buffer, requestInfo) {
  if (!buffer?.length) {
    return { changed: false, body: buffer };
  }
  const text = buffer.toString('utf8');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { changed: false, body: buffer };
  }

  const result = patchClaudeCacheRequestBody(body, {
    forceClaude: requestInfo.pathname.endsWith('/messages'),
    userId: getMetadataUserId(),
    settings: readClaudeConfigFromDisk(),
  });

  if (!result.changed) {
    return { changed: false, body: buffer };
  }

  return {
    changed: true,
    body: JSON.stringify(body),
    userId: result.userId,
  };
}

function patchClaudeCacheRequestBody(body, options = {}) {
  if (!body || typeof body !== 'object') {
    return { changed: false };
  }
  const model = String(body.model || '').toLowerCase();
  const isClaude = options.forceClaude || model.includes('claude');
  if (!isClaude) {
    return { changed: false };
  }

  const settings = options.settings || {};
  const ttl = settings.extendedTTL ? '1h' : '5m';
  const cacheControl = { type: 'ephemeral', ttl };
  const userId = sanitizeMetadataUserId(options.userId || getMetadataUserId());
  let changed = false;

  if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
    body.metadata = {};
    changed = true;
  }
  if (body.metadata.user_id !== userId) {
    body.metadata.user_id = userId;
    changed = true;
  }

  if (!body.cache_control) {
    body.cache_control = cacheControl;
    changed = true;
  }

  if (ensureSystemCacheControl(body, cacheControl)) {
    changed = true;
  }

  const depth = Number.isInteger(settings.cachingAtDepth) ? settings.cachingAtDepth : -1;
  if (Array.isArray(body.messages) && depth >= 0 && ensureMessageCacheControlAtDepth(body.messages, depth, cacheControl)) {
    changed = true;
  }

  return { changed, userId };
}

function ensureSystemCacheControl(body, cacheControl) {
  if (Array.isArray(body.system) && body.system.length > 0) {
    const last = body.system[body.system.length - 1];
    if (last && typeof last === 'object' && !last.cache_control) {
      last.cache_control = { ...cacheControl };
      return true;
    }
    return false;
  }

  if (typeof body.system === 'string' && body.system.trim()) {
    body.system = [{ type: 'text', text: body.system, cache_control: { ...cacheControl } }];
    return true;
  }

  if (!Array.isArray(body.messages)) {
    return false;
  }

  const systemMessage = body.messages.find((message) => message?.role === 'system');
  if (!systemMessage) {
    return false;
  }
  return ensureMessageContentCacheControl(systemMessage, cacheControl);
}

function ensureMessageCacheControlAtDepth(messages, cachingAtDepth, cacheControl) {
  let changed = false;
  let passedThePrefill = false;
  let depth = 0;
  let previousRoleName = '';

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || typeof message !== 'object') {
      continue;
    }
    if (!passedThePrefill && message.role === 'assistant') {
      continue;
    }

    passedThePrefill = true;

    if (message.role === 'system') {
      continue;
    }

    if (message.role !== previousRoleName) {
      if (depth === cachingAtDepth || depth === cachingAtDepth + 2) {
        if (ensureMessageContentCacheControl(message, cacheControl)) {
          changed = true;
        }
      }

      if (depth === cachingAtDepth + 2) {
        break;
      }

      depth += 1;
      previousRoleName = message.role;
    }
  }

  return changed;
}

function ensureMessageContentCacheControl(message, cacheControl) {
  if (message.cache_control || message.content?.cache_control) {
    return false;
  }
  if (typeof message.content === 'string' && message.content.trim()) {
    message.content = [{ type: 'text', text: message.content, cache_control: { ...cacheControl } }];
    return true;
  }
  if (Array.isArray(message.content)) {
    for (let i = message.content.length - 1; i >= 0; i -= 1) {
      const part = message.content[i];
      if (part && typeof part === 'object' && !part.cache_control && isCacheableContentPart(part)) {
        part.cache_control = { ...cacheControl };
        return true;
      }
    }
  }
  return false;
}

function isCacheableContentPart(part) {
  return !part.type || ['text', 'image', 'document', 'tool_use', 'tool_result'].includes(part.type);
}

function readClaudeConfigFromDisk() {
  const configPath = findConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }
  return readClaudeConfig(fs.readFileSync(configPath, 'utf8')) || {};
}

function getMetadataUserId() {
  return sanitizeMetadataUserId(process.env.CLAUDE_CACHE_LENS_USER_ID || 'sillytavern-default-user');
}

function sanitizeMetadataUserId(value) {
  return String(value || 'sillytavern-default-user')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, '-')
    .slice(0, 128) || 'sillytavern-default-user';
}

function shouldCaptureTarget(info) {
  if (info.method !== 'POST') {
    return false;
  }
  return info.pathname.endsWith('/messages') || info.pathname.endsWith('/chat/completions');
}

function getRequestInfo(protocol, args) {
  try {
    const url = normalizeRequestUrl(protocol, args[0], args[1]);
    const options = getRequestOptions(args[0], args[1]);
    const method = String(options.method || 'GET').toUpperCase();
    return {
      href: url.href,
      method,
      hostname: url.hostname,
      pathname: url.pathname,
    };
  } catch {
    return null;
  }
}

function normalizeRequestUrl(protocol, input, options = {}) {
  if (input instanceof URL) {
    return new URL(input.href);
  }
  if (typeof input === 'string') {
    return new URL(input);
  }
  const requestOptions = input && typeof input === 'object' ? { ...input, ...(options || {}) } : (options || {});
  const hostname = requestOptions.hostname || requestOptions.host || 'localhost';
  const port = requestOptions.port ? `:${requestOptions.port}` : '';
  const pathName = requestOptions.path || requestOptions.pathname || '/';
  return new URL(`${requestOptions.protocol || protocol}//${hostname}${port}${pathName}`);
}

function getRequestOptions(input, options) {
  if (input instanceof URL || typeof input === 'string') {
    return options || {};
  }
  return input || {};
}

module.exports = {
  init,
  exit,
  _private: {
    buildClaudeBlock,
    normalizeClaudeSettings,
    patchClaudeCacheRequestBody,
    readClaudeConfig,
    updateConfigYaml,
  },
  info: {
    id: 'claude-cache-lens',
    name: 'Claude Cache Lens',
    description: 'Stores SillyTavern Claude prompt-cache diagnostics for Cache Lens.',
  },
};
