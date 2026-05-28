export const SNAPSHOT_VERSION = 1;
export const DEPTH_CANDIDATES = [0, 1, 2, 4, 8];

const DYNAMIC_MACROS = new Set([
  'random',
  'roll',
  'time',
  'date',
  'weekday',
  'datetime',
  'currenttime',
  'currentdate',
  'idle_duration',
  'lastmessage',
  'input',
]);

const SOURCE_RULES = [
  { source: 'World Info', pattern: /\b(world\s*info|lorebook|wi entry|worldbook)\b/i },
  { source: 'Summary', pattern: /\b(summary|summarized|summarisation|summarization)\b/i },
  { source: 'Vectorization', pattern: /\b(vector|embedding|data bank|databank|retriev(?:e|al|ed))\b/i },
  { source: 'Web Search', pattern: /\b(web search|search result|browser result|rss feed)\b/i },
  { source: 'Time', pattern: /\b(current date|current time|timestamp|today is|now is)\b/i },
];

export function estimateTokens(textOrChars) {
  const chars = typeof textOrChars === 'number' ? textOrChars : String(textOrChars ?? '').length;
  return Math.max(0, Math.ceil(chars / 4));
}

export function hashString(value) {
  const text = String(value ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function analyzeTextForRisks(text) {
  const value = String(text ?? '');
  const sources = [];
  const macros = [];
  const macroRegex = /\{\{\s*([a-zA-Z0-9_.-]+)[^{}]*\}\}/g;
  let match;

  while ((match = macroRegex.exec(value)) !== null) {
    const macroName = String(match[1] || '').toLowerCase();
    if (DYNAMIC_MACROS.has(macroName)) {
      macros.push(match[0]);
    }
  }

  if (macros.length > 0) {
    sources.push({
      source: 'Dynamic Macro',
      severity: 'high',
      detail: unique(macros).slice(0, 5).join(', '),
    });
  }

  for (const rule of SOURCE_RULES) {
    if (rule.pattern.test(value)) {
      sources.push({
        source: rule.source,
        severity: rule.source === 'Time' ? 'high' : 'medium',
        detail: 'matched prompt text',
      });
    }
  }

  return {
    hasHighRisk: sources.some((item) => item.severity === 'high'),
    hasMediumRisk: sources.some((item) => item.severity === 'medium'),
    sources,
  };
}

export function createSnapshot({ chat = [], contextSize = 0, type = 'normal', context = {}, now = Date.now() } = {}) {
  const messages = Array.isArray(chat) ? chat.map((message, index) => describeMessage(message, index)) : [];
  const metadataText = collectMetadataText(context);
  const metadataRisk = analyzeTextForRisks(metadataText);
  const depthFingerprints = {};

  for (const depth of DEPTH_CANDIDATES) {
    const cutoff = Math.max(0, messages.length - depth);
    const prefixText = messages.slice(0, cutoff).map((message) => message.normalized).join('\n\n');
    depthFingerprints[String(depth)] = {
      depth,
      hash: hashString(prefixText),
      messageCount: cutoff,
      chars: prefixText.length,
      estimatedTokens: estimateTokens(prefixText),
      highRiskSources: messages
        .slice(0, cutoff)
        .flatMap((message) => message.risks.sources)
        .filter((risk) => risk.severity === 'high')
        .map((risk) => risk.source),
    };
  }

  const detectedSources = summarizeSources([
    ...messages.flatMap((message) => message.risks.sources),
    ...metadataRisk.sources,
    ...(messages.length > 0 ? [{ source: 'Current Input', severity: 'high', detail: 'last chat item changes every turn' }] : []),
  ]);

  return {
    version: SNAPSHOT_VERSION,
    capturedAt: new Date(now).toISOString(),
    type,
    contextSize: Number(contextSize) || 0,
    estimatedContextTokens: Number(contextSize) || estimateTokens(messages.map((message) => message.normalized).join('\n\n')),
    chatLength: messages.length,
    api: getApiMetadata(context),
    character: getCharacterMetadata(context),
    messages,
    metadataHash: hashString(metadataText),
    metadataRisk,
    detectedSources,
    depthFingerprints,
  };
}

export function analyzeSnapshot(snapshot, previousSnapshot = null) {
  const previousHashes = new Map();
  if (previousSnapshot?.depthFingerprints) {
    for (const fingerprint of Object.values(previousSnapshot.depthFingerprints)) {
      previousHashes.set(fingerprint.hash, fingerprint.depth);
    }
  }

  const depthMatches = DEPTH_CANDIDATES.map((depth) => {
    const fingerprint = snapshot.depthFingerprints[String(depth)];
    return {
      depth,
      matchesPreviousDepth: previousHashes.has(fingerprint?.hash),
      previousDepth: previousHashes.get(fingerprint?.hash) ?? null,
      highRiskSources: unique(fingerprint?.highRiskSources ?? []),
      estimatedTokens: fingerprint?.estimatedTokens ?? 0,
      messageCount: fingerprint?.messageCount ?? 0,
    };
  });

  const stableDepth = pickStableDepth(depthMatches);
  const prefixDiff = diffSnapshots(snapshot, previousSnapshot);
  const sourceNames = Object.keys(snapshot.detectedSources);
  const hasDynamicMacro = Boolean(snapshot.detectedSources['Dynamic Macro']);
  const hasCurrentInputOnly = sourceNames.every((source) => source === 'Current Input');
  const isShortPrompt = (snapshot.estimatedContextTokens || 0) > 0 && snapshot.estimatedContextTokens < 1024;
  const apiMode = classifyApi(snapshot.api);
  const claudeLike = apiMode !== 'unknown';

  const recommendedDepth = decideDepth({
    stableDepth,
    depthMatches,
    hasDynamicMacro,
    hasCurrentInputOnly,
    previousSnapshot,
    chatLength: snapshot.chatLength,
  });

  const reasons = [];
  if (!claudeLike) {
    reasons.push('当前 API 信息不像 Claude/Anthropic；只能做结构诊断。');
  } else if (apiMode === 'claude_compatible') {
    reasons.push('当前像是 OpenAI-compatible 的 Claude 模型；结构诊断可用，真实缓存取决于中转是否支持 Claude prompt cache。');
  }
  if (isShortPrompt) {
    reasons.push('估算上下文低于 1024 tokens，供应商侧缓存可能不会生效。');
  }
  if (!previousSnapshot) {
    reasons.push('还没有上一轮快照，下一次请求后才能判断前缀是否稳定。');
  }
  if (hasDynamicMacro) {
    reasons.push('检测到动态宏，放在缓存前缀内会导致 miss。');
  }
  if (prefixDiff?.firstChangedIndex != null) {
    reasons.push(`和上一轮相比，第 ${prefixDiff.firstChangedIndex + 1} 个消息片段开始变化。`);
  }
  if (stableDepth != null) {
    reasons.push(`当前 depth=${stableDepth} 的前缀能匹配上一轮缓存候选。`);
  }
  if (recommendedDepth === -1) {
    reasons.push('建议暂时关闭 history caching，只保留 system prompt cache。');
  }

  const risk = classifyRisk({
    stableDepth,
    recommendedDepth,
    hasDynamicMacro,
    hasCurrentInputOnly,
    previousSnapshot,
    isShortPrompt,
  });

  return {
    risk,
    depthMatches,
    prefixDiff,
    reasons,
    apiMode,
    recommendations: {
      enableSystemPromptCache: true,
      cachingAtDepth: recommendedDepth,
      extendedTTL: shouldUseExtendedTtl({ stableDepth, snapshot, previousSnapshot }),
    },
  };
}

export function summarizeHistory(snapshots = []) {
  const items = Array.isArray(snapshots) ? snapshots : [];
  const cacheReadTokens = sumUsage(items, 'cache_read_input_tokens');
  const cacheCreationTokens = sumUsage(items, 'cache_creation_input_tokens');
  const inputTokens = sumUsage(items, 'input_tokens');
  const last = items.at(-1) ?? null;
  return {
    count: items.length,
    lastCapturedAt: last?.capturedAt ?? null,
    cacheReadTokens,
    cacheCreationTokens,
    inputTokens,
    estimatedSavedInputTokens: cacheReadTokens,
  };
}

function describeMessage(message, index) {
  const role = getMessageRole(message);
  const name = stringValue(message?.name || message?.extra?.name || message?.character || role);
  const content = extractMessageContent(message);
  const sourceRisk = analyzeTextForRisks(`${name}\n${content}`);
  const normalized = `${role}:${name}\n${content}`.trim();
  return {
    index,
    role,
    name,
    chars: content.length,
    estimatedTokens: estimateTokens(content),
    contentHash: hashString(content),
    normalizedHash: hashString(normalized),
    normalized,
    preview: content.replace(/\s+/g, ' ').slice(0, 120),
    risks: sourceRisk,
  };
}

function extractMessageContent(message) {
  if (message == null) {
    return '';
  }
  if (typeof message === 'string') {
    return message;
  }
  if (typeof message.mes === 'string') {
    return message.mes;
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content.map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item?.text === 'string') return item.text;
      if (typeof item?.content === 'string') return item.content;
      return stableJson(item);
    }).join('\n');
  }
  if (typeof message.text === 'string') {
    return message.text;
  }
  return stableJson(message);
}

function getMessageRole(message) {
  if (typeof message?.role === 'string') {
    return message.role;
  }
  if (message?.is_system) {
    return 'system';
  }
  if (message?.is_user) {
    return 'user';
  }
  if (message?.force_avatar === 'system') {
    return 'system';
  }
  return 'assistant';
}

function collectMetadataText(context) {
  const parts = [];
  const character = getCharacterMetadata(context);
  const api = getApiMetadata(context);
  parts.push(stableJson(character));
  parts.push(stableJson(api));
  for (const key of ['systemPrompt', 'nai_settings', 'power_user', 'chatCompletionSettings', 'extensionSettings']) {
    if (context && Object.hasOwn(context, key)) {
      parts.push(stableJson(context[key]).slice(0, 4000));
    }
  }
  return parts.join('\n');
}

function getApiMetadata(context) {
  const oai = context?.oai_settings || {};
  const chatSettings = context?.chatCompletionSettings || {};
  const settings = context?.settings || {};
  const modelCandidates = [
    context?.chatCompletionModel,
    context?.model,
    context?.selectedModel,
    context?.modelId,
    context?.customModel,
    context?.custom_model,
    oai.model,
    oai.custom_model,
    oai.chat_completion_model,
    oai.openai_model,
    oai.reverse_proxy_model,
    chatSettings.model,
    chatSettings.custom_model,
    chatSettings.chat_completion_model,
    settings.model,
    settings.custom_model,
  ].map(stringValue).filter(Boolean);

  return {
    mainApi: stringValue(context?.mainApi || context?.main_api || settings.main_api),
    source: stringValue(context?.chatCompletionSource || context?.chat_completion_source || oai.chat_completion_source || chatSettings.source),
    model: modelCandidates[0] || '',
    modelCandidates,
    endpoint: stringValue(oai.custom_url || oai.reverse_proxy || chatSettings.custom_url || context?.custom_url),
    preset: stringValue(context?.preset?.name || context?.presetName || settings.preset),
  };
}

function getCharacterMetadata(context) {
  const character = Array.isArray(context?.characters) ? context.characters[context.characterId] : null;
  return {
    id: context?.characterId ?? null,
    name: stringValue(character?.name || context?.name2 || context?.character?.name),
    groupId: stringValue(context?.groupId),
  };
}

function summarizeSources(sources) {
  const summary = {};
  for (const item of sources) {
    if (!item?.source) continue;
    if (!summary[item.source]) {
      summary[item.source] = {
        count: 0,
        severity: item.severity || 'medium',
        examples: [],
      };
    }
    summary[item.source].count += 1;
    if (item.severity === 'high') {
      summary[item.source].severity = 'high';
    }
    if (item.detail && summary[item.source].examples.length < 3) {
      summary[item.source].examples.push(item.detail);
    }
  }
  return summary;
}

function pickStableDepth(depthMatches) {
  const preferred = [2, 4, 8, 1, 0];
  for (const depth of preferred) {
    const match = depthMatches.find((item) => item.depth === depth);
    if (match?.matchesPreviousDepth && match.highRiskSources.length === 0 && match.estimatedTokens >= 256) {
      return depth;
    }
  }
  return null;
}

function decideDepth({ stableDepth, depthMatches, hasDynamicMacro, hasCurrentInputOnly, previousSnapshot, chatLength }) {
  if (stableDepth != null) {
    return stableDepth;
  }
  const depthTwo = depthMatches.find((item) => item.depth === 2);
  if (!previousSnapshot) {
    return chatLength >= 3 && !hasDynamicMacro ? 2 : -1;
  }
  if (hasDynamicMacro && !hasCurrentInputOnly) {
    return -1;
  }
  if (depthTwo && depthTwo.highRiskSources.length === 0 && chatLength >= 4) {
    return 2;
  }
  return -1;
}

function classifyRisk({ stableDepth, recommendedDepth, hasDynamicMacro, hasCurrentInputOnly, previousSnapshot, isShortPrompt }) {
  if (hasDynamicMacro && !hasCurrentInputOnly) {
    return 'Broken';
  }
  if (previousSnapshot && stableDepth == null && recommendedDepth === -1) {
    return 'Broken';
  }
  if (stableDepth != null && !isShortPrompt) {
    return 'Good';
  }
  return 'Risky';
}

function shouldUseExtendedTtl({ stableDepth, snapshot, previousSnapshot }) {
  if (stableDepth == null || !previousSnapshot) {
    return false;
  }
  const estimatedTokens = snapshot.depthFingerprints[String(stableDepth)]?.estimatedTokens ?? 0;
  return estimatedTokens >= 4000;
}

function diffSnapshots(snapshot, previousSnapshot) {
  if (!previousSnapshot?.messages) {
    return null;
  }
  const maxLength = Math.max(snapshot.messages.length, previousSnapshot.messages.length);
  for (let index = 0; index < maxLength; index += 1) {
    const current = snapshot.messages[index];
    const previous = previousSnapshot.messages[index];
    if (!current || !previous) {
      return {
        firstChangedIndex: index,
        previousPreview: previous?.preview ?? '',
        currentPreview: current?.preview ?? '',
        kind: current ? 'added' : 'removed',
      };
    }
    if (current.role !== previous.role || current.name !== previous.name || current.contentHash !== previous.contentHash) {
      return {
        firstChangedIndex: index,
        previousPreview: previous.preview,
        currentPreview: current.preview,
        kind: 'changed',
      };
    }
  }
  return {
    firstChangedIndex: null,
    kind: 'unchanged',
  };
}

function classifyApi(api) {
  const text = [
    api?.mainApi,
    api?.source,
    api?.model,
    api?.endpoint,
    ...(api?.modelCandidates || []),
  ].join(' ').toLowerCase();
  if (!text.trim()) {
    return 'unknown';
  }
  if (/anthropic/.test(text)) {
    return 'anthropic_native';
  }
  if (/claude/.test(text)) {
    return 'claude_compatible';
  }
  return 'unknown';
}

function sumUsage(items, key) {
  return items.reduce((total, item) => total + Number(item?.usage?.[key] || 0), 0);
}

function stableJson(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, function replacer(key, item) {
    if (typeof item === 'function') {
      return `[Function ${item.name || 'anonymous'}]`;
    }
    if (typeof item === 'object' && item !== null) {
      if (seen.has(item)) {
        return '[Circular]';
      }
      seen.add(item);
      if (!Array.isArray(item)) {
        return Object.keys(item).sort().reduce((result, objectKey) => {
          result[objectKey] = item[objectKey];
          return result;
        }, {});
      }
    }
    return item;
  }) || '';
}

function stringValue(value) {
  return value == null ? '' : String(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
