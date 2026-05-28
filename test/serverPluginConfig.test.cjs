const test = require('node:test');
const assert = require('node:assert/strict');

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
