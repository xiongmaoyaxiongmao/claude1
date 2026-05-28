import {
  analyzeSnapshot,
  createSnapshot,
  summarizeHistory,
} from './src/cacheLensCore.js';

const MODULE_NAME = 'claude_cache_lens';
const LAST_SNAPSHOT_KEY = `${MODULE_NAME}:last_snapshot`;
const HISTORY_KEY = `${MODULE_NAME}:history`;

const defaultSettings = Object.freeze({
  enabled: true,
  sendSnapshotsToServerPlugin: false,
  gatewayUrl: '',
  maxStoredSnapshots: 20,
});

let initialized = false;
let eventsBound = false;
let importedGetContext = null;
let contextImportAttempted = false;
let latestState = {
  snapshot: null,
  analysis: null,
  gatewaySummary: null,
};

globalThis.claudeCacheLensInterceptor = async function claudeCacheLensInterceptor(chat, contextSize, abort, type) {
  void abort;
  const settings = getSettings();
  if (!settings.enabled) {
    return;
  }

  const context = getContextSafe();
  const previousSnapshot = readJson(LAST_SNAPSHOT_KEY);
  const snapshot = createSnapshot({
    chat: Array.isArray(chat) ? chat : [],
    contextSize,
    type,
    context,
  });
  const analysis = analyzeSnapshot(snapshot, previousSnapshot);

  latestState = {
    ...latestState,
    snapshot,
    analysis,
  };

  writeJson(LAST_SNAPSHOT_KEY, snapshot);
  appendHistory({ snapshot, analysis }, settings.maxStoredSnapshots);

  if (settings.sendSnapshotsToServerPlugin) {
    postToServerPlugin({ snapshot, analysis }).catch(() => {});
  }

  renderPanel();
};

export function onActivate() {
  init();
}

export async function onClean() {
  localStorage.removeItem(LAST_SNAPSHOT_KEY);
  localStorage.removeItem(HISTORY_KEY);
}

queueMicrotask(() => {
  init().catch((error) => console.error('[Claude Cache Lens] init failed:', error));
});

async function init() {
  await loadContextModule();

  if (initialized && eventsBound) {
    return;
  }

  if (!mountPanel()) {
    setTimeout(() => init().catch(() => {}), 250);
    return;
  }

  initialized = true;
  ensureSettings();

  const context = getContextSafe();
  if (context && !eventsBound) {
    bindEvents(context);
    eventsBound = true;
  } else if (!eventsBound) {
    setTimeout(() => init().catch(() => {}), 500);
  }

  latestState.snapshot = readJson(LAST_SNAPSHOT_KEY);
  latestState.analysis = latestState.snapshot ? analyzeSnapshot(latestState.snapshot, null) : null;
  renderPanel();
}

function mountPanel() {
  if (document.getElementById('claude-cache-lens-panel')) {
    return true;
  }
  const target = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
  if (!target) {
    return false;
  }
  const wrapper = document.createElement('div');
  wrapper.id = 'claude-cache-lens-panel';
  wrapper.className = 'claude-cache-lens inline-drawer';
  wrapper.innerHTML = `
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Claude Cache Lens</b>
      <span id="ccl_status_pill" class="ccl-pill ccl-pill-muted">Idle</span>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content ccl-content">
      <div class="ccl-toolbar">
        <label class="checkbox_label ccl-checkbox">
          <input id="ccl_enabled" type="checkbox">
          <span>Observe</span>
        </label>
        <button id="ccl_refresh" class="menu_button" type="button" title="Refresh">
          <i class="fa-solid fa-rotate-right"></i>
        </button>
        <button id="ccl_export" class="menu_button" type="button" title="Export diagnostics">
          <i class="fa-solid fa-file-export"></i>
        </button>
        <button id="ccl_clear" class="menu_button" type="button" title="Clear local diagnostics">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>

      <div class="ccl-grid" aria-live="polite">
        <div class="ccl-metric">
          <span class="ccl-label">System Cache</span>
          <strong id="ccl_system_cache">-</strong>
        </div>
        <div class="ccl-metric">
          <span class="ccl-label">History Depth</span>
          <strong id="ccl_depth">-</strong>
        </div>
        <div class="ccl-metric">
          <span class="ccl-label">Extended TTL</span>
          <strong id="ccl_ttl">-</strong>
        </div>
        <div class="ccl-metric">
          <span class="ccl-label">Snapshots</span>
          <strong id="ccl_snapshots">0</strong>
        </div>
      </div>

      <div class="ccl-section">
        <div class="ccl-section-title">Risk Sources</div>
        <div id="ccl_sources" class="ccl-chips"></div>
      </div>

      <div class="ccl-section">
        <div class="ccl-section-title">Prefix Diff</div>
        <div id="ccl_diff" class="ccl-note">No snapshot yet.</div>
      </div>

      <div class="ccl-section">
        <div class="ccl-section-title">Reasons</div>
        <ul id="ccl_reasons" class="ccl-list"></ul>
      </div>

      <div class="ccl-gateway-row">
        <input id="ccl_gateway_url" class="text_pole" type="url" placeholder="http://127.0.0.1:8787">
        <button id="ccl_gateway_ping" class="menu_button" type="button" title="Read gateway usage">
          <i class="fa-solid fa-signal"></i>
        </button>
      </div>
      <div id="ccl_gateway_summary" class="ccl-note"></div>
    </div>
  `;
  target.appendChild(wrapper);
  hydrateControls();
  return true;
}

function bindEvents(context) {
  const panel = document.getElementById('claude-cache-lens-panel');
  if (!panel) {
    return;
  }
  panel.querySelector('#ccl_enabled')?.addEventListener('change', (event) => {
    const settings = getSettings();
    settings.enabled = Boolean(event.target.checked);
    saveSettings();
  });
  panel.querySelector('#ccl_gateway_url')?.addEventListener('change', (event) => {
    const settings = getSettings();
    settings.gatewayUrl = event.target.value.trim();
    saveSettings();
  });
  panel.querySelector('#ccl_refresh')?.addEventListener('click', () => renderPanel());
  panel.querySelector('#ccl_clear')?.addEventListener('click', () => {
    localStorage.removeItem(LAST_SNAPSHOT_KEY);
    localStorage.removeItem(HISTORY_KEY);
    latestState = { snapshot: null, analysis: null, gatewaySummary: null };
    renderPanel();
  });
  panel.querySelector('#ccl_export')?.addEventListener('click', exportDiagnostics);
  panel.querySelector('#ccl_gateway_ping')?.addEventListener('click', readGatewayUsage);

  const events = context.event_types || {};
  const eventSource = context.eventSource;
  for (const eventName of [
    events.CHAT_CHANGED,
    events.PRESET_CHANGED,
    events.MAIN_API_CHANGED,
    events.CHATCOMPLETION_SOURCE_CHANGED,
    events.CHATCOMPLETION_MODEL_CHANGED,
    events.WORLDINFO_SETTINGS_UPDATED,
  ].filter(Boolean)) {
    eventSource?.on?.(eventName, () => renderPanel());
  }
}

function hydrateControls() {
  const settings = getSettings();
  const enabled = document.getElementById('ccl_enabled');
  const gatewayUrl = document.getElementById('ccl_gateway_url');
  if (enabled) enabled.checked = Boolean(settings.enabled);
  if (gatewayUrl) gatewayUrl.value = settings.gatewayUrl || '';
}

function renderPanel() {
  const snapshot = latestState.snapshot || readJson(LAST_SNAPSHOT_KEY);
  const history = readJson(HISTORY_KEY) || [];
  const previous = history.length > 1 ? history[history.length - 2]?.snapshot : null;
  const analysis = latestState.analysis || (snapshot ? analyzeSnapshot(snapshot, previous) : null);
  const summary = summarizeHistory(history.map((entry) => entry.snapshot));

  setText('ccl_snapshots', String(history.length || summary.count || 0));
  setText('ccl_system_cache', analysis?.recommendations.enableSystemPromptCache ? 'On' : '-');
  setText('ccl_depth', formatDepth(analysis?.recommendations.cachingAtDepth));
  setText('ccl_ttl', analysis?.recommendations.extendedTTL ? '1h' : '5m');
  renderStatus(analysis?.risk || 'Idle');
  renderSources(snapshot?.detectedSources || {});
  renderDiff(analysis?.prefixDiff);
  renderReasons(analysis?.reasons || []);
  renderGatewaySummary(latestState.gatewaySummary);
  hydrateControls();
}

function renderStatus(risk) {
  const pill = document.getElementById('ccl_status_pill');
  if (!pill) return;
  pill.className = `ccl-pill ccl-pill-${String(risk).toLowerCase()}`;
  pill.textContent = risk;
}

function renderSources(sources) {
  const container = document.getElementById('ccl_sources');
  if (!container) return;
  container.textContent = '';
  const entries = Object.entries(sources);
  if (entries.length === 0) {
    container.appendChild(chip('No dynamic source detected', 'muted'));
    return;
  }
  for (const [name, data] of entries) {
    container.appendChild(chip(`${name} x${data.count}`, data.severity === 'high' ? 'bad' : 'warn'));
  }
}

function renderDiff(diff) {
  const container = document.getElementById('ccl_diff');
  if (!container) return;
  if (!diff) {
    container.textContent = 'No previous snapshot.';
    return;
  }
  if (diff.kind === 'unchanged') {
    container.textContent = 'Stable against the previous snapshot.';
    return;
  }
  container.textContent = `First change at item ${diff.firstChangedIndex + 1}: ${diff.kind}.`;
}

function renderReasons(reasons) {
  const list = document.getElementById('ccl_reasons');
  if (!list) return;
  list.textContent = '';
  if (reasons.length === 0) {
    const item = document.createElement('li');
    item.textContent = 'Waiting for generation.';
    list.appendChild(item);
    return;
  }
  for (const reason of reasons.slice(0, 6)) {
    const item = document.createElement('li');
    item.textContent = reason;
    list.appendChild(item);
  }
}

function renderGatewaySummary(summary) {
  const container = document.getElementById('ccl_gateway_summary');
  if (!container) return;
  if (!summary) {
    container.textContent = '';
    return;
  }
  container.textContent = `Gateway: read ${summary.cacheReadTokens || 0}, write ${summary.cacheCreationTokens || 0}, input ${summary.inputTokens || 0} tokens.`;
}

async function readGatewayUsage() {
  const settings = getSettings();
  if (!settings.gatewayUrl) {
    latestState.gatewaySummary = { cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0 };
    renderPanel();
    return;
  }
  const response = await fetch(`${settings.gatewayUrl.replace(/\/$/, '')}/cache-lens/usage`);
  const payload = await response.json();
  latestState.gatewaySummary = payload.summary || payload;
  renderPanel();
}

function exportDiagnostics() {
  const payload = {
    exportedAt: new Date().toISOString(),
    lastSnapshot: readJson(LAST_SNAPSHOT_KEY),
    history: readJson(HISTORY_KEY) || [],
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `claude-cache-lens-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function postToServerPlugin(payload) {
  await fetch('/api/plugins/claude-cache-lens/diagnose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function appendHistory(entry, maxItems) {
  const history = readJson(HISTORY_KEY) || [];
  history.push(entry);
  writeJson(HISTORY_KEY, history.slice(-Math.max(1, Number(maxItems) || 20)));
}

function chip(label, tone) {
  const node = document.createElement('span');
  node.className = `ccl-chip ccl-chip-${tone}`;
  node.textContent = label;
  return node;
}

function formatDepth(depth) {
  return depth === -1 || depth == null ? 'Off' : String(depth);
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) {
    node.textContent = value;
  }
}

function ensureSettings() {
  const settings = getSettings();
  Object.assign(settings, { ...defaultSettings, ...settings });
  saveSettings();
}

function getSettings() {
  const context = getContextSafe();
  if (context?.extensionSettings) {
    context.extensionSettings[MODULE_NAME] = {
      ...defaultSettings,
      ...(context.extensionSettings[MODULE_NAME] || {}),
    };
    return context.extensionSettings[MODULE_NAME];
  }
  const settings = readJson(`${MODULE_NAME}:settings`) || {};
  return { ...defaultSettings, ...settings };
}

function saveSettings() {
  const context = getContextSafe();
  if (context?.extensionSettings) {
    context.saveSettingsDebounced?.();
    return;
  }
  writeJson(`${MODULE_NAME}:settings`, getSettings());
}

function getContextSafe() {
  try {
    return globalThis.SillyTavern?.getContext?.() || importedGetContext?.() || null;
  } catch {
    return null;
  }
}

async function loadContextModule() {
  if (contextImportAttempted) {
    return;
  }
  contextImportAttempted = true;
  try {
    const module = await import('../../extensions.js');
    if (typeof module.getContext === 'function') {
      importedGetContext = module.getContext;
    }
  } catch (error) {
    console.warn('[Claude Cache Lens] Falling back to global SillyTavern context:', error);
  }
}

function readJson(key) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
