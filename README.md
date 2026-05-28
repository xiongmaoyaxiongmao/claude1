# SillyTavern Claude Cache Lens

Claude Cache Lens is a SillyTavern third-party extension for prompt-cache diagnostics. It observes generation requests before SillyTavern sends them, estimates whether the stable prompt prefix can hit Claude prompt cache, and shows cache settings recommendations without changing the prompt.

## What ships in this folder

- `manifest.json`, `index.js`, `style.css`: the SillyTavern UI extension.
- `src/cacheLensCore.js`: shared prompt snapshot and diagnosis logic.
- `server-plugin/`: optional SillyTavern server plugin for diagnostics and one-click `config.yaml` updates.
- `test/`: Node built-in tests for the analyzer.

## Install as a SillyTavern extension

### Git install

1. Push this folder to a Git repository.
2. In SillyTavern, open **Extensions** -> **Install Extension**.
3. Paste the repository URL, for example:

```text
https://github.com/xiongmaoyaxiongmao/claude1.git
```

4. Install it for your user or all users.
5. Reload SillyTavern and enable **Claude Cache Lens**.

When installed from Git, SillyTavern can pull updates from the same repository.

### Manual install

1. Copy this folder into `SillyTavern/data/<user-handle>/extensions/claude-cache-lens`.
2. Restart or reload SillyTavern.
3. Open Extensions and enable **Claude Cache Lens**.

The v1 extension is observation-only. It does not mutate chat data, abort generation, or rewrite prompts.

## Optional server plugin

Copy `server-plugin` into `SillyTavern/plugins/claude-cache-lens`, then set this in SillyTavern `config.yaml`:

```bash
cd "/path/to/SillyTavern"
mkdir -p plugins/claude-cache-lens
cp -R data/default-user/extensions/claude1/server-plugin/* plugins/claude-cache-lens/
```

```yaml
enableServerPlugins: true
```

Restart SillyTavern. The plugin folder must contain `index.js`, `index.cjs`, and `package.json`. The plugin exposes:

- `GET /api/plugins/claude-cache-lens/diagnose`
- `POST /api/plugins/claude-cache-lens/diagnose`
- `DELETE /api/plugins/claude-cache-lens/diagnose`
- `GET /api/plugins/claude-cache-lens/config`
- `POST /api/plugins/claude-cache-lens/config`
- `GET /api/plugins/claude-cache-lens/patcher`
- `GET /api/plugins/claude-cache-lens/self-update`
- `POST /api/plugins/claude-cache-lens/self-update`

The config endpoint only updates the top-level `claude:` block in `config.yaml` and creates a backup before writing. Restart SillyTavern after applying the config.

The server plugin also patches outgoing Claude requests in-process:

- Adds top-level `metadata.user_id` with a stable default value.
- Adds compatible cache breakpoints to native Claude and OpenAI-compatible Claude request bodies.
- Automatically adds a later stable cache breakpoint when the configured depth is below the model's cache minimum.
- Blocks outgoing Claude requests by default when the actual cache prefix is still below the model's cache minimum.
- Blocks outgoing Claude requests when the cache prefix changed from the previous baseline or that baseline expired.
- Requires an explicit one-shot baseline write in Strict Guard mode when no previous, changed, or expired Claude cache baseline exists.
- Tracks whether the current Claude cache prefix matches the previous Claude request for the same target/model/user.
- Reports the first changed prefix segment on mismatch without storing the prompt text.
- Shows the estimated cache-controlled prefix tokens against the model-family cache minimum.
- Leaves non-Claude models untouched.

Check whether it loaded:

```text
GET http://127.0.0.1:8000/api/plugins/claude-cache-lens/patcher
```

If `/config` works but `/patcher` returns `Not found`, the running server plugin is older than `0.1.9`. Copy `server-plugin` into `SillyTavern/plugins/claude-cache-lens` again and fully restart SillyTavern.

After server plugin `0.1.12` or newer is installed once, future extension updates can sync the server plugin from the panel plug button. A full SillyTavern restart is still required after syncing because the server-side code is loaded at process start.

## Test

```bash
cd sillytavern-claude-cache-lens
npm test
```

## Publish to your Git repository

```bash
cd claude1
git init
git add .
git commit -m "Initial Claude Cache Lens extension"
git branch -M main
git remote add origin https://github.com/xiongmaoyaxiongmao/claude1.git
git push -u origin main
```

## Cache recommendations

- `claude.enableSystemPromptCache`: generally recommended for Claude.
- `claude.cachingAtDepth`: starts at `2` when the prior request prefix matches the current request with the last two messages excluded.
- `claude.extendedTTL`: recommended only for large stable prefixes.
- Dynamic macros, time/date content, summaries, vector retrieval, web search, and World Info inside the stable prefix are flagged as cache-miss risks.
- Cache minimum diagnostics use the actual cache breakpoint prefix, not the whole request. Current Anthropic thresholds: 4096 estimated tokens for Opus 4.5+ and Haiku 4.5, 2048 for Haiku 3.5, and 1024 for Sonnet 4.x / older Opus.
