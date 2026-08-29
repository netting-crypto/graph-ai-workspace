const fs = require('fs');
const { spawn } = require('child_process');
const { AgentBackend } = require('../backend');

function permissionEnv(permission = 'ask') {
  let permissionConfig;
  if (permission === 'read-only') {
    permissionConfig = {
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      lsp: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
    };
  } else if (permission === 'allow-edits') {
    permissionConfig = {
      '*': 'allow',
      external_directory: 'deny',
    };
  } else {
    permissionConfig = {
      '*': 'ask',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      lsp: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
      external_directory: 'deny',
    };
  }
  return {
    // OpenCode documents OPENCODE_CONFIG_CONTENT as the highest-priority
    // runtime override. This keeps Graph AI permissions session-local without
    // modifying the user's global/project OpenCode config.
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: permissionConfig }),
  };
}

class AcpProcessClient {
  constructor({ command, args = [], cwd = '.', env = process.env, clientInfo = null, timeoutMs = 120000 } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.clientInfo = clientInfo || { name: 'graph-ai-workspace', version: '0.9.0' };
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.sessionListeners = new Map();
    this.permissionResolvers = new Map();
    this.initializeResult = null;
    this.startPromise = null;
  }

  async start() {
    if (this.initializeResult && this.child && !this.child.killed) return this.initializeResult;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async _start() {
    if (!this.command) throw new Error('ACP command is not configured.');
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.child.stderr.on('data', () => {});
    this.child.on('exit', (code, signal) => {
      const error = new Error(`ACP process exited (${code ?? 'null'}${signal ? `, ${signal}` : ''}).`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.child = null;
      this.initializeResult = null;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ACP process spawn timed out.')), 10000);
      this.child.once('spawn', () => { clearTimeout(timer); resolve(); });
      this.child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    this.initializeResult = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: this.clientInfo,
    }, 20000);
    return this.initializeResult;
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
      this._handleMessage(message);
    }
  }

  _handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method === 'session/update') {
      const sessionId = message.params && message.params.sessionId;
      const listener = sessionId && this.sessionListeners.get(sessionId);
      if (listener) listener(message.params.update || {}, message);
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      if (message.method === 'session/request_permission') {
        this._handlePermissionRequest(message).catch((error) => {
          this.respondError(message.id, -32603, error.message || String(error));
        });
        return;
      }
      // Graph AI declares no fs/terminal client capabilities. Unknown reverse
      // requests stay explicit instead of silently granting extra access.
      this.respondError(message.id, -32601, `Graph AI client does not handle ACP request: ${message.method}`);
    }
  }

  async _handlePermissionRequest(message) {
    const params = message.params || {};
    const sessionId = params.sessionId || '';
    const resolver = this.permissionResolvers.get(sessionId);
    const options = Array.isArray(params.options) ? params.options : [];
    let allowed = false;
    if (typeof resolver === 'function') {
      const toolCall = params.toolCall || {};
      allowed = Boolean(await resolver({
        name: 'agent_permission',
        args: { sessionId, toolCall, options },
        description: `${toolCall.title || toolCall.kind || 'Agent tool'}\n\n${JSON.stringify(toolCall.rawInput || {}, null, 2)}`,
      }));
    }
    if (!allowed) {
      const rejected = options.find((option) => option.kind === 'reject_once')
        || options.find((option) => option.optionId === 'reject');
      const outcome = rejected && rejected.optionId
        ? { outcome: 'selected', optionId: rejected.optionId }
        : { outcome: 'cancelled' };
      this._write({ jsonrpc: '2.0', id: message.id, result: { outcome } });
      return;
    }
    const selected = options.find((option) => ['allow_once', 'allow_always'].includes(option.kind)) || options[0];
    if (!selected || !selected.optionId) {
      this._write({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    this._write({
      jsonrpc: '2.0',
      id: message.id,
      result: { outcome: { outcome: 'selected', optionId: selected.optionId } },
    });
  }

  _write(message) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) throw new Error('ACP process is not running.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer, method });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  respondError(id, code, message) {
    try { this._write({ jsonrpc: '2.0', id, error: { code, message } }); } catch (_) {}
  }

  setSessionListener(sessionId, listener) {
    if (!sessionId) return;
    if (listener) this.sessionListeners.set(sessionId, listener);
    else this.sessionListeners.delete(sessionId);
  }

  async newSession({ cwd = this.cwd } = {}) {
    await this.start();
    return this.request('session/new', { cwd, mcpServers: [] }, 30000);
  }

  async resumeSession(sessionId, { cwd = this.cwd } = {}) {
    await this.start();
    const result = await this.request('session/resume', { sessionId, cwd, mcpServers: [] }, 30000);
    return { ...result, sessionId };
  }

  async setConfigOption(sessionId, configId, value) {
    return this.request('session/set_config_option', { sessionId, configId, value }, 20000);
  }

  async prompt(sessionId, promptBlocks, { onUpdate = null, approve = null } = {}) {
    const chunks = [];
    const updates = [];
    this.setSessionListener(sessionId, (update) => {
      updates.push(update);
      if (update.sessionUpdate === 'agent_message_chunk' && update.content && update.content.type === 'text') {
        chunks.push(String(update.content.text || ''));
      }
      if (onUpdate) onUpdate(update);
    });
    if (approve) this.permissionResolvers.set(sessionId, approve);
    try {
      const result = await this.request('session/prompt', { sessionId, prompt: promptBlocks }, this.timeoutMs);
      return { result, output: chunks.join(''), updates };
    } finally {
      this.setSessionListener(sessionId, null);
      this.permissionResolvers.delete(sessionId);
    }
  }

  async closeSession(sessionId) {
    if (!sessionId) return false;
    await this.start();
    try {
      await this.request('session/close', { sessionId }, 15000);
      return true;
    } catch (_) {
      return false;
    }
  }

  cancelSession(sessionId) {
    if (!sessionId || !this.child) return false;
    try {
      this.notify('session/cancel', { sessionId });
      return true;
    } catch (_) {
      return false;
    }
  }

  close() {
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
    this.initializeResult = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ACP client closed.'));
    }
    this.pending.clear();
    this.sessionListeners.clear();
    this.permissionResolvers.clear();
  }
}

class AcpAgentBackend extends AgentBackend {
  constructor({ id, name, command, args = [], rootPath, env, capabilities = {}, fallback = null, model = '', visionModel = '' } = {}) {
    super({ id, name, protocol: 'acp', capabilities });
    this.command = command;
    this.args = args;
    this.rootPath = rootPath;
    this.env = env;
    this.fallback = fallback;
    this.model = model;
    this.visionModel = visionModel;
    this.client = null;
    this.clientPermission = '';
    this.lastInitialize = null;
    this.lastConfigOptions = [];
  }

  _client(permission = 'ask') {
    if (this.client && this.clientPermission !== permission) {
      this.client.close();
      this.client = null;
    }
    if (!this.client) {
      this.clientPermission = permission;
      this.client = new AcpProcessClient({
        command: this.command,
        args: this.args,
        cwd: this.rootPath,
        env: { ...process.env, ...(this.env || {}), ...permissionEnv(permission) },
        clientInfo: { name: 'graph-ai-workspace', version: '0.9.0' },
      });
    }
    return this.client;
  }

  async detect() {
    try {
      this.lastInitialize = await this._client('ask').start();
      return {
        id: this.id,
        name: this.name,
        protocol: 'acp',
        available: true,
        runnable: true,
        detail: `${this.lastInitialize.agentInfo && this.lastInitialize.agentInfo.name || this.name} ${this.lastInitialize.agentInfo && this.lastInitialize.agentInfo.version || ''} · ACP`,
      };
    } catch (error) {
      if (this.fallback) {
        const fallbackStatus = await this.fallback.detect();
        return { ...fallbackStatus, id: this.id, name: this.name, protocol: 'cli-fallback', detail: `${fallbackStatus.detail} · ACP unavailable: ${error.message || error}` };
      }
      return { id: this.id, name: this.name, protocol: 'acp', available: false, runnable: false, detail: error.message || String(error) };
    }
  }

  async getCapabilities() {
    let fallbackCaps = {};
    if (this.fallback && typeof this.fallback.getCapabilities === 'function') {
      try { fallbackCaps = await this.fallback.getCapabilities(); } catch (_) {}
    }
    try {
      this.lastInitialize = this.lastInitialize || await this._client('ask').start();
      const agentCaps = this.lastInitialize.agentCapabilities || {};
      const sessions = agentCaps.sessionCapabilities || {};
      const prompt = agentCaps.promptCapabilities || {};
      const effort = (this.lastConfigOptions || []).find((item) => item.category === 'thought_level' || item.id === 'effort');
      return {
        ...this.capabilities,
        ...fallbackCaps,
        persistentSession: true,
        resume: Boolean(sessions.resume || agentCaps.loadSession),
        nativeFork: Boolean(sessions.fork),
        vision: Boolean(prompt.image && (this.visionModel || fallbackCaps.vision || this.capabilities.vision)),
        attachments: Boolean(prompt.embeddedContext) || Boolean(prompt.image && (this.visionModel || fallbackCaps.attachments || this.capabilities.attachments)),
        safeStop: Boolean(sessions.close),
        reasoningEffort: Boolean(effort) || Boolean((fallbackCaps.reasoningLevels || []).length) || Boolean(fallbackCaps.reasoningEffort) || Boolean(this.capabilities.reasoningEffort),
        reasoningLevels: effort && Array.isArray(effort.options)
          ? effort.options.map((item) => ({ value: item.value, label: item.name || item.value, description: item.description || '' }))
          : (fallbackCaps.reasoningLevels || this.capabilities.reasoningLevels || []).slice(),
      };
    } catch (_) {
      return { ...this.capabilities, ...fallbackCaps };
    }
  }

  async _configure(client, sessionId, {
    permission = 'ask',
    reasoningEffort = 'auto',
    configOptions = [],
    modelOverride = '',
    skipModelConfig = false,
  } = {}) {
    let options = Array.isArray(configOptions) ? configOptions : [];
    const targetModel = skipModelConfig ? '' : (modelOverride || this.model);
    const modelOption = options.find((item) => item.category === 'model' || item.id === 'model');
    if (targetModel && (!modelOption || modelOption.currentValue !== targetModel)) {
      try {
        const result = await client.setConfigOption(sessionId, modelOption && modelOption.id || 'model', targetModel);
        if (result && Array.isArray(result.configOptions)) options = result.configOptions;
      } catch (_) {}
    }
    const effort = options.find((item) => item.category === 'thought_level' || item.id === 'effort');
    if (effort && reasoningEffort && reasoningEffort !== 'auto') {
      const valid = Array.isArray(effort.options) && effort.options.some((item) => item.value === reasoningEffort);
      if (valid && effort.currentValue !== reasoningEffort) {
        try {
          const result = await client.setConfigOption(sessionId, effort.id, reasoningEffort);
          if (result && Array.isArray(result.configOptions)) options = result.configOptions;
        } catch (_) {}
      }
    }
    const mode = options.find((item) => item.category === 'mode' || item.id === 'mode');
    const wantedMode = permission === 'read-only' ? 'plan' : 'build';
    if (mode && mode.currentValue !== wantedMode) {
      try {
        const result = await client.setConfigOption(sessionId, mode.id, wantedMode);
        if (result && Array.isArray(result.configOptions)) options = result.configOptions;
      } catch (_) {}
    }
    this.lastConfigOptions = options;
    return options;
  }

  async start({
    cwd = '.',
    permission = 'ask',
    binding = null,
    reasoningEffort = 'auto',
    modelOverride = '',
    modelId = '',
    skipModelConfig = false,
  } = {}) {
    const client = this._client(permission);
    let result;
    let resumed = false;
    if (binding && binding.sessionId) {
      try {
        result = await client.resumeSession(binding.sessionId, { cwd });
        resumed = true;
      } catch (_) {
        result = await client.newSession({ cwd });
      }
    } else {
      result = await client.newSession({ cwd });
    }
    const configOptions = await this._configure(client, result.sessionId, {
      permission,
      reasoningEffort,
      configOptions: result.configOptions || [],
      modelOverride: modelId || modelOverride,
      skipModelConfig,
    });
    const modelOption = configOptions.find((item) => item.category === 'model' || item.id === 'model');
    return {
      ok: true,
      backend: this.id,
      executor: this.name,
      sessionId: result.sessionId,
      resumed,
      permission,
      cwd: '.',
      protocol: 'acp',
      transport: 'acp-stdio',
      modelId: modelOption && modelOption.currentValue || modelId || modelOverride || '',
      configOptions,
    };
  }

  async send({
    prompt,
    cwd = '.',
    permission = 'ask',
    approve,
    binding = null,
    attachments = [],
    reasoningEffort = 'auto',
    modelId = '',
    onRuntimeUpdate = null,
  } = {}) {
    try {
      const modelOverride = modelId || (attachments && attachments.length && this.visionModel ? this.visionModel : this.model);
      let session = await this.start({ cwd, permission, binding, reasoningEffort, modelOverride, modelId });
      const effortOption = (session.configOptions || []).find((item) => item.category === 'thought_level' || item.id === 'effort');
      if (reasoningEffort && reasoningEffort !== 'auto' && !effortOption && this.fallback) {
        const result = await this.fallback.send({ prompt, cwd, permission, approve, binding, attachments, reasoningEffort, modelId });
        return {
          ...result,
          protocol: 'cli-fallback',
          transport: result.transport || 'cli-fallback',
          fallbackReason: 'ACP session does not expose a reasoning-effort config option.',
        };
      }
      const blocks = [{ type: 'text', text: String(prompt || '') }];
      for (const attachment of attachments || []) {
        if (!attachment || !attachment.absolutePath || !fs.existsSync(attachment.absolutePath)) continue;
        blocks.push({
          type: 'image',
          data: fs.readFileSync(attachment.absolutePath).toString('base64'),
          mimeType: attachment.mime || 'image/png',
        });
      }
      const runPrompt = (activeSession) => this._client(permission).prompt(activeSession.sessionId, blocks, {
        approve,
        onUpdate: onRuntimeUpdate
          ? (update) => onRuntimeUpdate(update, { sessionId: activeSession.sessionId })
          : null,
      });
      let turn;
      let modelFallbackReason = '';
      try {
        turn = await runPrompt(session);
      } catch (promptError) {
        const modelUnavailable = /model\s+(?:is\s+)?unavailable|model.*not available|unknown model/i.test(String(promptError && promptError.message || promptError));
        if (!modelUnavailable || (attachments && attachments.length)) throw promptError;
        session = await this.start({
          cwd,
          permission,
          binding: null,
          reasoningEffort: 'auto',
          modelOverride: '',
          modelId: '',
          skipModelConfig: true,
        });
        modelFallbackReason = `Configured OpenCode model unavailable; used ACP session default instead. ${promptError.message || promptError}`;
        turn = await runPrompt(session);
      }
      return {
        ok: true,
        backend: this.id,
        executor: this.name,
        sessionId: session.sessionId,
        resumed: session.resumed,
        permission,
        cwd: '.',
        protocol: 'acp',
        transport: 'acp-stdio',
        modelId: session.modelId || modelId || '',
        output: turn.output || '',
        stopReason: turn.result && turn.result.stopReason || '',
        acpUpdates: turn.updates,
        configOptions: session.configOptions || [],
        fallbackReason: modelFallbackReason,
        error: '',
      };
    } catch (error) {
      if (!this.fallback) return { ok: false, backend: this.id, error: error.message || String(error) };
      const result = await this.fallback.send({ prompt, cwd, permission, approve, binding, attachments, reasoningEffort, modelId });
      return { ...result, protocol: 'cli-fallback', transport: result.transport || 'cli-fallback', fallbackReason: error.message || String(error) };
    }
  }

  async getReasoningOptions(modelId = '') {
    let probeSessionId = '';
    try {
      const client = this._client('read-only');
      const created = await client.newSession({ cwd: this.rootPath });
      probeSessionId = created.sessionId;
      const configOptions = await this._configure(client, probeSessionId, {
        permission: 'read-only',
        reasoningEffort: 'auto',
        configOptions: created.configOptions || [],
        modelOverride: modelId,
      });
      const effort = configOptions.find((item) => item.category === 'thought_level' || item.id === 'effort');
      if (!effort || !Array.isArray(effort.options) || !effort.options.length) {
        return [{ value: 'auto', label: 'Auto · Agent managed' }];
      }
      return [
        { value: 'auto', label: 'Auto' },
        ...effort.options.map((item) => ({
          value: item.value,
          label: item.name || item.value,
          description: item.description || '',
        })),
      ];
    } finally {
      if (probeSessionId && this.client) {
        try { await this.client.closeSession(probeSessionId); } catch (_) {}
      }
    }
  }

  async getModelOptions() {
    let probeSessionId = '';
    try {
      const client = this._client('read-only');
      const created = await client.newSession({ cwd: this.rootPath });
      probeSessionId = created.sessionId;
      const modelOption = (created.configOptions || []).find((item) => item.category === 'model' || item.id === 'model');
      if (!modelOption || !Array.isArray(modelOption.options)) return [];
      return modelOption.options.map((item) => ({
        value: item.value,
        label: item.name || item.value,
        current: item.value === modelOption.currentValue,
      }));
    } finally {
      if (probeSessionId && this.client) {
        try { await this.client.closeSession(probeSessionId); } catch (_) {}
      }
    }
  }

  async stop({ binding } = {}) {
    return this.client ? this.client.cancelSession(binding && binding.sessionId) : false;
  }

  async closeSession(binding) {
    return this.client ? this.client.closeSession(binding && binding.sessionId) : false;
  }

  close() {
    if (this.client) this.client.close();
    this.client = null;
    this.clientPermission = '';
  }
}

module.exports = { AcpProcessClient, AcpAgentBackend, permissionEnv };
