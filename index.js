import {
  analyzeSnapshot,
  createSnapshot,
  hashString,
  summarizeHistory,
} from './src/cacheLensCore.js';

const MODULE_NAME = 'claude_cache_lens';
const LAST_SNAPSHOT_KEY = `${MODULE_NAME}:last_snapshot`;
const HISTORY_KEY = `${MODULE_NAME}:history`;
const RELOCATOR_KEY = `${MODULE_NAME}:prompt_relocator`;
const RELOCATOR_RISK_KEY_PATTERN = /(pages?|retriev|recall|memory|memo|vector|profile|persona|角色|记忆|回忆|闪回|档案)/i;
const RELOCATOR_SKIP_KEY_PATTERN = /(quiet|author|floating_prompt|story_string|depth_prompt|world[_-]?info|wi_|scenario)/i;

const defaultSettings = Object.freeze({
  enabled: true,
  sendSnapshotsToServerPlugin: true,
  maxStoredSnapshots: 20,
  promptRelocatorEnabled: true,
  promptRelocatorDepth: 2,
  systemPromptCacheOverride: null,
  cachingAtDepthOverride: null,
  extendedTTLOverride: null,
});

let initialized = false;
let eventsBound = false;
let importedGetContext = null;
let contextImportAttempted = false;
let importedPromptApi = null;
let promptApiImportAttempted = false;
let latestState = {
  snapshot: null,
  analysis: null,
  serverConfigLoaded: false,
  serverStatus: null,
  relocation: null,
};

globalThis.claudeCacheLensInterceptor = async function claudeCacheLensInterceptor(chat, contextSize, abort, type) {
  void abort;
  const settings = getSettings();
  if (!settings.enabled) {
    return;
  }

  const context = getContextSafe();
  const relocation = relocatePromptInjections(context, settings);
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
    relocation,
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
  localStorage.removeItem(RELOCATOR_KEY);
}

queueMicrotask(() => {
  init().catch((error) => console.error('[Claude Cache Lens] init failed:', error));
});

async function init() {
  await loadContextModule();
  await loadPromptApiModule();

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
  loadServerConfig().catch(() => {});
  loadServerStatus().catch(() => {});
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

      <div class="ccl-section ccl-config-section">
        <div class="ccl-section-title ccl-title-row">
          <span>Claude Cache Config</span>
          <button id="ccl_copy_config" class="menu_button" type="button" title="Copy config.yaml snippet">
            <i class="fa-solid fa-copy"></i>
          </button>
          <button id="ccl_apply_config" class="menu_button" type="button" title="Apply config with server plugin">
            <i class="fa-solid fa-floppy-disk"></i>
          </button>
          <button id="ccl_sync_server_plugin" class="menu_button" type="button" title="Sync server plugin from extension">
            <i class="fa-solid fa-plug-circle-bolt"></i>
          </button>
          <button id="ccl_allow_baseline_write" class="menu_button" type="button" title="Allow next Claude request to write one cache baseline">
            <i class="fa-solid fa-key"></i>
          </button>
        </div>
        <div class="ccl-config-controls">
          <label class="ccl-field">
            <span class="ccl-label">History Depth to Save</span>
            <select id="ccl_depth_select" class="text_pole">
              <option value="2">2 - balanced</option>
              <option value="4">4 - safer</option>
              <option value="8">8 - safest</option>
              <option value="-1">-1 - system only</option>
            </select>
          </label>
          <label class="checkbox_label ccl-ttl-control">
            <input id="ccl_extended_ttl" type="checkbox">
            <span>1h TTL</span>
          </label>
          <label class="checkbox_label ccl-system-control">
            <input id="ccl_system_prompt_cache" type="checkbox">
            <span>System</span>
          </label>
          <label class="checkbox_label ccl-relocator-control">
            <input id="ccl_prompt_relocator" type="checkbox">
            <span>Relocate</span>
          </label>
          <label class="checkbox_label ccl-guard-control">
            <input id="ccl_guard_minimum" type="checkbox" checked>
            <span>Guard</span>
          </label>
        </div>
        <pre id="ccl_config_text" class="ccl-config-text">Waiting for generation.</pre>
        <div id="ccl_config_hint" class="ccl-note">The plugin will generate the exact config.yaml snippet after the first request.</div>
        <div id="ccl_relocator_status" class="ccl-note">Prompt relocator: idle.</div>
        <div id="ccl_server_status" class="ccl-note">Server plugin: checking...</div>
      </div>

      <div class="ccl-section">
        <div class="ccl-section-title">Prefix Diff</div>
        <div id="ccl_diff" class="ccl-note">No snapshot yet.</div>
      </div>

      <div class="ccl-section">
        <div class="ccl-section-title">Reasons</div>
        <ul id="ccl_reasons" class="ccl-list"></ul>
      </div>
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
  panel.querySelector('#ccl_refresh')?.addEventListener('click', () => {
    renderPanel();
    loadServerConfig({ force: true }).catch(() => {});
    loadServerStatus().catch(() => {});
  });
  panel.querySelector('#ccl_clear')?.addEventListener('click', () => {
    localStorage.removeItem(LAST_SNAPSHOT_KEY);
    localStorage.removeItem(HISTORY_KEY);
    latestState = {
      snapshot: null,
      analysis: null,
      serverConfigLoaded: latestState.serverConfigLoaded,
      serverStatus: latestState.serverStatus,
      relocation: latestState.relocation,
    };
    renderPanel();
  });
  panel.querySelector('#ccl_copy_config')?.addEventListener('click', copyRecommendedConfig);
  panel.querySelector('#ccl_apply_config')?.addEventListener('click', applyRecommendedConfig);
  panel.querySelector('#ccl_sync_server_plugin')?.addEventListener('click', syncServerPlugin);
  panel.querySelector('#ccl_allow_baseline_write')?.addEventListener('click', allowBaselineWriteOnce);
  panel.querySelector('#ccl_depth_select')?.addEventListener('change', (event) => {
    const settings = getSettings();
    settings.cachingAtDepthOverride = Number(event.target.value);
    saveSettings();
    renderPanel();
  });
  panel.querySelector('#ccl_extended_ttl')?.addEventListener('change', (event) => {
    const settings = getSettings();
    settings.extendedTTLOverride = Boolean(event.target.checked);
    saveSettings();
    renderPanel();
  });
  panel.querySelector('#ccl_system_prompt_cache')?.addEventListener('change', (event) => {
    const settings = getSettings();
    settings.systemPromptCacheOverride = Boolean(event.target.checked);
    saveSettings();
    renderPanel();
  });
  panel.querySelector('#ccl_prompt_relocator')?.addEventListener('change', (event) => {
    const settings = getSettings();
    settings.promptRelocatorEnabled = Boolean(event.target.checked);
    saveSettings();
    renderPanel();
  });
  panel.querySelector('#ccl_guard_minimum')?.addEventListener('change', (event) => {
    setGuardEnabled(Boolean(event.target.checked)).catch(() => {});
  });
  panel.querySelector('#ccl_export')?.addEventListener('click', exportDiagnostics);

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
  const depthSelect = document.getElementById('ccl_depth_select');
  const extendedTTL = document.getElementById('ccl_extended_ttl');
  const systemPromptCache = document.getElementById('ccl_system_prompt_cache');
  const promptRelocator = document.getElementById('ccl_prompt_relocator');
  const guard = document.getElementById('ccl_guard_minimum');
  if (enabled) enabled.checked = Boolean(settings.enabled);
  if (depthSelect) {
    const value = settings.cachingAtDepthOverride == null ? 2 : settings.cachingAtDepthOverride;
    depthSelect.value = String(value);
  }
  if (extendedTTL) {
    extendedTTL.checked = Boolean(settings.extendedTTLOverride);
  }
  if (systemPromptCache) {
    systemPromptCache.checked = settings.systemPromptCacheOverride == null
      ? Boolean(latestState.analysis?.recommendations?.enableSystemPromptCache ?? true)
      : Boolean(settings.systemPromptCacheOverride);
  }
  if (promptRelocator) {
    promptRelocator.checked = Boolean(settings.promptRelocatorEnabled);
  }
  if (guard && latestState.serverStatus?.payload?.guard) {
    guard.checked = Boolean(latestState.serverStatus.payload.guard.enabled);
  }
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
  renderConfig(analysis);
  renderRelocatorStatus();
  renderServerStatus();
  renderDiff(analysis?.prefixDiff);
  renderReasons(analysis?.reasons || []);
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

function renderRelocatorStatus() {
  const node = document.getElementById('ccl_relocator_status');
  if (!node) return;
  const status = latestState.relocation;
  if (!status) {
    node.textContent = 'Prompt relocator: waiting.';
    return;
  }
  if (!status.enabled) {
    node.textContent = 'Prompt relocator: off.';
    return;
  }
  if (!status.available) {
    node.textContent = `Prompt relocator: unavailable${status.reason ? ` (${status.reason})` : ''}.`;
    return;
  }
  const moved = status.moved || 0;
  const watched = status.watched || 0;
  const labels = Array.isArray(status.items) && status.items.length
    ? `；moved=${status.items.slice(0, 3).map((item) => item.key).join(',')}`
    : '';
  node.textContent = `Prompt relocator: watched ${watched}, moved ${moved}${labels}.`;
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

function renderConfig(analysis) {
  const configNode = document.getElementById('ccl_config_text');
  const hintNode = document.getElementById('ccl_config_hint');
  if (!configNode || !hintNode) return;

  const snippet = buildConfigSnippet(analysis);
  configNode.textContent = snippet;

  if (!analysis) {
    hintNode.textContent = '先发一条消息，插件会按实际结构生成配置。';
    return;
  }
  if (analysis.apiMode === 'anthropic_native') {
    hintNode.textContent = '当前是 Claude 通道。选择 depth 后点保存图标写入 config.yaml，重启 ST 后生效。';
    return;
  }
  if (analysis.apiMode === 'claude_compatible') {
    hintNode.textContent = '当前像 Claude-compatible 通道。选择 depth 后点保存图标写入 config.yaml；真实缓存仍取决于中转支持。';
    return;
  }
  hintNode.textContent = '浏览器扩展不能直接写服务端 config.yaml，只能生成配置片段。';
}

async function copyRecommendedConfig() {
  const analysis = latestState.analysis || (latestState.snapshot ? analyzeSnapshot(latestState.snapshot, null) : null);
  const text = buildConfigSnippet(analysis);
  await copyText(text);
  const hintNode = document.getElementById('ccl_config_hint');
  if (hintNode) {
    hintNode.textContent = '已复制。粘到 SillyTavern/config.yaml 后重启 ST。';
  }
}

async function applyRecommendedConfig() {
  const analysis = latestState.analysis || (latestState.snapshot ? analyzeSnapshot(latestState.snapshot, null) : null);
  const hintNode = document.getElementById('ccl_config_hint');
  try {
    const response = await fetch('/api/plugins/claude-cache-lens/config', {
      method: 'POST',
      headers: getJsonHeaders(),
      body: JSON.stringify({ settings: getRecommendedSettings(analysis) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `Server plugin returned ${response.status}`);
    }
    if (hintNode) {
      syncSettingsFromServerConfig(payload.current);
      hintNode.textContent = '已写入 config.yaml，已备份。重启 SillyTavern 后生效。';
      renderPanel();
      loadServerStatus().catch(() => {});
    }
  } catch (error) {
    if (hintNode) {
      hintNode.textContent = `无法直接写入。请确认 server plugin 已安装且 enableServerPlugins=true。错误：${error.message || error}`;
    }
  }
}

async function loadServerConfig(options = {}) {
  if (latestState.serverConfigLoaded && !options.force) {
    return;
  }
  const response = await fetch('/api/plugins/claude-cache-lens/config', {
    method: 'GET',
    headers: getJsonHeaders(),
  });
  if (!response.ok) {
    return;
  }
  const payload = await response.json().catch(() => null);
  if (!payload?.ok) {
    return;
  }
  latestState.serverConfigLoaded = true;
  syncSettingsFromServerConfig(payload.current);
  renderPanel();
}

async function syncServerPlugin() {
  const hintNode = document.getElementById('ccl_server_status');
  try {
    const response = await fetch('/api/plugins/claude-cache-lens/self-update', {
      method: 'POST',
      headers: getJsonHeaders(),
      body: JSON.stringify({ force: false }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `Server plugin returned ${response.status}`);
    }
    if (hintNode) {
      hintNode.textContent = payload.copied
        ? `Server plugin 已同步到 ${payload.sourceVersion}；完整重启 ST 后生效。`
        : `Server plugin 已是最新版 ${payload.currentVersion}。`;
    }
    loadServerStatus().catch(() => {});
  } catch (error) {
    if (hintNode) {
      hintNode.textContent = `无法同步 server plugin：${error.message || error}`;
    }
  }
}

async function setGuardEnabled(enabled) {
  const hintNode = document.getElementById('ccl_server_status');
  try {
    const response = await fetch('/api/plugins/claude-cache-lens/guard', {
      method: 'POST',
      headers: getJsonHeaders(),
      body: JSON.stringify({ enabled }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `Server plugin returned ${response.status}`);
    }
    if (latestState.serverStatus?.payload) {
      latestState.serverStatus.payload.guard = payload.guard;
    }
    renderServerStatus();
  } catch (error) {
    if (hintNode) {
      hintNode.textContent = `无法切换 Guard：${error.message || error}`;
    }
  }
}

async function allowBaselineWriteOnce() {
  const hintNode = document.getElementById('ccl_config_hint');
  try {
    const response = await fetch('/api/plugins/claude-cache-lens/guard', {
      method: 'POST',
      headers: getJsonHeaders(),
      body: JSON.stringify({ allowBaselineWriteOnce: true }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `Server plugin returned ${response.status}`);
    }
    if (latestState.serverStatus?.payload) {
      latestState.serverStatus.payload.guard = payload.guard;
    }
    if (hintNode) {
      hintNode.textContent = '已允许下一条 Claude 请求写入一次缓存基准。';
    }
    renderServerStatus();
  } catch (error) {
    if (hintNode) {
      hintNode.textContent = `无法允许基准写入：${error.message || error}`;
    }
  }
}

async function loadServerStatus() {
  latestState.serverStatus = { state: 'checking' };
  renderServerStatus();

  try {
    const response = await fetch('/api/plugins/claude-cache-lens/patcher', {
      method: 'GET',
      headers: getJsonHeaders(),
    });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.ok) {
      latestState.serverStatus = {
        state: payload.installed ? 'active' : 'loaded',
        payload,
      };
      renderServerStatus();
      return;
    }

    if (response.status === 404) {
      latestState.serverStatus = await detectOldServerPlugin();
      renderServerStatus();
      return;
    }

    latestState.serverStatus = { state: 'error', message: `Server plugin returned ${response.status}` };
    renderServerStatus();
  } catch (error) {
    latestState.serverStatus = { state: 'missing', message: error.message || String(error) };
    renderServerStatus();
  }
}

async function detectOldServerPlugin() {
  try {
    const response = await fetch('/api/plugins/claude-cache-lens/config', {
      method: 'GET',
      headers: getJsonHeaders(),
    });
    if (response.ok) {
      return {
        state: 'outdated',
        message: '/config exists but /patcher is missing.',
      };
    }
  } catch {
    // Ignore and report as missing below.
  }
  return {
    state: 'missing',
    message: 'Server plugin route not found.',
  };
}

function renderServerStatus() {
  const node = document.getElementById('ccl_server_status');
  if (!node) return;

  const status = latestState.serverStatus;
  if (!status || status.state === 'checking') {
    node.textContent = 'Server plugin: checking...';
    return;
  }

  if (status.state === 'active') {
    const payload = status.payload || {};
    const version = payload.version ? ` v${payload.version}` : '';
    const isLegacyServerPlugin = compareVersions(payload.version || '0.0.0', '0.1.12') < 0;
    const update = isLegacyServerPlugin
      ? '；server plugin 太旧，插头同步需要 v0.1.12+，这次还要手动复制一次'
      : payload.selfUpdate?.updateAvailable
      ? `；扩展内有新版 server plugin ${payload.selfUpdate.sourceVersion}，点插头按钮同步`
      : '';
    const threshold = payload.lastMinimumCacheTokens
      ? `；缓存前缀 ${payload.lastEstimatedPromptTokens || 0}/${payload.lastMinimumCacheTokens} tokens${payload.lastTotalPromptTokens ? `，总 ${payload.lastTotalPromptTokens}` : ''}${payload.lastBelowMinimum ? '，低于缓存门槛' : ''}`
      : '';
    const auto = payload.lastAutoBreakpoint?.reason
      ? `；自动断点=${payload.lastAutoBreakpoint.reason}${payload.lastAutoBreakpoint.tokens ? `(${payload.lastAutoBreakpoint.tokens})` : ''}`
      : '';
    const guard = payload.guard
      ? `；Guard=${payload.guard.enabled ? 'On' : 'Off'}${payload.guard.requirePreviousPrefix ? '，Strict' : ''}${payload.guard.allowBaselineWriteOnce ? '，已允许一次基准写入' : ''}${payload.guard.blockedRequests ? `，已拦截 ${payload.guard.blockedRequests} 次${payload.guard.lastBlockedReason ? `(${payload.guard.lastBlockedReason})` : ''}` : ''}`
      : '';
    const lastClaude = payload.lastClaude
      ? `；Claude前缀${payload.lastClaude.matchedPreviousPrefix ? '稳定' : payload.lastClaude.missingPreviousPrefix ? '无基准' : '变化'}${payload.lastClaude.previousAt ? '' : '(首条)'}`
      : '';
    const prefixDiff = payload.lastClaude?.prefixDiff
      ? `；首变=${payload.lastClaude.prefixDiff.current?.source || payload.lastClaude.prefixDiff.previous?.source || payload.lastClaude.prefixDiff.reason}${payload.lastClaude.prefixDiff.innerDiff ? `#${payload.lastClaude.prefixDiff.innerDiff.index}` : ''}`
      : '';
    const diagnosis = payload.lastClaude?.prefixDiagnosis
      ? `；诊断=${payload.lastClaude.prefixDiagnosis.status}${payload.lastClaude.prefixDiagnosis.likelySource ? `：${payload.lastClaude.prefixDiagnosis.likelySource}` : ''}`
      : '';
    const stableBreakpoint = payload.lastClaude?.stableCacheBreakpoint
      ? `；稳定断点=${payload.lastClaude.stableCacheBreakpoint.tokens || 0}t@${payload.lastClaude.stableCacheBreakpoint.source || '-'}`
      : '';
    const segmentReport = Array.isArray(payload.lastClaude?.prefixSegmentReport)
      ? summarizeSegmentReport(payload.lastClaude.prefixSegmentReport)
      : '';
    const skipped = payload.skippedRequests || 0;
    const skipHint = skipped
      ? `；最近跳过=${payload.lastSkippedReason || 'unknown'}${payload.lastSkippedModel ? ` (${payload.lastSkippedModel})` : ''}`
      : '';
    node.textContent = `Server plugin${version} 已加载；已补丁 ${payload.patchedRequests || 0} 次；已自带缓存 ${payload.cacheReadyRequests || 0} 次；跳过 ${skipped} 次${skipHint}${threshold}${auto}${guard}${lastClaude}${prefixDiff}${diagnosis}${stableBreakpoint}${segmentReport}${update}；user_id=${payload.userId || '-'}`;
    return;
  }

  if (status.state === 'loaded') {
    node.textContent = 'Server plugin 已加载，但 request patcher 未安装。请重启 SillyTavern。';
    return;
  }

  if (status.state === 'outdated') {
    node.textContent = 'Server plugin 是旧版：/config 可用，但 /patcher 不存在。重新复制 server-plugin 目录并完整重启 ST。';
    return;
  }

  if (status.state === 'missing') {
    node.textContent = 'Server plugin 未加载：确认 enableServerPlugins=true，并把 server-plugin 复制到 SillyTavern/plugins/claude-cache-lens 后重启。';
    return;
  }

  node.textContent = `Server plugin 检查失败：${status.message || status.state}`;
}

function summarizeSegmentReport(report) {
  if (!report.length) {
    return '';
  }
  const counts = report.reduce((result, item) => {
    result[item.status] = (result[item.status] || 0) + 1;
    return result;
  }, {});
  const changed = report
    .filter((item) => item.status !== 'stable')
    .slice(0, 3)
    .map((item) => `${item.source}${item.innerDiff ? `#${item.innerDiff.index}` : ''}`)
    .join(',');
  return `；分段 stable=${counts.stable || 0}, changed=${counts.changed || 0}, added=${counts.added || 0}, removed=${counts.removed || 0}${changed ? `；变段=${changed}` : ''}`;
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

function syncSettingsFromServerConfig(current) {
  if (!current) {
    return;
  }
  const settings = getSettings();
  if (Number.isInteger(current.cachingAtDepth)) {
    settings.cachingAtDepthOverride = current.cachingAtDepth;
  }
  if (typeof current.extendedTTL === 'boolean') {
    settings.extendedTTLOverride = current.extendedTTL;
  }
  if (typeof current.enableSystemPromptCache === 'boolean') {
    settings.systemPromptCacheOverride = current.enableSystemPromptCache;
  }
  saveSettings();
}

function buildConfigSnippet(analysis) {
  const recommendations = getRecommendedSettings(analysis);
  return [
    'claude:',
    `  enableSystemPromptCache: ${Boolean(recommendations.enableSystemPromptCache)}`,
    `  cachingAtDepth: ${recommendations.cachingAtDepth}`,
    `  extendedTTL: ${Boolean(recommendations.extendedTTL)}`,
  ].join('\n');
}

function getRecommendedSettings(analysis) {
  const settings = getSettings();
  const recommendations = analysis?.recommendations || {
    enableSystemPromptCache: true,
    cachingAtDepth: 2,
    extendedTTL: false,
  };
  const depth = settings.cachingAtDepthOverride ?? recommendations.cachingAtDepth ?? 2;
  const extendedTTL = settings.extendedTTLOverride ?? recommendations.extendedTTL ?? false;
  const systemPromptCache = settings.systemPromptCacheOverride ?? recommendations.enableSystemPromptCache ?? true;
  return {
    enableSystemPromptCache: Boolean(systemPromptCache),
    cachingAtDepth: depth,
    extendedTTL: Boolean(extendedTTL),
  };
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
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
    headers: getJsonHeaders(),
    body: JSON.stringify(payload),
  });
}

function getJsonHeaders() {
  const context = getContextSafe();
  return {
    'Content-Type': 'application/json',
    ...(context?.getRequestHeaders?.() || {}),
  };
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

async function loadPromptApiModule() {
  if (promptApiImportAttempted) {
    return;
  }
  promptApiImportAttempted = true;
  for (const modulePath of ['../../../../script.js', '../../../script.js', '../../script.js', '/script.js']) {
    try {
      const module = await import(modulePath);
      if (module?.extension_prompts && module?.extension_prompt_types) {
        importedPromptApi = module;
        return;
      }
    } catch {
      // Try the next SillyTavern path shape.
    }
  }
}

function relocatePromptInjections(context, settings) {
  if (!settings.promptRelocatorEnabled) {
    return { enabled: false };
  }

  const promptApi = getPromptApi(context);
  if (!promptApi?.prompts || !promptApi.types) {
    return { enabled: true, available: false, reason: 'prompt_api_missing' };
  }

  const history = readJson(RELOCATOR_KEY) || {};
  const nextHistory = {};
  const items = [];
  let watched = 0;
  let moved = 0;
  const depth = Number.isInteger(settings.promptRelocatorDepth) ? settings.promptRelocatorDepth : 2;

  for (const [key, prompt] of Object.entries(promptApi.prompts)) {
    if (!isRelocatorCandidate(key, prompt, promptApi)) {
      continue;
    }
    watched += 1;
    const value = String(prompt.value || '');
    const hash = hashString(value);
    const previous = history[key];
    const changed = Boolean(previous?.hash && previous.hash !== hash);
    const riskyKey = RELOCATOR_RISK_KEY_PATTERN.test(key);
    const broadMode = settings.systemPromptCacheOverride === false && value.length > 200;
    const shouldMove = riskyKey || changed || broadMode;

    nextHistory[key] = {
      hash,
      chars: value.length,
      changed,
      seenAt: new Date().toISOString(),
    };

    if (!shouldMove) {
      continue;
    }

    prompt.position = promptApi.types.IN_CHAT;
    prompt.depth = depth;
    prompt.role = promptApi.roles?.SYSTEM ?? prompt.role ?? 0;
    moved += 1;
    items.push({
      key,
      reason: riskyKey ? 'risky_key' : changed ? 'changed' : 'system_cache_off',
      chars: value.length,
      hash,
      depth,
    });
  }

  writeJson(RELOCATOR_KEY, { ...history, ...nextHistory });
  return { enabled: true, available: true, watched, moved, items };
}

function getPromptApi(context) {
  const prompts = context?.extensionPrompts || importedPromptApi?.extension_prompts || null;
  const types = importedPromptApi?.extension_prompt_types || {
    IN_PROMPT: 0,
    IN_CHAT: 1,
  };
  const roles = importedPromptApi?.extension_prompt_roles || {
    SYSTEM: 0,
  };
  return prompts ? { prompts, types, roles } : null;
}

function isRelocatorCandidate(key, prompt, promptApi) {
  if (!prompt || typeof prompt !== 'object') {
    return false;
  }
  const value = String(prompt.value || '').trim();
  if (!value) {
    return false;
  }
  if (RELOCATOR_SKIP_KEY_PATTERN.test(key)) {
    return false;
  }
  const isSystemPrompt = Number(prompt.position) === Number(promptApi.types.IN_PROMPT)
    && Number(prompt.depth || 0) === 0
    && Number(prompt.role ?? promptApi.roles?.SYSTEM ?? 0) === Number(promptApi.roles?.SYSTEM ?? 0);
  return isSystemPrompt;
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
