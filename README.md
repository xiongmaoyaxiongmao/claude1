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

The config endpoint only updates the top-level `claude:` block in `config.yaml` and creates a backup before writing. Restart SillyTavern after applying the config.

Check whether it loaded:

```text
GET http://127.0.0.1:8000/api/plugins/claude-cache-lens/config
```

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
