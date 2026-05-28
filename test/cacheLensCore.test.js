import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeSnapshot,
  analyzeTextForRisks,
  createSnapshot,
  hashString,
} from '../src/cacheLensCore.js';

test('hashString is deterministic', () => {
  assert.equal(hashString('same prompt'), hashString('same prompt'));
  assert.notEqual(hashString('same prompt'), hashString('other prompt'));
});

test('detects dynamic macros as high risk', () => {
  const result = analyzeTextForRisks('Use {{random}} and {{time}} here.');
  assert.equal(result.hasHighRisk, true);
  assert.equal(result.sources[0].source, 'Dynamic Macro');
});

test('recommends depth 2 when current depth 2 matches previous full prefix', () => {
  const previous = createSnapshot({
    contextSize: 4096,
    context: { chatCompletionSource: 'Claude', model: 'claude-sonnet-4-5' },
    chat: [
      { role: 'system', content: 'Long stable system prompt '.repeat(80) },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'tell me more' },
    ],
    now: 1,
  });
  const current = createSnapshot({
    contextSize: 4096,
    context: { chatCompletionSource: 'Claude', model: 'claude-sonnet-4-5' },
    chat: [
      { role: 'system', content: 'Long stable system prompt '.repeat(80) },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'tell me more' },
      { role: 'assistant', content: 'details' },
      { role: 'user', content: 'continue' },
    ],
    now: 2,
  });

  const analysis = analyzeSnapshot(current, previous);
  assert.equal(analysis.recommendations.cachingAtDepth, 2);
  assert.equal(analysis.risk, 'Good');
});

test('dynamic macro in stable prefix breaks history caching recommendation', () => {
  const previous = createSnapshot({
    contextSize: 4096,
    context: { chatCompletionSource: 'Claude' },
    chat: [
      { role: 'system', content: 'Today is {{date}}. '.repeat(80) },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
    now: 1,
  });
  const current = createSnapshot({
    contextSize: 4096,
    context: { chatCompletionSource: 'Claude' },
    chat: [
      { role: 'system', content: 'Today is {{date}}. '.repeat(80) },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' },
    ],
    now: 2,
  });

  const analysis = analyzeSnapshot(current, previous);
  assert.equal(analysis.risk, 'Broken');
  assert.equal(analysis.recommendations.cachingAtDepth, -1);
});
