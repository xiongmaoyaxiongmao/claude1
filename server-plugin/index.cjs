'use strict';

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

module.exports = {
  init,
  exit,
  info: {
    id: 'claude-cache-lens',
    name: 'Claude Cache Lens',
    description: 'Stores SillyTavern Claude prompt-cache diagnostics for Cache Lens.',
  },
};
