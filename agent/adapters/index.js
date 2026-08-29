const { CodexNativeAgentBackend } = require('./codex');
const { AcpAgentBackend } = require('./acp');
const { createZCodeCliAgentBackend, createOpenCodeCliFallback } = require('./cli-fallback');

function createAgentAdapters({ rootPath = process.cwd(), settings = {} } = {}) {
  const paths = settings.executorPaths || {};
  // Let child_process resolve OpenCode from PATH when the user has not supplied
  // an explicit executable. This keeps the packaged plugin portable across
  // macOS, Windows and Linux instead of assuming ~/.local/bin.
  const openCodePath = paths.opencode || 'opencode';

  const codex = new CodexNativeAgentBackend({
    rootPath,
    explicitPath: paths.codex || '',
    ignoreUserConfig: settings.codexIgnoreUserConfig !== false,
    appServerEnabled: settings.codexPersistentAppServer !== false,
  });

  const openCodeFallback = createOpenCodeCliFallback({
    rootPath,
    explicitPath: openCodePath,
    model: settings.openCodeModel || '',
    pure: settings.openCodePure !== false,
  });

  const opencode = new AcpAgentBackend({
    id: 'opencode',
    name: 'OpenCode',
    command: openCodePath,
    args: ['acp', ...(settings.openCodePure === false ? [] : ['--pure']), '--cwd', rootPath],
    rootPath,
    model: settings.openCodeModel || '',
    visionModel: settings.openCodeVisionModel || 'opencode/mimo-v2.5-free',
    fallback: openCodeFallback,
    capabilities: {
      persistentSession: true,
      resume: true,
      nativeFork: true,
      vision: true,
      attachments: true,
      reasoningEffort: true,
      tools: true,
      safeStop: true,
      interactiveInput: true,
      plan: true,
      diff: true,
      permissions: true,
    },
  });

  const zcode = createZCodeCliAgentBackend({
    rootPath,
    explicitPath: paths.zcode || '',
    nodePath: settings.zcodeNodePath || '',
    desktopProviderName: settings.zcodeDesktopProviderName || 'opencode',
  });

  return [codex, opencode, zcode];
}

module.exports = { createAgentAdapters };
