# Graph AI Workspace

A canvas-first AI workspace for Obsidian.

Graph AI Workspace keeps **Canvas as the place where you organize and own knowledge**, while Conversations remain an exploration layer attached to your work. Cards, files, folders, images, and selected text can be passed into an Agent as question-level context. Useful results can then be explicitly materialized back into Canvas.

> Status: **0.9 beta**. Desktop only. The plugin is usable now, but the data model and Agent adapters are still evolving.

## What it does

- **Canvas-first workflow** — keep your knowledge structure in Obsidian Canvas instead of turning the Canvas into a chat transcript.
- **Independent Conversations** — one Card can be used in many Conversations, and one Conversation can reference many Cards.
- **Question-level Context** — attach Canvas cards, Markdown files, folders, images, and selected text to the next question only.
- **Add to Canvas** — materialize an Agent response back into the current Canvas while preserving its Markdown source and provenance.
- **Conversation Forks** — fork from a specific point without duplicating the whole history. Graph AI keeps a canonical branch model instead of treating an Agent's private session as the source of truth.
- **Pluggable Agent runtimes** — current adapters include Codex, OpenCode, and an experimental ZCode adapter.
- **Agent/model/reasoning controls** — model and reasoning options are discovered from the active runtime when the runtime exposes them.
- **Streaming Agent UI** — visible Agent-provided reasoning/summary text, answer deltas, tool calls, edits, and artifacts can stream into the Conversation UI.
- **Permission modes** — Read only, Ask before changes, or Allow edits in project.
- **Image input** — paste, drag, or attach images when the selected Agent supports them.

## Installation

### From a GitHub Release

Once releases are published, download these three files from the release matching the version in `manifest.json`:

- `main.js`
- `manifest.json`
- `styles.css`

Create this folder inside your vault:

```text
<Vault>/.obsidian/plugins/graph-ai-workspace/
```

Put the three files inside it, then restart Obsidian (or reload the app) and enable **Graph AI Workspace** under **Settings → Community plugins**.

The plugin ID is `graph-ai-workspace`, matching the release metadata and installation directory.

### Via BRAT

After this repository has a GitHub Release, BRAT can install the same three release assets. Add the repository as a beta plugin and enable Graph AI Workspace in Obsidian.

## First-time setup

Graph AI Workspace itself does not bundle a model. Install at least one supported Agent runtime on the same computer:

### Codex

- Install the official Codex CLI / desktop runtime.
- Sign in with your ChatGPT/OpenAI account in Codex.
- Graph AI will try to discover `codex` from `PATH` and common install locations.
- You can override the executable path under **Settings → Graph AI Workspace → Agent Runtime**.

Codex uses its persistent App Server integration when available and falls back to the CLI execution path when necessary.

### OpenCode

- Install OpenCode so the `opencode` command is available in `PATH`, or set its executable path manually.
- Authenticate/configure models inside OpenCode itself.
- Graph AI uses **ACP** as the primary integration path and falls back to the CLI when ACP cannot serve the requested capability.

Model choices shown in Graph AI come from the OpenCode ACP session when available.

### ZCode (experimental)

The current ZCode adapter is primarily tested with the macOS desktop installation and its bundled Node CLI. It is optional; Codex and OpenCode do not require ZCode.

## Basic workflow

1. Open a Canvas and select a text/file card.
2. Use the Graph AI action on the card, or open Graph AI from the ribbon.
3. Add more Cards/files/folders/images as Context if needed.
4. Choose an Agent, model, reasoning level, and permission mode.
5. Ask the question.
6. Fork the Conversation when a discussion needs a new direction.
7. Use **Add to Canvas** only when an answer is worth becoming part of your knowledge structure.

### Important semantics

```text
Canvas         = knowledge / writing structure
Conversation   = discussion and exploration
Question       = one prompt plus its Context
Context        = material available to that Question
Link           = explicit provenance / relationship
Fork           = a new Conversation branch
Add to Canvas  = explicit materialization into a Canvas card
Agent          = runtime that answers and/or executes tools
```

Adding a Card as Context does **not** automatically create a backlink or bind the Card to the Conversation.

## Permissions

Graph AI exposes three workspace access levels:

- **Read only** — the Agent should operate without modifying the project.
- **Ask before changes** — modifying actions require approval when the underlying Agent protocol supports interactive permission requests.
- **Allow edits in project** — permit edits inside the current vault/workspace.

Different Agent runtimes expose different native permission primitives. Graph AI maps them as closely as possible and does not claim stricter enforcement than a runtime actually provides.

## Privacy and local data

- Conversation history, context references, settings, and Agent session bindings are stored locally in the plugin's `data.json` inside the vault.
- `data.json` is intentionally ignored by Git and is **not included in release builds**.
- Optional manually entered API keys are stored in that same local plugin state.
- Graph AI does not include its own telemetry service.
- When you send a question to an Agent/model provider, the supplied question and Context may be sent to that provider according to the provider/Agent you configured.
- Local Agent processes can access the current vault according to the permission mode you select.

Before publishing a fork or debug bundle, verify that `data.json`, API keys, logs, and private vault content are not included.

## Development

Requirements:

- Node.js 20+
- npm / pnpm / another package manager compatible with `package.json`

Install dependencies:

```bash
npm ci
```

Run release checks:

```bash
npm run check
```

Build the production plugin:

```bash
npm run build
```

The build bundles all local runtime modules into a single Obsidian-compatible file and writes:

```text
dist/
├── main.js
├── manifest.json
└── styles.css
```

This bundling step is required because Obsidian Community Plugins and BRAT install release assets as the standard `main.js`, `manifest.json`, and optional `styles.css` files.

## Releasing

1. Update the semantic version in `manifest.json` and `versions.json`.
2. Run `npm run check` and `npm run build`.
3. Commit the changes.
4. Push a tag matching the manifest version, for example:

```bash
git tag v0.9.0
git push origin main --tags
```

The included GitHub Actions release workflow validates the tag, builds the bundled plugin, and publishes `main.js`, `manifest.json`, and `styles.css` as release assets.

## Repository hygiene

The repository is source-first. Never commit:

- `data.json`
- `.env*`
- local Agent credentials
- private vault content
- generated `dist/` output

## License

MIT. See [LICENSE](LICENSE).
