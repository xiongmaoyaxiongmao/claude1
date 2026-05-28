import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeSnapshot,
  analyzeTextForRisks,
  createSnapshot,
  hashString,
  getCacheMinimumTokens,
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

test('recognizes OpenAI-compatible custom Claude models', () => {
  const snapshot = createSnapshot({
    contextSize: 4096,
    context: {
      mainApi: 'openai',
      oai_settings: {
        chat_completion_source: 'custom',
        custom_model: 'claude-opus-4-7',
        custom_url: 'https://example.com/v1',
      },
    },
    chat: [
      { role: 'system', content: 'Stable system prompt '.repeat(80) },
      { role: 'user', content: 'hello' },
    ],
  });

  const analysis = analyzeSnapshot(snapshot, null);
  assert.equal(analysis.apiMode, 'claude_compatible');
  assert.equal(analysis.reasons.some((reason) => reason.includes('不像 Claude')), false);
});

test('recognizes Claude-family aliases and model-specific cache thresholds', () => {
  const snapshot = createSnapshot({
    contextSize: 1500,
    context: {
      mainApi: 'openai',
      oai_settings: {
        chat_completion_source: 'custom',
        custom_model: 'opus-4-7',
      },
    },
    chat: [
      { role: 'system', content: 'Stable system prompt '.repeat(80) },
      { role: 'user', content: 'hello' },
    ],
  });

  const analysis = analyzeSnapshot(snapshot, null);
  assert.equal(analysis.apiMode, 'claude_compatible');
  assert.equal(analysis.modelFamily, 'opus');
  assert.equal(analysis.cacheMinimumTokens, 4096);
  assert.equal(analysis.reasons.some((reason) => reason.includes('不像 Claude')), false);
});

test('uses Haiku minimum cache threshold for short prompt warning', () => {
  const snapshot = createSnapshot({
    contextSize: 1500,
    context: {
      chatCompletionSource: 'Claude',
      model: 'claude-haiku-3-5',
    },
    chat: [
      { role: 'system', content: 'Stable system prompt '.repeat(80) },
      { role: 'user', content: 'hello' },
    ],
  });

  const analysis = analyzeSnapshot(snapshot, null);
  assert.equal(getCacheMinimumTokens('claude-haiku-3-5'), 2048);
  assert.equal(analysis.cacheMinimumTokens, 2048);
  assert.equal(analysis.reasons.some((reason) => reason.includes('2048 tokens')), true);
});

test('uses current Opus 4.7 cache threshold', () => {
  assert.equal(getCacheMinimumTokens('claude-opus-4-7'), 4096);
  assert.equal(getCacheMinimumTokens('claude-opus-4.6'), 4096);
  assert.equal(getCacheMinimumTokens('claude-opus-4-1'), 1024);
});
