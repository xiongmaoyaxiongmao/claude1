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
  assert.deepEqual(body.cache_control, { type: 'ephemeral', ttl: '5m' });
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '5m' });
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
  assert.equal(body.metadata.user_id, 'money');
  assert.equal(body.messages[0].content[0].cache_control.type, 'ephemeral');
});

test('treats already cache-ready Claude bodies as ready, not skipped', () => {
  const body = {
    model: 'claude-opus-4-7',
    metadata: { user_id: 'money' },
    cache_control: { type: 'ephemeral', ttl: '5m' },
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

test('compares semantic versions for server plugin self update', () => {
  assert.equal(_private.compareVersions('0.1.12', '0.1.11'), 1);
  assert.equal(_private.compareVersions('0.1.12', '0.1.12'), 0);
  assert.equal(_private.compareVersions('0.1.9', '0.1.12'), -1);
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
