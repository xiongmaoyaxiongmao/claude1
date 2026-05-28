'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_ITEMS = 100;
const snapshots = [];

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

  console.log('[Claude Cache Lens] server plugin loaded');
  return Promise.resolve();
}

async function exit() {
  snapshots.length = 0;
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

module.exports = {
  init,
  exit,
  _private: {
    buildClaudeBlock,
    normalizeClaudeSettings,
    readClaudeConfig,
    updateConfigYaml,
  },
  info: {
    id: 'claude-cache-lens',
    name: 'Claude Cache Lens',
    description: 'Stores SillyTavern Claude prompt-cache diagnostics for Cache Lens.',
  },
};
