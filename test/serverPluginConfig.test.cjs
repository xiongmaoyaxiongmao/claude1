const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _private } = require('../server-plugin/index.cjs');

test('updates existing claude config block', () => {
  const original = [
    'port: 8000',
    'claude:',
    '  enableSystemPromptCache: false',
    '  cachingAtDepth: -1',
    '  extendedTTL: false',
    'listen: false',
    '',
  ].join('\n');

  const updated = _private.updateConfigYaml(original, {
    enableSystemPromptCache: true,
    cachingAtDepth: 2,
    extendedTTL: false,
  });

  assert.match(updated, /claude:\n  enableSystemPromptCache: true\n  cachingAtDepth: 2\n  extendedTTL: false\nlisten: false\n$/);
});

test('appends claude config block when missing', () => {
  const updated = _private.updateConfigYaml('port: 8000\n', {
    enableSystemPromptCache: true,
    cachingAtDepth: 4,
    extendedTTL: true,
  });

  assert.equal(updated, [
    'port: 8000',
    '',
    'claude:',
    '  enableSystemPromptCache: true',
    '  cachingAtDepth: 4',
    '  extendedTTL: true',
    '',
  ].join('\n'));
});

test('rejects invalid cache depth', () => {
  assert.throws(() => _private.normalizeClaudeSettings({ cachingAtDepth: -2 }), /cachingAtDepth/);
});

test('patches Claude native request body with metadata and cache control', () => {
  const body = {
    model: 'claude-opus-4-7',
    system: [{ type: 'text', text: 'stable system' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  };

  const result = _private.patchClaudeCacheRequestBody(body, {
    userId: 'money',
    settings: { cachingAtDepth: -1, extendedTTL: false },
  });

  assert.equal(result.changed, true);
  assert.deepEqual(body.metadata, { user_id: 'money' });
  assert.equal(body.cache_control, undefined);
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '5m' });
  assert.equal(result.minimumCacheTokens, 4096);
  assert.equal(result.estimatedPromptTokens, _private.estimateCacheControlledPrefixTokens(body));
  assert.equal(result.totalPromptTokens, _private.estimatePromptTokens(body));
  assert.equal(result.belowMinimum, true);
});

test('patches OpenAI-compatible Claude message content at selected depth', () => {
  const body = {
    model: 'claude-opus-4-7',
    messages: [
      { role: 'system', content: 'stable system' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ],
  };

  const result = _private.patchClaudeCacheRequestBody(body, {
    userId: 'stable user id',
    settings: { cachingAtDepth: 2, extendedTTL: false },
  });

  assert.equal(result.changed, true);
  assert.equal(body.metadata.user_id, 'stable-user-id');
  assert.equal(body.messages[0].content[0].cache_control.type, 'ephemeral');
  assert.equal(body.messages[1].content[0].cache_control.type, 'ephemeral');
});

test('patches Claude-family aliases without the claude prefix', () => {
  const body = {
    model: 'opus-4-7',
    messages: [
      { role: 'system', content: 'stable system' },
      { role: 'user', content: 'hello' },
    ],
  };

  const result = _private.patchClaudeCacheRequestBody(body, {
    userId: 'money',
    settings: { cachingAtDepth: -1, extendedTTL: false },
  });

  assert.equal(result.changed, true);
  assert.equal(result.model, 'opus-4-7');
  assert.equal(result.modelFamily, 'opus');
  assert.equal(result.minimumCacheTokens, 4096);
  assert.equal(body.metadata.user_id, 'money');
  assert.equal(body.messages[0].content[0].cache_control.type, 'ephemeral');
});

test('estimates cache-controlled prefix separately from total prompt', () => {
  const body = {
    model: 'claude-opus-4-7',
    system: 'tiny system',
    messages: [
      { role: 'user', content: 'older stable user text' },
      { role: 'assistant', content: 'older stable assistant text' },
      { role: 'user', content: 'current input '.repeat(1800) },
    ],
  };

  const result = _private.patchClaudeCacheRequestBody(body, {
    userId: 'money',
    settings: { cachingAtDepth: -1, extendedTTL: false },
  });

  assert.equal(result.changed, true);
  assert.equal(result.totalPromptTokens > result.estimatedPromptTokens, true);
  assert.equal(result.estimatedPromptTokens < result.minimumCacheTokens, true);
  assert.equal(result.belowMinimum, true);
  assert.equal(result.autoBreakpoint.reason, 'no_stable_breakpoint_reaches_minimum');
});

test('automatically adds a stable cache breakpoint when it reaches the minimum', () => {
  const body = {
    model: 'claude-opus-4-7',
    system: 'tiny system',
    messages: [
      { role: 'user', content: 'older stable user text '.repeat(900) },
      { role: 'assistant', content: 'older stable assistant text '.repeat(900) },
      { role: 'user', content: 'current input' },
    ],
  };

  const result = _private.patchClaudeCacheRequestBody(body, {
    userId: 'money',
    settings: { cachingAtDepth: -1, extendedTTL: false },
  });

  assert.equal(result.changed, true);
  assert.equal(result.belowMinimum, false);
  assert.equal(result.autoBreakpoint.reason, 'auto_minimum_breakpoint');
  assert.equal(body.messages[0].content[0].cache_control.type, 'ephemeral');
  assert.equal(typeof result.cachePrefixHash, 'string');
  assert.equal(result.cachePrefixHash, _private.getCacheControlledPrefixInfo(body).hash);
});

test('cache prefix hash changes when the stable prefix changes', () => {
  const first = {
    model: 'claude-opus-4-7',
    system: 'tiny system',
    messages: [
      { role: 'user', content: 'stable user text '.repeat(900) },
      { role: 'assistant', content: 'stable assistant text '.repeat(900) },
      { role: 'user', content: 'current input' },
    ],
  };
  const second = {
    model: 'claude-opus-4-7',
    system: 'tiny system changed',
    messages: [
      { role: 'user', content: 'stable user text '.repeat(900) },
      { role: 'assistant', content: 'stable assistant text '.repeat(900) },
      { role: 'user', content: 'current input' },
    ],
  };

  const firstResult = _private.patchClaudeCacheRequestBody(first, {
    userId: 'money',
    settings: { cachingAtDepth: -1, extendedTTL: false },
  });
  const secondResult = _private.patchClaudeCacheRequestBody(second, {
    userId: 'money',
    settings: { cachingAtDepth: -1, extendedTTL: false },
  });

  assert.notEqual(firstResult.cachePrefixHash, secondResult.cachePrefixHash);
});

test('reports the first changed cache prefix segment without prompt text', () => {
  const previous = [
    { source: 'system', role: 'system', chars: 12, tokens: 3, hash: 'same', hasCacheControl: false },
    {
      source: 'message:0:user',
      role: 'user',
      chars: 40,
      tokens: 10,
      hash: 'old',
      hasCacheControl: true,
      parts: [
        { index: 0, chars: 10, tokens: 3, hash: 'same' },
        { index: 1, chars: 20, tokens: 5, hash: 'old-inner' },
      ],
    },
  ];
  const current = [
    { source: 'system', role: 'system', chars: 12, tokens: 3, hash: 'same', hasCacheControl: false },
    {
      source: 'message:0:user',
      role: 'user',
      chars: 44,
      tokens: 11,
      hash: 'new',
      hasCacheControl: true,
      parts: [
        { index: 0, chars: 10, tokens: 3, hash: 'same' },
        { index: 1, chars: 24, tokens: 6, hash: 'new-inner' },
      ],
    },
  ];

  const diff = _private.comparePrefixSegments(previous, current);

  assert.equal(diff.index, 1);
  assert.equal(diff.reason, 'changed');
  assert.equal(diff.current.source, 'message:0:user');
  assert.equal(diff.innerDiff.index, 1);
  assert.equal(Object.hasOwn(diff.current, 'text'), false);
  assert.equal(Object.hasOwn(diff.innerDiff.current, 'text'), false);
});

test('reports multiple changed prefix segments and a useful diagnosis', () => {
  const previous = [
    { source: 'system[0]', role: 'system', chars: 10, tokens: 3, hash: 'old-system', hasCacheControl: true },
    { source: 'message:0:user', role: 'user', chars: 20, tokens: 5, hash: 'old-user', hasCacheControl: true },
  ];
  const current = [
    { source: 'system[0]', role: 'system', chars: 12, tokens: 3, hash: 'new-system', hasCacheControl: true },
    { source: 'message:0:user', role: 'user', chars: 22, tokens: 6, hash: 'new-user', hasCacheControl: true },
  ];

  const diffs = _private.comparePrefixSegmentsAll(previous, current);
  const diagnosis = _private.buildPrefixDiagnosis(
    { minimumCacheTokens: 4096, estimatedPromptTokens: 5000 },
    {
      prefixMismatch: true,
      prefixDiff: diffs[0],
      prefixDiffs: diffs,
    }
  );

  assert.equal(diffs.length, 2);
  assert.equal(diagnosis.status, 'prefix_changed');
  assert.equal(diagnosis.likelySource.includes('system prompt'), true);
  assert.equal(diagnosis.changedSegments.length, 2);
});

test('builds a labeled prefix segment report', () => {
  const previous = [
    { source: 'system[0]', role: 'system', chars: 10, tokens: 3, hash: 'same', hasCacheControl: true },
    { source: 'message:0:user', role: 'user', chars: 20, tokens: 5, hash: 'old', hasCacheControl: false },
  ];
  const current = [
    { source: 'system[0]', role: 'system', chars: 10, tokens: 3, hash: 'same', hasCacheControl: true },
    { source: 'message:0:user', role: 'user', chars: 30, tokens: 8, hash: 'new', hasCacheControl: false },
    { source: 'message:1:assistant', role: 'assistant', chars: 12, tokens: 3, hash: 'added', hasCacheControl: true },
  ];

  const report = _private.buildPrefixSegmentReport(previous, current);

  assert.deepEqual(report.map((item) => item.status), ['stable', 'changed', 'added']);
  assert.equal(report[1].deltaChars, 10);
  assert.equal(Object.hasOwn(report[1].current, 'text'), false);
});

test('finds a stable earlier cache breakpoint when the deepest prefix changes', () => {
  const previous = [
    { source: 'system[0]', tokens: 5000, hash: 'stable-system' },
    { source: 'message:8:user[0]', tokens: 9000, hash: 'old-deep' },
  ];
  const current = [
    { source: 'system[0]', tokens: 5000, hash: 'stable-system' },
    { source: 'message:10:user[0]', tokens: 9800, hash: 'new-deep' },
  ];

  const stable = _private.findStableCacheBreakpoint(previous, current, 4096);

  assert.equal(stable.source, 'system[0]');
  assert.equal(stable.tokens, 5000);
});

test('does not use the current user input as an automatic breakpoint before assistant prefill', () => {
  const body = {
    model: 'claude-opus-4-7',
    system: 'tiny system',
    messages: [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old reply' },
      { role: 'user', content: 'current input '.repeat(1800) },
      { role: 'assistant', content: '' },
    ],
  };

  const result = _private.patchClaudeCacheRequestBody(body, {
    userId: 'money',
    settings: { cachingAtDepth: -1, extendedTTL: false },
  });

  assert.equal(result.belowMinimum, true);
  assert.equal(result.autoBreakpoint.reason, 'no_stable_breakpoint_reaches_minimum');
  assert.equal(typeof body.messages[2].content, 'string');
});

test('treats already cache-ready Claude bodies as ready, not skipped', () => {
  const body = {
    model: 'claude-opus-4-7',
    metadata: { user_id: 'money' },
    messages: [
      {
        role: 'system',
        content: [{ type: 'text', text: 'stable system', cache_control: { type: 'ephemeral', ttl: '5m' } }],
      },
    ],
  };

  const result = _private.patchClaudeCacheRequestBody(body, {
    userId: 'money',
    settings: { cachingAtDepth: -1, extendedTTL: false },
  });

  assert.equal(result.changed, false);
  assert.equal(result.cacheReady, true);
  assert.equal(result.reason, 'already_cache_ready');
});

test('reports cache minimum threshold and prompt estimate', () => {
  const body = {
    model: 'claude-haiku-3-5',
    system: 'short stable prompt',
    messages: [{ role: 'user', content: 'hello' }],
  };

  const result = _private.patchClaudeCacheRequestBody(body, {
    userId: 'money',
    settings: { cachingAtDepth: -1, extendedTTL: false },
  });

  assert.equal(_private.getCacheMinimumTokens('claude-haiku-3-5'), 2048);
  assert.equal(_private.getCacheMinimumTokens('claude-haiku-4-5'), 4096);
  assert.equal(_private.getCacheMinimumTokens('claude-sonnet-4-6'), 1024);
  assert.equal(result.modelFamily, 'haiku');
  assert.equal(result.minimumCacheTokens, 2048);
  assert.equal(result.belowMinimum, true);
  assert.equal(result.estimatedPromptTokens > 0, true);
});

test('does not patch non-Claude chat completion bodies', () => {
  const body = {
    model: 'gpt-4.1',
    messages: [{ role: 'user', content: 'hello' }],
  };

  const result = _private.patchClaudeCacheRequestBody(body, {
    settings: { cachingAtDepth: 2, extendedTTL: false },
  });

  assert.equal(result.changed, false);
  assert.equal(result.reason, 'non_claude_model');
  assert.equal(body.metadata, undefined);
});

test('guard blocks only Claude requests below the cache minimum', () => {
  assert.equal(_private.shouldGuardBlock({
    minimumCacheTokens: 4096,
    belowMinimum: true,
  }), true);
  assert.equal(_private.shouldGuardBlock({
    minimumCacheTokens: 4096,
    belowMinimum: false,
  }), false);
  assert.equal(_private.shouldGuardBlock({
    belowMinimum: true,
  }), false);
});

test('guard blocks changed or expired Claude cache prefixes', () => {
  assert.equal(_private.shouldGuardBlock({
    minimumCacheTokens: 4096,
    belowMinimum: false,
    prefixMismatch: true,
  }), true);
  assert.equal(_private.shouldGuardBlock({
    minimumCacheTokens: 4096,
    belowMinimum: false,
    prefixExpired: true,
  }), true);
});

test('guard blocks missing Claude cache baseline by default', () => {
  assert.equal(_private.shouldGuardBlock({
    minimumCacheTokens: 4096,
    belowMinimum: false,
    missingPreviousPrefix: true,
  }), true);
});

test('one-shot baseline write allowance bypasses prefix replacement blocks', () => {
  const original = _private.guardState.allowBaselineWriteOnce;
  try {
    _private.guardState.allowBaselineWriteOnce = true;
    assert.equal(_private.getGuardBlockReason({
      minimumCacheTokens: 4096,
      belowMinimum: false,
      prefixExpired: true,
    }), null);
    assert.equal(_private.getGuardBlockReason({
      minimumCacheTokens: 4096,
      belowMinimum: false,
      prefixMismatch: true,
    }), null);
    assert.equal(_private.getGuardBlockReason({
      minimumCacheTokens: 4096,
      belowMinimum: false,
      missingPreviousPrefix: true,
    }), null);
    assert.equal(_private.getGuardBlockReason({
      minimumCacheTokens: 4096,
      belowMinimum: true,
      prefixExpired: true,
    }), 'below_minimum');
  } finally {
    _private.guardState.allowBaselineWriteOnce = original;
  }
});

test('compares semantic versions for server plugin self update', () => {
  assert.equal(_private.compareVersions('0.1.26', '0.1.25'), 1);
  assert.equal(_private.compareVersions('0.1.26', '0.1.26'), 0);
  assert.equal(_private.compareVersions('0.1.9', '0.1.26'), -1);
});

test('copies only server plugin entry files during self update', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-server-plugin-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  try {
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(source, 'index.cjs'), "'use strict';\n");
    fs.writeFileSync(path.join(source, 'package.json'), '{"name":"claude-cache-lens-server-plugin"}\n');
    fs.writeFileSync(path.join(source, 'ignore.txt'), 'do not copy\n');

    _private.copyServerPluginFiles(source, destination);

    assert.equal(fs.readFileSync(path.join(destination, 'index.js'), 'utf8'), 'module.exports = {};\n');
    assert.equal(fs.existsSync(path.join(destination, 'index.cjs')), true);
    assert.equal(fs.existsSync(path.join(destination, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(destination, 'ignore.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
