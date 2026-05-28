# Changelog

## 0.1.3

- Add a Claude Cache Config section with an exact `config.yaml` snippet and copy button.
- Clarify in-panel why the browser extension can generate config but cannot directly write SillyTavern server config.

## 0.1.2

- Treat OpenAI-compatible custom endpoints as Claude-compatible when the selected model name contains `claude`.
- Remove the optional gateway field from the default panel to keep the extension focused on SillyTavern cache diagnosis.

## 0.1.1

- Mount the settings panel before SillyTavern context is available, then bind events when context appears.
- Add fallback context loading via `../../extensions.js`.
- Lower the minimum client version so older compatible SillyTavern builds can still show the panel.

## 0.1.0

- Initial SillyTavern UI extension with observation-only prompt cache diagnostics.
- Added optional SillyTavern server plugin for diagnostic snapshots.
- Added optional Claude gateway for real usage token tracking.
- Added analyzer tests and Git install documentation.
