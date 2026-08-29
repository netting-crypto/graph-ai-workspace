# Changelog

## 0.9.0

Packaging milestone for public beta distribution.

- Bundled production build: all local runtime modules compile into a single `main.js` suitable for standard Obsidian/BRAT release assets.
- Public product name and plugin ID are unified as **Graph AI Workspace** (`graph-ai-workspace`).
- Added GitHub CI and tag-based Release workflows.
- Added release metadata validation and sensitive-path checks.
- `data.json` is explicitly excluded from Git and release builds.
- Fresh installs no longer silently inherit machine-specific Agent executable paths or another desktop app's credentials.
- OpenCode and Node runtimes prefer Agent defaults / `PATH` discovery unless explicitly configured.
- Added public installation, privacy, permissions, Agent setup, development, and release documentation.

## 0.8.2

- Responsive Composer toolbar and bottom safe-area handling.
- Compact Agent/model/reasoning/permission controls.

## 0.8.1

- Runtime-backed model selection.
- Agent-exposed streaming reasoning/thought UI.
- OpenCode ACP model and thought streaming validation.

## 0.8.0

- Unified Agent Runtime architecture.
- Runtime events and compact execution timeline.
- Claudian-inspired Conversation and Composer interaction model.
