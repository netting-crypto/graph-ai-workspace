const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { AgentBackend } = require('../backend');

function truncate(value, max = 50000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function macSystemProxyEnv() {
  if (process.platform !== 'darwin') return {};
  try {
    const result = require('child_process').execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const read = (key) => {
      const match = String(result || '').match(new RegExp(`\\b${key}\\s*:\\s*([^\\n]+)`));
      return match ? match[1].trim() : '';
    };
    const enabled = (key) => read(key) === '1';
    const env = {};
    if (enabled('HTTPEnable') && read('HTTPProxy') && read('HTTPPort')) {
      const url = `http://${read('HTTPProxy')}:${read('HTTPPort')}`;
      env.HTTP_PROXY = url;
      env.http_proxy = url;
    }
    if (enabled('HTTPSEnable') && read('HTTPSProxy') && read('HTTPSPort')) {
      const url = `http://${read('HTTPSProxy')}:${read('HTTPSPort')}`;
      env.HTTPS_PROXY = url;
      env.https_proxy = url;
    }
    if (enabled('SOCKSEnable') && read('SOCKSProxy') && read('SOCKSPort')) {
      const url = `socks5://${read('SOCKSProxy')}:${read('SOCKSPort')}`;
      env.ALL_PROXY = url;
      env.all_proxy = url;
    }
    return env;
  } catch (_) {
    return {};
  }
}

function inheritedAgentEnv(extra = {}) {
  return { ...process.env, ...macSystemProxyEnv(), ...(extra || {}) };
}

function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function resolveCodexExecutable(explicitPath = '') {
  const home = os.homedir();
  const candidates = [];
  if (explicitPath) candidates.push(path.resolve(String(explicitPath).replace(/^~(?=$|\/)/, home)));
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) candidates.push(path.join(dir, 'codex'));
  candidates.push(
    path.join(home, '.codex', 'packages', 'standalone', 'current', 'codex'),
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.codex', 'plugins', '.plugin-appserver', 'codex'),
    '/Applications/Codex.app/Contents/MacOS/Codex',
  );
  return candidates.find(isExecutable) || '';
}

function resolveInside(rootPath, inputPath = '.') {
  const root = fs.realpathSync(path.resolve(rootPath || process.cwd()));
  const target = fs.realpathSync(path.resolve(root, inputPath || '.'));
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Working directory escapes allowed workspace: ${inputPath}`);
  return target;
}

function execFileCapture(executable, args, { cwd, timeoutMs = 15 * 60 * 1000, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(executable, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: inheritedAgentEnv(env),
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        signal: error && error.signal ? error.signal : null,
        error: error ? error.message || String(error) : '',
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
    if (child && child.stdin) child.stdin.end();
  });
}

function parseJsonLines(text) {
  const events = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || (!line.startsWith('{') && !line.startsWith('['))) continue;
    try { events.push(JSON.parse(line)); } catch (_) {}
  }
  return events;
}

function findDeepString(value, keys) {
  if (!value || typeof value !== 'object') return '';
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findDeepString(child, keys);
      if (found) return found;
    }
  }
  return '';
}

function extractLikelyFinalText(events, fallback = '') {
  const preferred = [];
  for (const event of events || []) {
    const item = event && event.item && typeof event.item === 'object' ? event.item : null;
    const type = String(item && (item.type || item.kind) || event && (event.type || event.kind) || '').toLowerCase();
    if (!type.includes('agent_message') && type !== 'message' && !type.includes('text')) continue;
    const text = findDeepString(item || event, ['text', 'content', 'message', 'output']);
    if (text) preferred.push(text);
  }
  return preferred[preferred.length - 1] || String(fallback || '').trim();
}

function extractFinalTextFromTurn(turn) {
  const items = turn && Array.isArray(turn.items) ? turn.items : [];
  const messages = items.filter((item) => item && item.type === 'agentMessage' && typeof item.text === 'string');
  const final = [...messages].reverse().find((item) => item.phase === 'final_answer') || messages[messages.length - 1];
  return final && final.text ? final.text : '';
}

function codexNotificationToRuntimeUpdate(message = {}) {
  const method = String(message.method || '');
  const params = message.params || {};
  const delta = typeof params.delta === 'string'
    ? params.delta
    : typeof params.text === 'string'
      ? params.text
      : '';
  if (method === 'item/reasoning/summaryTextDelta' && delta) {
    return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta } };
  }
  if (/agentMessage/i.test(method) && /delta/i.test(method) && delta) {
    return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } };
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = params.item || {};
    const itemType = String(item.type || '');
    const toolTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch']);
    if (!toolTypes.has(itemType)) return null;
    const kind = itemType === 'commandExecution' ? 'execute'
      : itemType === 'fileChange' ? 'edit'
        : itemType === 'webSearch' ? 'search'
          : 'other';
    return {
      sessionUpdate: method === 'item/started' ? 'tool_call' : 'tool_call_update',
      toolCallId: item.id || '',
      title: String(item.command || item.name || item.tool || itemType),
      kind,
      status: method === 'item/started' ? 'pending' : (item.status === 'failed' ? 'failed' : 'completed'),
      rawInput: item.command || item.arguments || item.input || '',
      rawOutput: item.output || item.aggregatedOutput || item.result || '',
      locations: Array.isArray(item.changes)
        ? item.changes.map((change) => ({ path: change.path || change.filePath || '' })).filter((entry) => entry.path)
        : [],
    };
  }
  return null;
}

class CodexAppServerClient {
  constructor({ executable, rootPath, isolated = true } = {}) {
    this.executable = executable;
    this.rootPath = rootPath;
    this.isolated = isolated;
    this.child = null;
    this.buffer = '';
    this.sequence = 1;
    this.pending = new Map();
    this.turnWaiters = new Map();
    this.turnListeners = new Map();
    this.loadedThreads = new Set();
    this.startPromise = null;
  }

  async ensureStarted() {
    if (this.child && !this.child.killed && this.child.exitCode == null) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start();
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  async _start() {
    const args = ['app-server', '--stdio'];
    if (this.isolated) {
      args.push(
        '--disable', 'plugins',
        '--disable', 'remote_plugin',
        '-c', 'mcp_servers.node_repl.enabled=false',
        '-c', 'mcp_servers.computer-use.enabled=false',
      );
    }
    const child = spawn(this.executable, args, {
      cwd: this.rootPath,
      env: inheritedAgentEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.buffer = '';
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text && !/failed to refresh available models: timeout waiting for child process to exit/i.test(text)) {
        console.warn('[Graph AI] Codex app-server:', text);
      }
    });
    child.on('error', (error) => this._failAll(error));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.loadedThreads.clear();
      this._failAll(new Error(`Codex app-server exited (${code ?? 'no-code'}${signal ? `, ${signal}` : ''}).`));
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex app-server spawn timed out.')), 10000);
      child.once('spawn', () => { clearTimeout(timer); resolve(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    await this._requestRaw('initialize', {
      clientInfo: { name: 'graph-ai-workspace', title: 'Graph AI Workspace', version: '0.9.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, 20000);
    this._notify('initialized');
  }

  _onStdout(chunk) {
    this.buffer += String(chunk || '');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (_) { continue; }
      if (message.id != null && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result);
        continue;
      }
      if (message.method === 'turn/completed' && message.params && message.params.turn) {
        const key = `${message.params.threadId}:${message.params.turn.id}`;
        const listener = this.turnListeners.get(key);
        if (listener) {
          try { listener(message); } catch (_) {}
          this.turnListeners.delete(key);
        }
        const waiter = this.turnWaiters.get(key);
        if (waiter) {
          this.turnWaiters.delete(key);
          clearTimeout(waiter.timer);
          waiter.resolve(message.params.turn);
        }
        continue;
      }
      const threadId = message.params && message.params.threadId;
      const turnId = message.params && message.params.turnId;
      const listener = threadId && turnId ? this.turnListeners.get(`${threadId}:${turnId}`) : null;
      if (listener) {
        try { listener(message); } catch (_) {}
      }
    }
  }

  _failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.turnWaiters.clear();
    this.turnListeners.clear();
  }

  _notify(method, params) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) return;
    const payload = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  _requestRaw(method, params, timeoutMs = 15 * 60 * 1000) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) return Promise.reject(new Error('Codex app-server is not running.'));
    const id = this.sequence++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  async request(method, params, timeoutMs) {
    await this.ensureStarted();
    return this._requestRaw(method, params, timeoutMs);
  }

  async listModels() {
    const result = await this.request('model/list', { limit: 50, includeHidden: false }, 30000);
    return result && Array.isArray(result.data) ? result.data : [];
  }

  async ensureThread({ sessionId = '', cwd, permission = 'read-only', modelId = '' } = {}) {
    await this.ensureStarted();
    const sandbox = permission === 'read-only' ? 'read-only' : 'workspace-write';
    if (sessionId && this.loadedThreads.has(sessionId)) return { threadId: sessionId, resumed: true };
    if (sessionId) {
      try {
        const resumed = await this._requestRaw('thread/resume', {
          threadId: sessionId,
          cwd,
          approvalPolicy: 'never',
          sandbox,
          excludeTurns: true,
        }, 60000);
        const threadId = resumed && resumed.thread && resumed.thread.id || sessionId;
        this.loadedThreads.add(threadId);
        return { threadId, resumed: true };
      } catch (error) {
        console.warn('[Graph AI] Codex thread resume failed; starting a fresh thread.', error);
      }
    }
    const startParams = {
      cwd,
      approvalPolicy: 'never',
      sandbox,
      ephemeral: false,
    };
    if (modelId) startParams.model = modelId;
    const started = await this._requestRaw('thread/start', startParams, 60000);
    const threadId = started && started.thread && started.thread.id;
    if (!threadId) throw new Error('Codex app-server did not return a thread id.');
    this.loadedThreads.add(threadId);
    return { threadId, resumed: false };
  }

  async runTurn({ threadId, prompt, attachments = [], reasoningEffort = 'auto', onNotification = null } = {}) {
    await this.ensureStarted();
    const input = [{ type: 'text', text: String(prompt || ''), text_elements: [] }];
    for (const attachment of attachments || []) {
      if (attachment && attachment.absolutePath) input.push({ type: 'localImage', path: attachment.absolutePath });
    }
    const params = { threadId, input, summary: 'auto' };
    if (reasoningEffort && reasoningEffort !== 'auto') params.effort = reasoningEffort;
    const started = await this._requestRaw('turn/start', params, 60000);
    const turnId = started && started.turn && started.turn.id;
    if (!turnId) throw new Error('Codex app-server did not return a turn id.');
    const key = `${threadId}:${turnId}`;
    if (onNotification) this.turnListeners.set(key, onNotification);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(key);
        this.turnListeners.delete(key);
        reject(new Error('Codex app-server turn timed out.'));
      }, 15 * 60 * 1000);
      this.turnWaiters.set(key, { resolve, reject, timer });
    });
  }

  dispose() {
    const child = this.child;
    this.child = null;
    this.loadedThreads.clear();
    this.turnListeners.clear();
    this._failAll(new Error('Codex app-server client disposed.'));
    if (child && child.exitCode == null && !child.killed) {
      try { child.kill(); } catch (_) {}
    }
  }
}

class CodexAgentBackend extends AgentBackend {
  constructor({
    rootPath = process.cwd(),
    explicitPath = '',
    isolated,
    ignoreUserConfig,
    allowExecFallback = true,
    appServerEnabled = true,
  } = {}) {
    super({
      id: 'codex',
      name: 'Codex',
      protocol: 'codex-app-server',
      capabilities: {
        persistentSession: true,
        resume: true,
        nativeFork: false,
        vision: true,
        attachments: true,
        reasoningEffort: true,
        reasoningLevels: [],
        tools: true,
        skills: false,
        safeStop: false,
        interactiveInput: false,
        plan: true,
        diff: true,
        permissions: true,
      },
    });
    this.rootPath = path.resolve(rootPath || process.cwd());
    this.explicitPath = explicitPath;
    this.isolated = isolated !== undefined ? isolated : ignoreUserConfig !== false;
    this.appServerEnabled = appServerEnabled !== false;
    this.allowExecFallback = allowExecFallback !== false;
    this.client = null;
    this.statusCache = null;
  }

  resolve() {
    return resolveCodexExecutable(this.explicitPath);
  }

  _client(executable) {
    if (!this.client || this.client.executable !== executable) {
      if (this.client) this.client.dispose();
      this.client = new CodexAppServerClient({ executable, rootPath: this.rootPath, isolated: this.isolated });
    }
    return this.client;
  }

  async detect({ refresh = false } = {}) {
    if (!refresh && this.statusCache) return { ...this.statusCache };
    const executable = this.resolve();
    if (!executable) {
      this.statusCache = { id: this.id, name: this.name, protocol: this.protocol, available: false, runnable: false, executable: '', detail: 'Codex CLI not found.' };
      return { ...this.statusCache };
    }
    const [version, auth] = await Promise.all([
      execFileCapture(executable, ['--version'], { cwd: this.rootPath, timeoutMs: 8000 }),
      execFileCapture(executable, ['login', 'status'], { cwd: this.rootPath, timeoutMs: 8000 }),
    ]);
    const versionText = (version.stdout || version.stderr || '').trim();
    const authText = `${auth.stdout}\n${auth.stderr}`.trim();
    const authenticated = auth.ok && /logged in/i.test(authText);
    this.statusCache = {
      id: this.id,
      name: this.name,
      protocol: this.protocol,
      available: true,
      runnable: Boolean(version.ok && authenticated),
      authenticated,
      executable,
      detail: authenticated ? `${truncate(versionText, 160)} · ChatGPT signed in · persistent app-server` : `${truncate(versionText, 160)} · ${authText || 'Not signed in'}`,
    };
    return { ...this.statusCache };
  }

  async getCapabilities() {
    const capabilities = { ...this.capabilities };
    const status = await this.detect();
    if (!status.runnable) return capabilities;
    try {
      const models = await this._client(status.executable).listModels();
      const model = models.find((item) => item && item.isDefault) || models[0];
      capabilities.reasoningLevels = model && Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.map((item) => item.reasoningEffort).filter(Boolean)
        : [];
      capabilities.reasoningEffort = capabilities.reasoningLevels.length > 0;
      capabilities.defaultReasoningEffort = model && model.defaultReasoningEffort || '';
    } catch (_) {}
    return capabilities;
  }

  async getReasoningOptions(modelId = '') {
    if (modelId) {
      const status = await this.detect();
      if (status.runnable) {
        try {
          const models = await this._client(status.executable).listModels();
          const model = models.find((item) => item && (item.id === modelId || item.model === modelId));
          if (model) {
            const levels = Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts.map((item) => ({ value: item.reasoningEffort, label: item.reasoningEffort, description: item.description || '' })).filter((item) => item.value)
              : [];
            return [{ value: 'auto', label: `Auto${model.defaultReasoningEffort ? ` (${model.defaultReasoningEffort})` : ''}` }, ...levels];
          }
        } catch (_) {}
      }
    }
    const caps = await this.getCapabilities();
    return [
      { value: 'auto', label: `Auto${caps.defaultReasoningEffort ? ` (${caps.defaultReasoningEffort})` : ''}` },
      ...(caps.reasoningLevels || []).map((value) => ({ value, label: value })),
    ];
  }

  async getModelOptions() {
    const status = await this.detect();
    if (!status.runnable) return [];
    try {
      const models = await this._client(status.executable).listModels();
      return models.map((item) => ({
        value: item.id || item.model,
        label: item.displayName || item.name || item.id || item.model,
        current: Boolean(item.isDefault),
        description: item.description || '',
      })).filter((item) => item.value);
    } catch (_) {
      return [];
    }
  }

  async start({ cwd = '.', permission = 'ask', binding = null, modelId = '' } = {}) {
    const status = await this.detect();
    if (!status.runnable) return { ok: false, backend: this.id, error: status.detail || 'Codex is unavailable.' };
    if (!this.appServerEnabled) return { ok: false, backend: this.id, error: 'Codex persistent app-server is disabled.' };
    const workingDirectory = resolveInside(this.rootPath, cwd || '.');
    const normalizedCwd = path.relative(this.rootPath, workingDirectory) || '.';
    const canResume = Boolean(binding && binding.sessionId && (!binding.permission || binding.permission === permission) && (!binding.cwd || binding.cwd === normalizedCwd));
    const thread = await this._client(status.executable).ensureThread({
      sessionId: canResume ? binding.sessionId : '',
      cwd: workingDirectory,
      permission,
      modelId,
    });
    return {
      ok: true,
      backend: this.id,
      executor: this.name,
      sessionId: thread.threadId,
      resumed: thread.resumed,
      permission,
      cwd: normalizedCwd,
      protocol: this.protocol,
      transport: 'app-server',
      modelId: modelId || binding && binding.modelId || '',
      prepared: true,
    };
  }

  async send({ prompt, cwd = '.', permission = 'ask', approve, binding = null, attachments = [], reasoningEffort = 'auto', modelId = '', onRuntimeUpdate = null } = {}) {
    const status = await this.detect();
    if (!status.runnable) return { ok: false, backend: this.id, error: status.detail || 'Codex is unavailable.' };
    if (permission === 'ask') {
      if (typeof approve !== 'function') return { ok: false, backend: this.id, denied: true, error: 'Approval is required before Codex may execute with workspace-write access.' };
      const allowed = await approve({
        name: 'codex_agent_run',
        args: { cwd, prompt },
        description: `Codex may use workspace-write tools for this turn.\n\nWorking directory: ${cwd}\n\n${truncate(prompt, 1800)}`,
      });
      if (!allowed) return { ok: false, backend: this.id, denied: true, error: 'User denied Codex agent execution.' };
    }
    const workingDirectory = resolveInside(this.rootPath, cwd || '.');
    const normalizedCwd = path.relative(this.rootPath, workingDirectory) || '.';
    const canResume = Boolean(binding && binding.sessionId && (!binding.permission || binding.permission === permission) && (!binding.cwd || binding.cwd === normalizedCwd));
    try {
      if (!this.appServerEnabled) throw new Error('Codex persistent app-server is disabled.');
      const client = this._client(status.executable);
      const thread = await client.ensureThread({
        sessionId: canResume ? binding.sessionId : '',
        cwd: workingDirectory,
        permission,
        modelId,
      });
      const turn = await client.runTurn({
        threadId: thread.threadId,
        prompt,
        attachments,
        reasoningEffort,
        onNotification: onRuntimeUpdate
          ? (message) => {
              const update = codexNotificationToRuntimeUpdate(message);
              if (update) onRuntimeUpdate(update, { sessionId: thread.threadId });
            }
          : null,
      });
      const output = extractFinalTextFromTurn(turn);
      if (!output && turn && turn.status === 'failed') throw new Error(turn.error && (turn.error.message || turn.error.code) || 'Codex turn failed.');
      return {
        ok: true,
        backend: this.id,
        executor: this.name,
        sessionId: thread.threadId,
        resumed: thread.resumed,
        permission,
        cwd: normalizedCwd,
        protocol: this.protocol,
        transport: 'app-server',
        modelId: modelId || binding && binding.modelId || '',
        output: output || 'Codex finished without a text response.',
        error: '',
      };
    } catch (error) {
      if (!this.allowExecFallback) return { ok: false, backend: this.id, error: error.message || String(error) };
      if (this.client) this.client.dispose();
      this.client = null;
      return this._execFallback({
        executable: status.executable,
        prompt,
        workingDirectory,
        normalizedCwd,
        permission,
        binding: canResume ? binding : null,
        attachments,
        reasoningEffort,
        modelId,
        fallbackReason: error.message || String(error),
      });
    }
  }

  async _execFallback({ executable, prompt, workingDirectory, normalizedCwd, permission, binding, attachments, reasoningEffort, modelId = '', fallbackReason }) {
    const isolatedArgs = this.isolated ? ['--ignore-user-config'] : [];
    const imageArgs = (attachments || []).filter((item) => item && item.absolutePath).flatMap((item) => ['--image', item.absolutePath]);
    const reasoningArgs = reasoningEffort && reasoningEffort !== 'auto' ? ['--config', `model_reasoning_effort=\"${reasoningEffort}\"`] : [];
    const modelArgs = modelId ? ['--model', modelId] : [];
    const sessionId = binding && binding.sessionId || '';
    const args = sessionId
      ? ['exec', 'resume', ...isolatedArgs, ...modelArgs, ...reasoningArgs, '--json', '--skip-git-repo-check', ...imageArgs, sessionId, String(prompt || '')]
      : ['exec', ...isolatedArgs, ...modelArgs, ...reasoningArgs, '--json', '--skip-git-repo-check', '--sandbox', permission === 'read-only' ? 'read-only' : 'workspace-write', '--cd', workingDirectory, ...imageArgs, String(prompt || '')];
    const result = await execFileCapture(executable, args, { cwd: workingDirectory });
    const events = parseJsonLines(result.stdout);
    const nextSessionId = events.map((event) => findDeepString(event, ['thread_id', 'session_id', 'threadId', 'sessionId'])).find(Boolean) || sessionId;
    return {
      ok: result.ok,
      backend: this.id,
      executor: this.name,
      sessionId: nextSessionId || '',
      resumed: Boolean(sessionId),
      permission,
      cwd: normalizedCwd,
      protocol: 'codex-cli-fallback',
      transport: 'codex-exec-fallback',
      modelId: modelId || binding && binding.modelId || '',
      output: extractLikelyFinalText(events, result.stdout) || 'Codex finished without a text response.',
      stderr: truncate(result.stderr, 12000),
      code: result.code,
      fallbackReason,
      error: result.ok ? '' : result.error || result.stderr || 'Codex task failed.',
    };
  }

  async stop() {
    // Current Codex app-server integration does not yet expose a stable turn-id
    // handle at this abstraction boundary. Keep stop capability false until it does.
    return false;
  }

  close() {
    if (this.client) this.client.dispose();
    this.client = null;
  }
}

module.exports = {
  CodexAgentBackend,
  CodexNativeAgentBackend: CodexAgentBackend,
  CodexAppServerClient,
  resolveCodexExecutable,
  inheritedAgentEnv,
};
