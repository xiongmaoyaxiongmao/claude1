# Changelog

## 0.1.1

- Mount the settings panel before SillyTavern context is available, then bind events when context appears.
- Add fallback context loading via `../../extensions.js`.
- Lower the minimum client version so older compatible SillyTavern builds can still show the panel.

## 0.1.0

- Initial SillyTavern UI extension with observation-only prompt cache diagnostics.
- Added optional SillyTavern server plugin for diagnostic snapshots.
- Added optional Claude gateway for real usage token tracking.
- Added analyzer tests and Git install documentation.
