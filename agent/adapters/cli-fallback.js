const fs = require('fs');
const path = require('path');
const os = require('os');
const { AgentBackend } = require('../backend');
const {
  truncate,
  inheritedAgentEnv,
  resolveExecutable,
  resolveInside,
  execFileCapture,
  parseJsonLines,
  findDeepString,
  extractLikelyFinalText,
} = require('../process-utils');

class OpenCodeCliAgentBackend extends AgentBackend {
  constructor({ rootPath = process.cwd(), explicitPath = '', model = '', visionModel = '', pure = true } = {}) {
    super({
      id: 'opencode',
      name: 'OpenCode',
      protocol: 'cli-fallback',
      capabilities: {
        persistentSession: true,
        resume: true,
        nativeFork: false,
        vision: true,
        attachments: true,
        reasoningEffort: true,
        reasoningLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        tools: true,
        safeStop: false,
        interactiveInput: false,
        plan: true,
        diff: true,
        permissions: true,
      },
    });
    this.rootPath = path.resolve(rootPath || process.cwd());
    this.explicitPath = explicitPath;
    this.model = model;
    this.visionModel = visionModel;
    this.pure = pure !== false;
    this.statusCache = null;
  }

  resolve() {
    return resolveExecutable('opencode', this.explicitPath, [path.join(os.homedir(), '.local', 'bin', 'opencode')]);
  }

  async detect({ refresh = false } = {}) {
    if (!refresh && this.statusCache) return { ...this.statusCache };
    const executable = this.resolve();
    if (!executable) {
      const appInstalled = fs.existsSync('/Applications/OpenCode.app');
      this.statusCache = {
        id: this.id,
        name: this.name,
        protocol: this.protocol,
        available: appInstalled,
        runnable: false,
        executable: appInstalled ? '/Applications/OpenCode.app' : '',
        detail: appInstalled ? 'OpenCode desktop app detected, but headless CLI was not found.' : 'OpenCode CLI not found.',
      };
      return { ...this.statusCache };
    }
    const [version, auth] = await Promise.all([
      execFileCapture(executable, ['--version'], { cwd: this.rootPath, timeoutMs: 6000 }),
      execFileCapture(executable, ['auth', 'list'], { cwd: this.rootPath, timeoutMs: 6000 }),
    ]);
    const authText = `${auth.stdout}\n${auth.stderr}`;
    const authenticated = /credentials|opencode go|oauth|api/i.test(authText);
    this.statusCache = {
      id: this.id,
      name: this.name,
      protocol: this.protocol,
      available: true,
      runnable: Boolean(version.ok),
      authenticated,
      executable,
      detail: `${String(version.stdout || version.stderr || '').trim() || 'OpenCode CLI'} · ${authenticated ? 'credential available' : 'free/public models available'} · ${this.model ? `model ${this.model}` : 'Agent default model'}`,
    };
    return { ...this.statusCache };
  }

  async getCapabilities() {
    return { ...this.capabilities };
  }

  async getReasoningOptions() {
    return [
      { value: 'auto', label: 'Auto' },
      ...(this.capabilities.reasoningLevels || []).map((value) => ({ value, label: value === 'max' ? 'Max' : value.charAt(0).toUpperCase() + value.slice(1) })),
    ];
  }

  async start({ cwd = '.', permission = 'ask', binding = null } = {}) {
    return {
      ok: true,
      backend: this.id,
      executor: this.name,
      sessionId: binding && binding.sessionId || '',
      resumed: Boolean(binding && binding.sessionId),
      permission,
      cwd,
      protocol: this.protocol,
      transport: 'opencode-cli',
    };
  }

  async send({ prompt, cwd = '.', permission = 'ask', approve, binding = null, attachments = [], reasoningEffort = 'auto', modelId = '' } = {}) {
    const status = await this.detect();
    if (!status.runnable) return { ok: false, backend: this.id, error: status.detail || 'OpenCode CLI is unavailable.' };

    let allowChanges = permission === 'allow-edits';
    if (permission === 'ask') {
      if (typeof approve !== 'function') return { ok: false, backend: this.id, denied: true, error: 'Approval required before OpenCode CLI may execute changes.' };
      allowChanges = await approve({
        name: 'opencode_cli_run',
        args: { cwd, prompt },
        description: `OpenCode CLI fallback may modify the workspace for this turn.\n\nWorking directory: ${cwd}\n\n${truncate(prompt, 1800)}`,
      });
      if (!allowChanges) return { ok: false, backend: this.id, denied: true, error: 'User denied OpenCode CLI fallback.' };
    }

    const workingDirectory = resolveInside(this.rootPath, cwd || '.');
    const normalizedCwd = path.relative(this.rootPath, workingDirectory) || '.';
    const canResume = Boolean(binding && binding.sessionId && (!binding.permission || binding.permission === permission) && (!binding.cwd || binding.cwd === normalizedCwd));
    const hasAttachments = (attachments || []).some((item) => item && item.absolutePath);
    const effectiveModel = modelId || (hasAttachments ? this.visionModel : this.model);
    const args = ['run'];
    if (this.pure) args.push('--pure');
    args.push('--format', 'json', '--dir', workingDirectory);
    if (effectiveModel) args.push('--model', effectiveModel);
    if (!hasAttachments && reasoningEffort && reasoningEffort !== 'auto') args.push('--variant', reasoningEffort);
    if (canResume) args.push('--session', binding.sessionId);
    if (allowChanges) args.push('--auto');
    args.push(String(prompt || ''));
    for (const attachment of attachments || []) {
      if (attachment && attachment.absolutePath) args.push('--file', attachment.absolutePath);
    }

    const result = await execFileCapture(status.executable, args, { cwd: workingDirectory });
    const events = parseJsonLines(result.stdout);
    const sessionId = events.map((event) => findDeepString(event, ['sessionID', 'sessionId', 'session_id'])).find(Boolean)
      || (binding && binding.sessionId)
      || '';
    return {
      ok: result.ok,
      backend: this.id,
      executor: this.name,
      protocol: this.protocol,
      transport: 'opencode-cli',
      model: effectiveModel,
      modelId: effectiveModel,
      sessionId,
      resumed: canResume,
      permission,
      cwd: normalizedCwd,
      output: extractLikelyFinalText(events, result.stdout),
      stderr: truncate(result.stderr, 12000),
      code: result.code,
      error: result.ok ? '' : result.error || result.stderr || 'OpenCode CLI task failed.',
    };
  }
}

class ZCodeCliAgentBackend extends AgentBackend {
  constructor({ rootPath = process.cwd(), explicitPath = '', nodePath = '', scriptPath = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', desktopProviderName = 'opencode' } = {}) {
    super({
      id: 'zcode',
      name: 'ZCode',
      protocol: 'cli-fallback',
      capabilities: {
        persistentSession: true,
        resume: true,
        nativeFork: false,
        vision: true,
        attachments: true,
        reasoningEffort: false,
        reasoningLevels: [],
        tools: true,
        safeStop: false,
        interactiveInput: false,
        plan: false,
        diff: false,
        permissions: true,
      },
    });
    this.rootPath = path.resolve(rootPath || process.cwd());
    this.explicitPath = explicitPath;
    this.nodePath = nodePath;
    this.scriptPath = scriptPath;
    this.desktopProviderName = desktopProviderName;
    this.statusCache = null;
  }

  resolveNode() {
    return resolveExecutable('node', this.nodePath, [path.join(os.homedir(), '.local', 'bin', 'node')]);
  }

  resolveScript() {
    if (this.explicitPath) {
      const explicit = path.resolve(String(this.explicitPath).replace(/^~(?=$|\/)/, os.homedir()));
      if (fs.existsSync(explicit) && fs.statSync(explicit).isFile() && explicit.endsWith('.cjs')) return explicit;
    }
    return fs.existsSync(this.scriptPath) ? this.scriptPath : '';
  }

  loadDesktopCredential() {
    try {
      const configPath = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const providers = data && data.provider && typeof data.provider === 'object' ? data.provider : {};
      const wanted = String(this.desktopProviderName || '').trim().toLowerCase();
      for (const provider of Object.values(providers)) {
        if (!provider || typeof provider !== 'object') continue;
        if (wanted && String(provider.name || '').trim().toLowerCase() !== wanted) continue;
        const options = provider.options && typeof provider.options === 'object' ? provider.options : {};
        if (typeof options.apiKey === 'string' && options.apiKey.trim()) {
          return { apiKey: options.apiKey.trim(), providerName: provider.name || this.desktopProviderName };
        }
      }
    } catch (_) {}
    return null;
  }

  async detect({ refresh = false } = {}) {
    if (!refresh && this.statusCache) return { ...this.statusCache };
    const node = this.resolveNode();
    const script = this.resolveScript();
    const appInstalled = fs.existsSync('/Applications/ZCode.app');
    if (!node || !script) {
      this.statusCache = {
        id: this.id,
        name: this.name,
        protocol: this.protocol,
        available: Boolean(appInstalled || script),
        runnable: false,
        executable: script || (appInstalled ? '/Applications/ZCode.app' : ''),
        detail: !node ? 'ZCode app detected, but Node runtime is missing.' : 'ZCode bundled headless CLI script was not found.',
      };
      return { ...this.statusCache };
    }
    const version = await execFileCapture(node, [script, '--version'], { cwd: this.rootPath, timeoutMs: 6000 });
    const hasProjectConfig = fs.existsSync(path.join(this.rootPath, '.zcode', 'config.json'));
    const credential = this.loadDesktopCredential();
    const runnable = Boolean(version.ok && hasProjectConfig && credential);
    this.statusCache = {
      id: this.id,
      name: this.name,
      protocol: this.protocol,
      available: true,
      runnable,
      authenticated: Boolean(credential),
      executable: script,
      launcher: node,
      detail: [
        String(version.stdout || version.stderr || '').trim() || 'ZCode CLI',
        hasProjectConfig ? 'project config ready' : 'missing .zcode/config.json',
        credential ? `desktop ${credential.providerName} credential bridge ready` : `desktop ${this.desktopProviderName} credential unavailable`,
      ].join(' · '),
    };
    return { ...this.statusCache };
  }

  async getCapabilities() {
    return { ...this.capabilities };
  }

  async getReasoningOptions() {
    return [{ value: 'auto', label: 'Auto · managed by ZCode/model' }];
  }

  async start({ cwd = '.', permission = 'ask', binding = null } = {}) {
    return {
      ok: true,
      backend: this.id,
      executor: this.name,
      sessionId: binding && binding.sessionId || '',
      resumed: Boolean(binding && binding.sessionId),
      permission,
      cwd,
      protocol: this.protocol,
      transport: 'zcode-cli',
    };
  }

  async send({ prompt, cwd = '.', permission = 'ask', approve, binding = null, attachments = [] } = {}) {
    const status = await this.detect();
    if (!status.runnable) return { ok: false, backend: this.id, error: status.detail || 'ZCode CLI is unavailable.' };
    const credential = this.loadDesktopCredential();
    if (!credential) return { ok: false, backend: this.id, error: 'ZCode Desktop credential bridge is unavailable.' };

    if (permission === 'ask') {
      if (typeof approve !== 'function') return { ok: false, backend: this.id, denied: true, error: 'Approval required before ZCode may execute changes.' };
      const allowed = await approve({
        name: 'zcode_agent_run',
        args: { cwd, prompt },
        description: `ZCode may modify the workspace for this turn.\n\nWorking directory: ${cwd}\n\n${truncate(prompt, 1800)}`,
      });
      if (!allowed) return { ok: false, backend: this.id, denied: true, error: 'User denied ZCode agent execution.' };
    }

    const workingDirectory = resolveInside(this.rootPath, cwd || '.');
    const normalizedCwd = path.relative(this.rootPath, workingDirectory) || '.';
    const canResume = Boolean(binding && binding.sessionId && (!binding.permission || binding.permission === permission) && (!binding.cwd || binding.cwd === normalizedCwd));
    const mode = permission === 'read-only' ? 'plan' : permission === 'allow-edits' ? 'build' : 'edit';
    const args = [status.executable, '--cwd', workingDirectory, '--mode', mode, '--json'];
    for (const attachment of attachments || []) {
      if (attachment && attachment.absolutePath) args.push('--attach', attachment.absolutePath);
    }
    if (canResume) args.push('--resume', binding.sessionId);
    args.push('--prompt', String(prompt || ''));

    const inherited = inheritedAgentEnv();
    const zcodeProxy = inherited.HTTPS_PROXY || inherited.HTTP_PROXY || '';
    const result = await execFileCapture(status.launcher, args, {
      cwd: workingDirectory,
      env: {
        ZCODE_API_KEY: credential.apiKey,
        OPENCODE_API_KEY: credential.apiKey,
        ...(zcodeProxy ? { ZCODE_HTTP_PROXY: zcodeProxy } : {}),
      },
    });
    const events = parseJsonLines(result.stdout);
    const combined = `${result.stdout}\n${result.stderr}`;
    const sessionId = events.map((event) => findDeepString(event, ['sessionId', 'sessionID', 'session_id'])).find(Boolean)
      || ((combined.match(/\bsess_[A-Za-z0-9_-]+\b/) || [])[0])
      || (binding && binding.sessionId)
      || '';
    return {
      ok: result.ok,
      backend: this.id,
      executor: this.name,
      protocol: this.protocol,
      transport: 'zcode-cli',
      sessionId,
      resumed: canResume,
      permission,
      cwd: normalizedCwd,
      output: extractLikelyFinalText(events, result.stdout),
      stderr: truncate(result.stderr, 12000),
      code: result.code,
      error: result.ok ? '' : result.error || result.stderr || 'ZCode task failed.',
    };
  }
}

function createZCodeCliAgentBackend(options = {}) {
  return new ZCodeCliAgentBackend(options);
}

function createOpenCodeCliFallback(options = {}) {
  return new OpenCodeCliAgentBackend(options);
}

module.exports = {
  OpenCodeCliAgentBackend,
  ZCodeCliAgentBackend,
  createZCodeCliAgentBackend,
  createOpenCodeCliFallback,
};
