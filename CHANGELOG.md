# Changelog

## 0.1.8

- Add manual History Depth and 1h TTL controls so config can be saved without editing YAML by hand.
- Read existing server config so the controls match the current `config.yaml` values when the server plugin is available.

## 0.1.7

- Remove unused optional networking files and related settings so the repository is focused on SillyTavern extension plus server plugin only.

## 0.1.6

- Add a server-plugin `index.js` wrapper so SillyTavern can load the plugin by default directory entrypoint as well as through `package.json`.

## 0.1.5

- Add `server-plugin/package.json` so SillyTavern directory plugin loading can discover the CommonJS `index.cjs` entrypoint.

## 0.1.4

- Add server-plugin endpoints that can write the recommended Claude cache settings into `config.yaml` with an automatic backup.
- Add a panel button to apply the recommended config through the server plugin.
- Send diagnostic snapshots to the server plugin by default when it is installed.

## 0.1.3

- Add a Claude Cache Config section with an exact `config.yaml` snippet and copy button.
- Clarify in-panel why the browser extension can generate config but cannot directly write SillyTavern server config.

## 0.1.2

- Treat OpenAI-compatible custom endpoints as Claude-compatible when the selected model name contains `claude`.
- Remove unrelated optional fields from the default panel to keep the extension focused on SillyTavern cache diagnosis.

## 0.1.1

- Mount the settings panel before SillyTavern context is available, then bind events when context appears.
- Add fallback context loading via `../../extensions.js`.
- Lower the minimum client version so older compatible SillyTavern builds can still show the panel.

## 0.1.0

- Initial SillyTavern UI extension with observation-only prompt cache diagnostics.
- Added optional SillyTavern server plugin for diagnostic snapshots.
- Added analyzer tests and Git install documentation.
