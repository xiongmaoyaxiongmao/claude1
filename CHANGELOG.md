# Changelog

## 0.1.28

- Add a browser-side Prompt Relocator that can move risky or changing `IN_PROMPT depth=0` system injections to `IN_CHAT depth=2` before generation.
- Run Cache Lens late in the generation interceptor order so it can relocate prompts set by other extensions first.

## 0.1.27

- Respect `claude.enableSystemPromptCache: false` in the server patcher, so dynamic or encrypted system injections do not get a system-only cache marker.
- Add a panel `System` cache toggle while keeping history cache breakpoints available.

## 0.1.26

- Compare all Claude cache-control breakpoints, not only the deepest prefix.
- Allow requests when an earlier cache breakpoint is stable and above the model minimum, so Claude can read the stable prefix and write the new deeper prefix.
- Keep `/patcher` output smaller by omitting inner segment hash lists from the top-level segment snapshot.

## 0.1.25

- Add a labeled `prefixSegmentReport` for every cache-prefix segment: stable, changed, added, or removed.
- Show segment status counts and changed segment labels in the panel.

## 0.1.24

- Add `lastClaude.prefixDiagnosis` with status, likely source, details, and suggested next action.
- Report multiple changed prefix segments, not only the first one, while still omitting prompt text.

## 0.1.23

- Add inner line/paragraph fingerprints for changed prefix segments, still without storing prompt text.
- Show the inner changed part index in the panel when a prefix segment changes.

## 0.1.22

- Fix one-shot baseline writes so the key button allows replacing an expired or changed cache baseline.
- Keep the guard blocking below-minimum cache prefixes even when a baseline write is allowed.

## 0.1.21

- Record hashed segment fingerprints for the real Claude cache prefix.
- Show the first changed prefix segment when Guard blocks a prefix mismatch, without storing prompt text.

## 0.1.20

- Guard Strict mode now blocks the first Claude cache write unless the user explicitly allows one baseline write.
- Add a UI key button to allow exactly one baseline cache write, making paid cache warm-up intentional.

## 0.1.19

- Guard now blocks Claude requests when the cache prefix changed from the previous Claude request.
- Guard now blocks when the previous cache baseline is older than the selected TTL, avoiding false expectations of a cache read.

## 0.1.18

- Track the last Claude cache-prefix hash and whether it matches the previous Claude request for the same target/model/user.
- Keep Claude diagnostics from being overwritten by non-Claude requests.

## 0.1.17

- Add Cache Guard, enabled by default, to block outgoing Claude requests when the actual cache prefix is below the model minimum.
- Add a panel Guard toggle and blocked-request status so failed cache attempts stop before reaching the provider.

## 0.1.16

- Automatically add a cache breakpoint at the first stable prompt segment that reaches the model's cache minimum.
- Report when no stable non-current-input breakpoint can reach the minimum.

## 0.1.15

- Show the estimated cache-controlled prefix size separately from the total prompt size.
- Use the actual cache breakpoint prefix, not the whole request, for minimum-token diagnostics.

## 0.1.14

- Tell users when the running server plugin is too old for the panel self-sync button and still needs one manual copy.

## 0.1.13

- Add current model-specific cache minimum diagnostics for Opus, Sonnet, and Haiku.
- Show estimated prompt tokens versus the minimum cacheable threshold in server plugin status.
- Stop adding a top-level `cache_control`; patch content blocks while keeping top-level `metadata.user_id`.

## 0.1.12

- Add a server plugin self-update endpoint that copies the latest bundled `server-plugin` files from the installed extension.
- Add a panel plug button to sync the server plugin after updating the extension.

## 0.1.11

- Report the last skipped request reason, target kind, and model name in the patcher status.
- Treat Claude-family aliases such as Opus, Sonnet, and Haiku as cache-patchable even when the model name omits `claude`.
- Count already cache-ready requests separately from skipped requests.

## 0.1.10

- Show server plugin request-patcher status in the extension panel.
- Clarify the `/patcher` health check and the old-server-plugin `Not found` case.

## 0.1.9

- Add a server-side Claude request patcher that injects stable `metadata.user_id` plus prompt-cache `cache_control` into outgoing Claude requests.
- Patch both native Claude `/messages` requests and OpenAI-compatible Claude `/chat/completions` requests while leaving non-Claude models untouched.

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
