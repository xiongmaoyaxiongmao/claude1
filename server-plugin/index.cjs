'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const MAX_ITEMS = 100;
const PLUGIN_VERSION = '0.1.22';
const SERVER_PLUGIN_PACKAGE_NAME = 'claude-cache-lens-server-plugin';
const STATE_DIR = path.resolve(__dirname, '.claude-cache-lens');
const PREFIX_HISTORY_PATH = path.join(STATE_DIR, 'prefix-history.json');
const CACHE_MINIMUM_TOKENS = Object.freeze({
  opus45Plus: 4096,
  opus: 1024,
  sonnet: 1024,
  haiku45Plus: 4096,
  haiku: 2048,
  unknown: 1024,
});
const snapshots = [];
const claudePrefixHistory = new Map();
const guardState = {
  enabled: true,
  requirePreviousPrefix: true,
  allowBaselineWriteOnce: false,
  blockedRequests: 0,
  lastBlockedAt: null,
  lastBlockedTarget: null,
  lastBlockedModel: null,
  lastBlockedPrefixTokens: null,
  lastBlockedMinimumTokens: null,
  lastBlockedReason: null,
};
const patcherState = {
  installed: false,
  patchedRequests: 0,
  cacheReadyRequests: 0,
  skippedRequests: 0,
  lastSeenAt: null,
  lastSeenTarget: null,
  lastSeenModel: null,
  lastModelFamily: null,
  lastEstimatedPromptTokens: null,
  lastTotalPromptTokens: null,
  lastMinimumCacheTokens: null,
  lastBelowMinimum: null,
  lastAutoBreakpoint: null,
  lastClaude: null,
  lastPatchedAt: null,
  lastTarget: null,
  lastUserId: null,
  lastCacheReadyAt: null,
  lastSkippedAt: null,
  lastSkippedTarget: null,
  lastSkippedModel: null,
  lastSkippedReason: null,
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
      version: PLUGIN_VERSION,
      selfUpdate: getSelfUpdateStatus(),
      guard: guardState,
      ...patcherState,
      userId: getMetadataUserId(),
    });
  });

  router.get('/guard', (_req, res) => {
    res.json({
      ok: true,
      guard: guardState,
    });
  });

  router.post('/guard', (req, res) => {
    if (Object.hasOwn(req.body || {}, 'enabled')) {
      guardState.enabled = Boolean(req.body?.enabled);
    }
    if (Object.hasOwn(req.body || {}, 'requirePreviousPrefix')) {
      guardState.requirePreviousPrefix = Boolean(req.body?.requirePreviousPrefix);
    }
    if (Object.hasOwn(req.body || {}, 'allowBaselineWriteOnce')) {
      guardState.allowBaselineWriteOnce = Boolean(req.body?.allowBaselineWriteOnce);
    }
    res.json({
      ok: true,
      guard: guardState,
    });
  });

  router.get('/self-update', (_req, res) => {
    res.json({
      ok: true,
      ...getSelfUpdateStatus(),
    });
  });

  router.post('/self-update', (req, res) => {
    try {
      const result = selfUpdateServerPlugin({ force: Boolean(req.body?.force) });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message || String(error) });
    }
  });

  loadPrefixHistory();
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
      const now = new Date().toISOString();
      patcherState.lastSeenAt = now;
      patcherState.lastSeenTarget = sanitizeTarget(requestInfo.href);
      patcherState.lastSeenModel = patchResult.model || null;
      patcherState.lastModelFamily = patchResult.modelFamily || null;
      patcherState.lastEstimatedPromptTokens = patchResult.estimatedPromptTokens ?? null;
      patcherState.lastTotalPromptTokens = patchResult.totalPromptTokens ?? null;
      patcherState.lastMinimumCacheTokens = patchResult.minimumCacheTokens ?? null;
      patcherState.lastBelowMinimum = patchResult.belowMinimum ?? null;
      patcherState.lastAutoBreakpoint = patchResult.autoBreakpoint || null;
      Object.assign(patchResult, getClaudePrefixComparison(patchResult, requestInfo, now));
      patchResult.guardReason = getGuardBlockReason(patchResult);
      if (shouldGuardBlock(patchResult)) {
        recordClaudeAttempt(patchResult, requestInfo, now, 'blocked');
        recordGuardBlock(patchResult, requestInfo, now);
        const error = new Error(buildGuardErrorMessage(patchResult));
        error.code = 'CLAUDE_CACHE_LENS_GUARD';
        process.nextTick(() => req.destroy(error));
        return req;
      }
      if (shouldConsumeBaselineWriteAllowance(patchResult)) {
        patchResult.usedBaselineWriteAllowance = true;
        guardState.allowBaselineWriteOnce = false;
      }
      if (patchResult.minimumCacheTokens) {
        recordClaudeAttempt(patchResult, requestInfo, now, 'sent');
      }
      if (patchResult.changed) {
        req.setHeader('content-length', Buffer.byteLength(patchResult.body));
        patcherState.patchedRequests += 1;
        patcherState.lastPatchedAt = now;
        patcherState.lastTarget = sanitizeTarget(requestInfo.href);
        patcherState.lastUserId = patchResult.userId;
      } else if (patchResult.cacheReady) {
        patcherState.cacheReadyRequests += 1;
        patcherState.lastCacheReadyAt = now;
        patcherState.lastUserId = patchResult.userId || patcherState.lastUserId;
      } else {
        patcherState.skippedRequests += 1;
        patcherState.lastSkippedAt = now;
        patcherState.lastSkippedTarget = sanitizeTarget(requestInfo.href);
        patcherState.lastSkippedModel = patchResult.model || null;
        patcherState.lastSkippedReason = patchResult.reason || 'unknown';
      }

      return originalEnd(patchResult.changed ? patchResult.body : originalBody, encoding, callback);
    };

    return req;
  };
}

function shouldGuardBlock(patchResult) {
  return Boolean(
    guardState.enabled
    && patchResult?.minimumCacheTokens
    && getGuardBlockReason(patchResult)
  );
}

function getGuardBlockReason(patchResult) {
  if (!patchResult?.minimumCacheTokens) {
    return null;
  }
  if (patchResult.belowMinimum === true) {
    return patchResult.autoBreakpoint?.reason || 'below_minimum';
  }
  if (guardState.allowBaselineWriteOnce && isBaselineReplacementRequest(patchResult)) {
    return null;
  }
  if (patchResult.prefixExpired === true) {
    return 'prefix_expired';
  }
  if (patchResult.prefixMismatch === true) {
    return 'prefix_mismatch';
  }
  if (
    guardState.requirePreviousPrefix
    && patchResult.missingPreviousPrefix === true
    && !guardState.allowBaselineWriteOnce
  ) {
    return 'missing_baseline';
  }
  return null;
}

function isBaselineReplacementRequest(patchResult) {
  return Boolean(
    patchResult?.missingPreviousPrefix
    || patchResult?.prefixExpired
    || patchResult?.prefixMismatch
  );
}

function shouldConsumeBaselineWriteAllowance(patchResult) {
  return Boolean(
    guardState.allowBaselineWriteOnce
    && patchResult?.minimumCacheTokens
    && patchResult.belowMinimum !== true
    && isBaselineReplacementRequest(patchResult)
  );
}

function buildGuardErrorMessage(patchResult) {
  const reason = patchResult.guardReason || getGuardBlockReason(patchResult) || 'guard_blocked';
  if (reason === 'prefix_mismatch') {
    return 'Claude Cache Lens blocked request: cache prefix changed from the previous Claude request.';
  }
  if (reason === 'prefix_expired') {
    return 'Claude Cache Lens blocked request: previous cache prefix is older than the selected TTL.';
  }
  if (reason === 'missing_baseline') {
    return 'Claude Cache Lens blocked request: no previous cache baseline. Allow one baseline write first.';
  }
  return `Claude Cache Lens blocked request: cache prefix ${patchResult.estimatedPromptTokens || 0}/${patchResult.minimumCacheTokens} tokens.`;
}

function recordGuardBlock(patchResult, requestInfo, now) {
  guardState.blockedRequests += 1;
  guardState.lastBlockedAt = now;
  guardState.lastBlockedTarget = sanitizeTarget(requestInfo.href);
  guardState.lastBlockedModel = patchResult.model || null;
  guardState.lastBlockedPrefixTokens = patchResult.estimatedPromptTokens ?? null;
  guardState.lastBlockedMinimumTokens = patchResult.minimumCacheTokens ?? null;
  guardState.lastBlockedReason = patchResult.guardReason || getGuardBlockReason(patchResult) || 'guard_blocked';
}

function getClaudePrefixComparison(patchResult, requestInfo, now = new Date().toISOString()) {
  const target = sanitizeTarget(requestInfo.href);
  const key = hashString([
    target,
    patchResult.model || '',
    patchResult.userId || '',
  ].join('|'));
  const previous = claudePrefixHistory.get(key) || null;
  const prefixHash = patchResult.cachePrefixHash || null;
  const ttlMs = patchResult.cacheTtl === '1h' ? 60 * 60 * 1000 : 5 * 60 * 1000;
  const previousAgeMs = previous?.at ? Date.parse(now) - Date.parse(previous.at) : null;
  const prefixExpired = Boolean(
    previous
    && Number.isFinite(previousAgeMs)
    && previousAgeMs > ttlMs
  );
  const matchedPreviousPrefix = Boolean(
    previous
    && prefixHash
    && previous.cachePrefixHash === prefixHash
    && patchResult.estimatedPromptTokens >= patchResult.minimumCacheTokens
    && !prefixExpired
  );
  const prefixMismatch = Boolean(
    previous
    && prefixHash
    && previous.cachePrefixHash !== prefixHash
    && patchResult.estimatedPromptTokens >= patchResult.minimumCacheTokens
    && !prefixExpired
  );
  const missingPreviousPrefix = Boolean(
    !previous
    && prefixHash
    && patchResult.estimatedPromptTokens >= patchResult.minimumCacheTokens
  );
  const prefixDiff = prefixMismatch
    ? comparePrefixSegments(previous?.cachePrefixSegments || [], patchResult.cachePrefixSegments || [])
    : null;

  return {
    target,
    prefixKey: key,
    previousAt: previous?.at || null,
    previousPrefixTokens: previous?.cachePrefixTokens ?? null,
    previousAgeMs,
    matchedPreviousPrefix,
    prefixMismatch,
    prefixExpired,
    missingPreviousPrefix,
    prefixDiff,
  };
}

function comparePrefixSegments(previousSegments, currentSegments) {
  const maxLength = Math.max(previousSegments.length, currentSegments.length);
  for (let index = 0; index < maxLength; index += 1) {
    const previous = previousSegments[index] || null;
    const current = currentSegments[index] || null;
    if (!previous || !current) {
      return {
        index,
        reason: previous ? 'removed' : 'added',
        previous: summarizeSegmentFingerprint(previous),
        current: summarizeSegmentFingerprint(current),
      };
    }
    if (previous.hash !== current.hash) {
      return {
        index,
        reason: 'changed',
        previous: summarizeSegmentFingerprint(previous),
        current: summarizeSegmentFingerprint(current),
      };
    }
  }
  return null;
}

function summarizeSegmentFingerprint(segment) {
  if (!segment) {
    return null;
  }
  return {
    source: segment.source || null,
    role: segment.role || null,
    chars: segment.chars ?? null,
    tokens: segment.tokens ?? null,
    hasCacheControl: Boolean(segment.hasCacheControl),
  };
}

function recordClaudeAttempt(patchResult, requestInfo, now, outcome) {
  const comparison = patchResult.prefixKey
    ? patchResult
    : getClaudePrefixComparison(patchResult, requestInfo, now);
  const target = comparison.target || sanitizeTarget(requestInfo.href);
  const prefixHash = patchResult.cachePrefixHash || null;

  patcherState.lastClaude = {
    at: now,
    outcome,
    target,
    model: patchResult.model || null,
    userId: patchResult.userId || null,
    cachePrefixTokens: patchResult.estimatedPromptTokens ?? null,
    totalPromptTokens: patchResult.totalPromptTokens ?? null,
    minimumCacheTokens: patchResult.minimumCacheTokens ?? null,
    belowMinimum: patchResult.belowMinimum ?? null,
    cachePrefixHash: prefixHash,
    cachePrefixSegments: patchResult.cachePrefixSegments || [],
    matchedPreviousPrefix: comparison.matchedPreviousPrefix,
    previousAt: comparison.previousAt || null,
    previousPrefixTokens: comparison.previousPrefixTokens ?? null,
    previousAgeMs: comparison.previousAgeMs ?? null,
    prefixMismatch: comparison.prefixMismatch,
    prefixExpired: comparison.prefixExpired,
    missingPreviousPrefix: comparison.missingPreviousPrefix,
    usedBaselineWriteAllowance: patchResult.usedBaselineWriteAllowance || false,
    guardReason: patchResult.guardReason || null,
    prefixDiff: comparison.prefixDiff || null,
    autoBreakpoint: patchResult.autoBreakpoint || null,
  };

  if (prefixHash && outcome === 'sent') {
    claudePrefixHistory.set(comparison.prefixKey, {
      at: now,
      cachePrefixHash: prefixHash,
      cachePrefixTokens: patchResult.estimatedPromptTokens ?? null,
      cachePrefixSegments: patchResult.cachePrefixSegments || [],
    });
    savePrefixHistory();
  }
}

function loadPrefixHistory() {
  claudePrefixHistory.clear();
  if (!fs.existsSync(PREFIX_HISTORY_PATH)) {
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(PREFIX_HISTORY_PATH, 'utf8'));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const [key, value] of entries) {
      if (typeof key === 'string' && value?.cachePrefixHash) {
        claudePrefixHistory.set(key, {
          at: value.at || null,
          cachePrefixHash: String(value.cachePrefixHash),
          cachePrefixTokens: value.cachePrefixTokens ?? null,
          cachePrefixSegments: Array.isArray(value.cachePrefixSegments) ? value.cachePrefixSegments : [],
        });
      }
    }
  } catch {
    claudePrefixHistory.clear();
  }
}

function savePrefixHistory() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const entries = Array.from(claudePrefixHistory.entries())
      .sort((left, right) => String(right[1]?.at || '').localeCompare(String(left[1]?.at || '')))
      .slice(0, 50);
    fs.writeFileSync(PREFIX_HISTORY_PATH, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
  } catch {
    // Best effort only; request patching must not fail because diagnostics could not be persisted.
  }
}

function patchClaudeCacheRequestBuffer(buffer, requestInfo) {
  if (!buffer?.length) {
    return { changed: false, body: buffer, reason: 'empty_body' };
  }
  const text = buffer.toString('utf8');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { changed: false, body: buffer, reason: 'non_json_body' };
  }

  const result = patchClaudeCacheRequestBody(body, {
    forceClaude: requestInfo.pathname.endsWith('/messages'),
    assumeClaudeWhenModelMissing: requestInfo.pathname.endsWith('/chat/completions'),
    userId: getMetadataUserId(),
    settings: readClaudeConfigFromDisk(),
  });

  if (!result.changed) {
    return {
      changed: false,
      body: buffer,
      cacheReady: result.cacheReady,
      model: result.model,
      modelFamily: result.modelFamily,
      estimatedPromptTokens: result.estimatedPromptTokens,
      totalPromptTokens: result.totalPromptTokens,
      minimumCacheTokens: result.minimumCacheTokens,
      belowMinimum: result.belowMinimum,
      cachePrefixHash: result.cachePrefixHash,
      cachePrefixSegments: result.cachePrefixSegments,
      cacheTtl: result.cacheTtl,
      autoBreakpoint: result.autoBreakpoint,
      reason: result.reason,
      userId: result.userId,
    };
  }

  return {
    changed: true,
    body: JSON.stringify(body),
    model: result.model,
    modelFamily: result.modelFamily,
    estimatedPromptTokens: result.estimatedPromptTokens,
    totalPromptTokens: result.totalPromptTokens,
    minimumCacheTokens: result.minimumCacheTokens,
    belowMinimum: result.belowMinimum,
    cachePrefixHash: result.cachePrefixHash,
    cachePrefixSegments: result.cachePrefixSegments,
    cacheTtl: result.cacheTtl,
    autoBreakpoint: result.autoBreakpoint,
    userId: result.userId,
  };
}

function patchClaudeCacheRequestBody(body, options = {}) {
  if (!body || typeof body !== 'object') {
    return { changed: false, reason: 'invalid_body' };
  }
  const model = normalizeModelName(body.model);
  const isClaude = options.forceClaude || isClaudeLikeModel(model) || (!model && options.assumeClaudeWhenModelMissing);
  if (!isClaude) {
    return { changed: false, model, reason: model ? 'non_claude_model' : 'missing_model' };
  }

  const modelFamily = getModelFamily(model);
  const minimumCacheTokens = getCacheMinimumTokens(model);
  const totalPromptTokens = estimatePromptTokens(body);
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

  if (ensureSystemCacheControl(body, cacheControl)) {
    changed = true;
  }

  const depth = Number.isInteger(settings.cachingAtDepth) ? settings.cachingAtDepth : -1;
  if (Array.isArray(body.messages) && depth >= 0 && ensureMessageCacheControlAtDepth(body.messages, depth, cacheControl)) {
    changed = true;
  }

  let cachePrefixInfo = getCacheControlledPrefixInfo(body);
  let estimatedPromptTokens = cachePrefixInfo.tokens;
  const autoBreakpoint = estimatedPromptTokens < minimumCacheTokens
    ? ensureAutomaticCacheControlAtMinimum(body, minimumCacheTokens, cacheControl)
    : null;
  if (autoBreakpoint?.changed) {
    changed = true;
    cachePrefixInfo = getCacheControlledPrefixInfo(body);
    estimatedPromptTokens = cachePrefixInfo.tokens;
  }
  const belowMinimum = estimatedPromptTokens < minimumCacheTokens;

  return {
    changed,
    userId,
    model,
    modelFamily,
    estimatedPromptTokens,
    totalPromptTokens,
    minimumCacheTokens,
    belowMinimum,
    cachePrefixHash: cachePrefixInfo.hash,
    cachePrefixSegments: cachePrefixInfo.segments,
    cacheTtl: ttl,
    autoBreakpoint,
    cacheReady: !changed && isCacheReady(body),
    reason: changed ? null : 'already_cache_ready',
  };
}

function normalizeModelName(value) {
  if (value == null) {
    return '';
  }
  return String(value).trim().toLowerCase();
}

function isClaudeLikeModel(model) {
  return /(?:claude|anthropic|opus|sonnet|haiku)/i.test(String(model || ''));
}

function getModelFamily(model) {
  const text = String(model || '').toLowerCase();
  if (/\bhaiku\b|haiku/.test(text)) return 'haiku';
  if (/\bsonnet\b|sonnet/.test(text)) return 'sonnet';
  if (/\bopus\b|opus/.test(text)) return 'opus';
  return 'unknown';
}

function getCacheMinimumTokens(model) {
  const text = String(model || '').toLowerCase();
  if (/mythos|opus[-_. ]?4[-_. ]?[567]\b|opus[-_. ]?4\.[567]\b/.test(text)) {
    return CACHE_MINIMUM_TOKENS.opus45Plus;
  }
  if (/haiku[-_. ]?4[-_. ]?5\b|haiku[-_. ]?4\.5\b/.test(text)) {
    return CACHE_MINIMUM_TOKENS.haiku45Plus;
  }
  const family = getModelFamily(text);
  return CACHE_MINIMUM_TOKENS[family] || CACHE_MINIMUM_TOKENS.unknown;
}

function estimateTokens(textOrChars) {
  const chars = typeof textOrChars === 'number' ? textOrChars : String(textOrChars ?? '').length;
  return Math.max(0, Math.ceil(chars / 4));
}

function estimatePromptTokens(body) {
  const segments = collectPromptSegments(body);
  return estimateTokens(segments.map((segment) => segment.text).join('\n\n'));
}

function estimateCacheControlledPrefixTokens(body) {
  return getCacheControlledPrefixInfo(body).tokens;
}

function getCacheControlledPrefixInfo(body) {
  const segments = collectPromptSegments(body);

  let prefix = '';
  let result = { tokens: 0, hash: null, segments: [] };
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    prefix = prefix ? `${prefix}\n\n${segment.text}` : segment.text;
    if (segment.hasCacheControl) {
      const tokens = estimateTokens(prefix);
      if (tokens >= result.tokens) {
        result = {
          tokens,
          hash: hashString(prefix),
          segments: buildSegmentFingerprints(segments.slice(0, index + 1)),
        };
      }
    }
  }
  return result;
}

function buildSegmentFingerprints(segments) {
  return segments.map((segment, index) => ({
    index,
    source: segment.source || `segment:${index}`,
    role: segment.role || null,
    chars: String(segment.text ?? '').length,
    tokens: estimateTokens(segment.text),
    hash: hashString(segment.text),
    hasCacheControl: Boolean(segment.hasCacheControl),
  }));
}

function hashString(value) {
  const text = String(value ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function ensureAutomaticCacheControlAtMinimum(body, minimumTokens, cacheControl) {
  const segments = collectPromptSegments(body, cacheControl);
  let prefix = '';
  let fallback = null;

  for (const segment of segments) {
    prefix = prefix ? `${prefix}\n\n${segment.text}` : segment.text;
    const tokens = estimateTokens(prefix);
    if (segment.canSetCacheControl && !segment.isCurrentOrAfterInput && tokens >= minimumTokens) {
      if (segment.hasCacheControl) {
        return { changed: false, reason: 'already_at_minimum', tokens };
      }
      segment.setCacheControl();
      return { changed: true, reason: 'auto_minimum_breakpoint', tokens };
    }
    if (segment.canSetCacheControl && !segment.isCurrentOrAfterInput) {
      fallback = { tokens };
    }
  }

  return {
    changed: false,
    reason: fallback ? 'no_stable_breakpoint_reaches_minimum' : 'no_stable_breakpoint_available',
    tokens: fallback?.tokens || 0,
  };
}

function collectPromptSegments(body, cacheControl = null) {
  const segments = [];
  appendPromptSegments(segments, body?.tools, false, false, cacheControl, 'tools', null);
  appendPromptSegments(segments, body?.system, false, false, cacheControl, 'system', 'system');
  if (Array.isArray(body?.messages)) {
    const currentInputIndex = findCurrentInputIndex(body.messages);
    body.messages.forEach((message, index) => {
      const inherited = Boolean(message?.cache_control || message?.content?.cache_control);
      const isCurrentOrAfterInput = currentInputIndex >= 0 && index >= currentInputIndex;
      const role = message?.role || 'unknown';
      const source = `message:${index}:${role}`;
      if (typeof message?.content === 'string') {
        segments.push({
          text: message.content,
          source,
          role,
          hasCacheControl: inherited,
          canSetCacheControl: Boolean(cacheControl),
          isCurrentOrAfterInput,
          setCacheControl: () => {
            message.content = [{ type: 'text', text: message.content, cache_control: { ...cacheControl } }];
          },
        });
        return;
      }
      appendPromptSegments(segments, message?.content, inherited, isCurrentOrAfterInput, cacheControl, source, role);
    });
  }
  return segments;
}

function findCurrentInputIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      return i;
    }
  }
  return -1;
}

function appendPromptSegments(
  segments,
  value,
  inheritedCacheControl = false,
  isCurrentOrAfterInput = false,
  cacheControl = null,
  source = 'unknown',
  role = null
) {
  if (value == null) {
    return;
  }
  if (typeof value === 'string') {
    segments.push({
      text: value,
      source,
      role,
      hasCacheControl: inheritedCacheControl,
      canSetCacheControl: false,
      isCurrentOrAfterInput,
      setCacheControl: () => {},
    });
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      appendPromptSegments(
        segments,
        value[index],
        inheritedCacheControl,
        isCurrentOrAfterInput,
        cacheControl,
        `${source}[${index}]`,
        role
      );
    }
    return;
  }
  if (typeof value === 'object') {
    const hasCacheControl = inheritedCacheControl || Boolean(value.cache_control);
    if (typeof value.text === 'string') {
      segments.push({
        text: value.text,
        source,
        role,
        hasCacheControl,
        canSetCacheControl: Boolean(cacheControl) && isCacheableContentPart(value),
        isCurrentOrAfterInput,
        setCacheControl: () => {
          if (!value.cache_control) {
            value.cache_control = { ...cacheControl };
          }
        },
      });
      return;
    }
    if (typeof value.content === 'string') {
      segments.push({
        text: value.content,
        source,
        role,
        hasCacheControl,
        canSetCacheControl: Boolean(cacheControl) && isCacheableContentPart(value),
        isCurrentOrAfterInput,
        setCacheControl: () => {
          if (!value.cache_control) {
            value.cache_control = { ...cacheControl };
          }
        },
      });
      return;
    }
    if (Array.isArray(value.content)) {
      appendPromptSegments(segments, value.content, hasCacheControl, isCurrentOrAfterInput, cacheControl, `${source}.content`, role);
      return;
    }
    segments.push({
      text: JSON.stringify(value),
      source,
      role,
      hasCacheControl,
      canSetCacheControl: Boolean(cacheControl) && isCacheableContentPart(value),
      isCurrentOrAfterInput,
      setCacheControl: () => {
        if (!value.cache_control) {
          value.cache_control = { ...cacheControl };
        }
      },
    });
  }
}

function isCacheReady(body) {
  return Boolean(body?.metadata?.user_id && hasAnyCacheControl(body));
}

function hasAnyCacheControl(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (value.cache_control) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasAnyCacheControl(item));
  }
  return Object.values(value).some((item) => hasAnyCacheControl(item));
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

function sanitizeTarget(href) {
  try {
    const url = new URL(href);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return String(href || '').split('?')[0];
  }
}

function getSelfUpdateStatus() {
  const source = findSelfUpdateSource();
  return {
    currentVersion: PLUGIN_VERSION,
    sourceFound: Boolean(source),
    sourceVersion: source?.version || null,
    updateAvailable: Boolean(source && compareVersions(source.version, PLUGIN_VERSION) > 0),
    restartRequired: false,
  };
}

function selfUpdateServerPlugin(options = {}) {
  const source = findSelfUpdateSource();
  if (!source) {
    throw new Error('No extension server-plugin source found.');
  }
  const shouldCopy = options.force || compareVersions(source.version, PLUGIN_VERSION) > 0 || source.version !== PLUGIN_VERSION;
  if (!shouldCopy) {
    return {
      copied: false,
      currentVersion: PLUGIN_VERSION,
      sourceVersion: source.version,
      restartRequired: false,
    };
  }

  const destination = path.resolve(__dirname);
  copyServerPluginFiles(source.dir, destination);
  return {
    copied: true,
    currentVersion: PLUGIN_VERSION,
    sourceVersion: source.version,
    restartRequired: true,
  };
}

function findSelfUpdateSource() {
  const root = process.cwd();
  const candidates = [
    path.resolve(root, 'data', 'default-user', 'extensions', 'claude1', 'server-plugin'),
    path.resolve(root, 'data', 'default-user', 'extensions', 'claude-cache-lens', 'server-plugin'),
    ...scanExtensionServerPluginDirs(path.resolve(root, 'data')),
  ];
  const unique = [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  const ownDir = path.resolve(__dirname);
  const matches = [];

  for (const candidate of unique) {
    if (candidate === ownDir || !fs.existsSync(candidate)) {
      continue;
    }
    const packageJson = readPackageJson(path.join(candidate, 'package.json'));
    if (packageJson?.name !== SERVER_PLUGIN_PACKAGE_NAME) {
      continue;
    }
    matches.push({
      dir: candidate,
      version: String(packageJson.version || '0.0.0'),
    });
  }

  matches.sort((a, b) => compareVersions(b.version, a.version));
  return matches[0] || null;
}

function scanExtensionServerPluginDirs(dataDir) {
  const result = [];
  for (const userDir of safeReadDir(dataDir)) {
    const extensionsDir = path.join(dataDir, userDir, 'extensions');
    for (const extensionDir of safeReadDir(extensionsDir)) {
      result.push(path.join(extensionsDir, extensionDir, 'server-plugin'));
    }
  }
  return result;
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readPackageJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function copyServerPluginFiles(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const name of ['index.js', 'index.cjs', 'package.json']) {
    const source = path.join(sourceDir, name);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing server plugin file: ${name}`);
    }
    fs.copyFileSync(source, path.join(destinationDir, name));
  }
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] > right[i] ? 1 : -1;
    }
  }
  return 0;
}

function parseVersion(value) {
  return String(value || '0.0.0')
    .split('.')
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0)
    .concat([0, 0, 0])
    .slice(0, 3);
}

module.exports = {
  init,
  exit,
  _private: {
    buildClaudeBlock,
    compareVersions,
    comparePrefixSegments,
    copyServerPluginFiles,
    guardState,
    getCacheControlledPrefixInfo,
    getGuardBlockReason,
    estimateCacheControlledPrefixTokens,
    estimatePromptTokens,
    getCacheMinimumTokens,
    getModelFamily,
    isClaudeLikeModel,
    normalizeClaudeSettings,
    patchClaudeCacheRequestBody,
    readClaudeConfig,
    shouldGuardBlock,
    updateConfigYaml,
  },
  info: {
    id: 'claude-cache-lens',
    name: 'Claude Cache Lens',
    description: 'Stores SillyTavern Claude prompt-cache diagnostics for Cache Lens.',
    version: PLUGIN_VERSION,
  },
};
