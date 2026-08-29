const {
  Plugin,
  ItemView,
  Menu,
  Modal,
  Notice,
  MarkdownRenderer,
  PluginSettingTab,
  Setting,
  requestUrl,
  setIcon,
} = require('obsidian');

const { CanonicalStateStore, ContextCompiler } = require('./context-state');
const { LocalAgentRuntime } = require('./agent-runtime');
const { AgentRegistry } = require('./agent/registry');
const { AgentSessionManager } = require('./agent/session-manager');
const { AgentRuntimeController } = require('./agent/runtime');
const { createAgentAdapters } = require('./agent/adapters');
const { createAgentHandoff, renderAgentHandoff } = require('./agent/handoff');
const { LightweightModelRuntime } = require('./lightweight-model-runtime');

const VIEW_TYPE = 'graph-ai-workspace-view';
const PLAYGROUND_PATH = '02 vibe coding/Graph AI Interaction Playground.canvas';

const PLAYGROUND_DISCUSSIONS = {
  'demo-history': [
    { role: 'user', content: '这里我还没太懂，为什么“传播速度”和“内容成熟度”不能直接合成一个判断？' },
    { role: 'assistant', content: '因为它们回答的是两个不同问题：传播速度看“现在扩散得多快”，内容成熟度看“这个梗是否已经被解释、模仿和消费到接近饱和”。一个梗可以传播很快，但仍处在非常早期。' },
    { role: 'user', content: '那如果我只想先保留这个结论，不继续聊呢？', quote: { text: '一个梗可以传播很快，但仍处在非常早期。', sourceLabel: 'From this discussion' } },
    { role: 'assistant', content: '那它更适合用 Add to Canvas 固化成一张普通文字卡片，而不是继续扩大当前 Conversation。' },
  ],
  'demo-child': [
    { role: 'user', content: '我们沿着这个分支继续：内容成熟度具体可以看哪些信号？', quote: { text: '内容成熟度', sourceLabel: 'Forked from 传播速度 vs 内容成熟度' } },
    { role: 'assistant', content: '可以先看是否已经出现稳定模板、跨账号复刻、二创变体，以及评论区是否开始从“第一次见”转向“玩熟梗”。这张卡片代表一个已经从父卡片 Fork 出来的独立思考分支。' },
  ],
};

const PLAYGROUND_META = {
  'demo-child': {
    parentNodeId: 'demo-selection',
    parentLabel: '传播速度 vs 内容成熟度',
    sourceText: '内容成熟度可以作为另一条独立的判断线索。',
  },
};

const DEFAULT_SETTINGS = {
  provider: 'mock',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  desktopBridgeProviderName: 'opencode',
  desktopBridgeModel: 'kimi-k3',
  computerPermission: 'ask',
  localToolsEnabled: true,
  defaultConversationEngine: 'model',
  defaultAgent: 'codex',
  defaultReasoningEffort: 'auto',
  defaultExecutor: 'auto',
  codexIgnoreUserConfig: true,
  codexPersistentAppServer: true,
  openCodeModel: '',
  openCodeVisionModel: '',
  openCodePure: true,
  zcodeNodePath: '',
  zcodeDesktopProviderName: 'opencode',
  executorPaths: {},
  maxToolRounds: 6,
  runtimeConfigVersion: 0,
  cardDiscussions: {},
  cardMeta: {},
  conversations: {},
  cardConversationLinks: {},
  canonicalState: {
    version: 1,
    branches: {},
    checkpoints: {},
    memories: {},
  },
  systemPrompt:
    'You are an AI thinking partner inside an Obsidian project workspace. Use the supplied card context, distinguish facts from suggestions, and keep answers concrete.',
};

function makeId(prefix = 'node') {
  const core = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
  return `${prefix}-${core}`;
}

function firstUsefulLine(text = '') {
  return text
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean) || 'Untitled card';
}

function cloneMessage(message = {}) {
  return {
    ...message,
    quote: message.quote ? { ...message.quote } : undefined,
    contextItems: Array.isArray(message.contextItems)
      ? message.contextItems.map((item) => ({ ...item }))
      : undefined,
    toolRuns: Array.isArray(message.toolRuns)
      ? message.toolRuns.map((run) => ({ ...run }))
      : undefined,
    runtimeEvents: Array.isArray(message.runtimeEvents)
      ? message.runtimeEvents.map((event) => ({
          ...event,
          payload: event && event.payload ? { ...event.payload } : undefined,
        }))
      : undefined,
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map((item) => ({ ...item }))
      : undefined,
  };
}

class ToolApprovalModal extends Modal {
  constructor(app, toolCall) {
    super(app);
    this.toolCall = toolCall;
    this.settled = false;
    this.resolveApproval = null;
    this.promise = new Promise((resolve) => {
      this.resolveApproval = resolve;
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gaw-tool-approval');
    contentEl.createEl('h3', { text: 'Allow local action?' });
    contentEl.createEl('p', {
      text: 'Graph AI wants to perform a modifying action on this Mac.',
      cls: 'gaw-tool-approval-hint',
    });
    contentEl.createEl('pre', {
      text: this.toolCall && this.toolCall.description
        ? this.toolCall.description
        : JSON.stringify(this.toolCall || {}, null, 2),
    });
    const actions = contentEl.createDiv({ cls: 'gaw-tool-approval-actions' });
    const deny = actions.createEl('button', { text: 'Deny' });
    const allow = actions.createEl('button', { text: 'Allow once', cls: 'mod-cta' });
    deny.onclick = () => this.finish(false);
    allow.onclick = () => this.finish(true);
  }

  finish(value) {
    if (this.settled) return;
    this.settled = true;
    this.resolveApproval(Boolean(value));
    this.close();
  }

  onClose() {
    if (!this.settled) {
      this.settled = true;
      this.resolveApproval(false);
    }
    this.contentEl.empty();
  }
}

class ContextPickerModal extends Modal {
  constructor(app, plugin, view) {
    super(app);
    this.plugin = plugin;
    this.view = view;
    this.timer = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gaw-context-picker');
    contentEl.createEl('h3', { text: 'Add context' });
    contentEl.createEl('p', {
      cls: 'gaw-context-picker-hint',
      text: '搜索 Vault 里的笔记或 Canvas 卡片。这里只在你点 + 时出现。',
    });

    const input = contentEl.createEl('input', {
      type: 'search',
      cls: 'gaw-context-picker-input',
      placeholder: 'Search notes or Canvas cards…',
    });
    const results = contentEl.createDiv({ cls: 'gaw-context-picker-results' });

    const renderResults = async () => {
      const query = input.value.trim();
      results.empty();
      if (!query) {
        const recent = await this.plugin.getRecentContextItems(10);
        results.createDiv({ cls: 'gaw-picker-section-title', text: 'Recently edited' });
        if (!recent.length) {
          results.createDiv({ cls: 'gaw-picker-empty', text: '还没有可显示的最近文件。' });
          return;
        }
        for (const item of recent) {
          const row = results.createDiv({ cls: 'gaw-picker-row' });
          const copy = row.createDiv({ cls: 'gaw-picker-copy' });
          copy.createDiv({ cls: 'gaw-picker-title', text: item.label });
          copy.createDiv({ cls: 'gaw-picker-source', text: item.source });
          row.onclick = async () => {
            await this.view.addContextItem(item);
            this.close();
          };
        }
        return;
      }
      results.createDiv({ cls: 'gaw-picker-empty', text: 'Searching…' });
      const items = await this.plugin.searchVault(query);
      results.empty();
      if (!items.length) {
        results.createDiv({ cls: 'gaw-picker-empty', text: '没有找到匹配内容。' });
        return;
      }
      for (const item of items) {
        const row = results.createDiv({ cls: 'gaw-picker-row' });
        const copy = row.createDiv({ cls: 'gaw-picker-copy' });
        copy.createDiv({ cls: 'gaw-picker-title', text: item.label });
        copy.createDiv({ cls: 'gaw-picker-source', text: item.source });
        row.onclick = async () => {
          await this.view.addContextItem(item);
          this.close();
        };
      }
    };

    input.addEventListener('input', () => {
      if (this.timer) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(renderResults, 160);
    });
    window.setTimeout(() => input.focus(), 0);
    renderResults();
  }

  onClose() {
    if (this.timer) window.clearTimeout(this.timer);
    this.contentEl.empty();
  }
}

class ConversationTagModal extends Modal {
  constructor(app, plugin, conversationId, onDone) {
    super(app);
    this.plugin = plugin;
    this.conversationId = conversationId;
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Add tag' });
    const input = contentEl.createEl('input', {
      type: 'text',
      placeholder: '例如：腾讯 / 面试 / 秋招系统',
    });
    input.style.width = '100%';
    const row = contentEl.createDiv({ cls: 'gaw-tag-modal-actions' });
    const cancel = row.createEl('button', { text: 'Cancel' });
    const add = row.createEl('button', { cls: 'mod-cta', text: 'Add' });
    cancel.onclick = () => this.close();
    const submit = async () => {
      const tag = input.value.trim().replace(/^#/, '');
      if (!tag) return;
      await this.plugin.addConversationTag(this.conversationId, tag);
      if (this.onDone) await this.onDone();
      this.close();
    };
    add.onclick = submit;
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        submit();
      }
    });
    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ConversationDeleteModal extends Modal {
  constructor(app, plugin, conversation, onDone) {
    super(app);
    this.plugin = plugin;
    this.conversation = conversation;
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    const title = this.conversation && this.conversation.title ? this.conversation.title : 'Untitled conversation';
    contentEl.createEl('h3', { text: 'Delete conversation?' });
    contentEl.createEl('p', {
      text: `“${title}” will be permanently deleted. Any links from Canvas cards to this conversation will also be removed.`,
    });
    const actions = contentEl.createDiv({ cls: 'gaw-delete-modal-actions' });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    const remove = actions.createEl('button', { cls: 'mod-warning', text: 'Delete' });
    cancel.onclick = () => this.close();
    remove.onclick = async () => {
      remove.disabled = true;
      await this.plugin.deleteConversation(this.conversation.id);
      if (this.onDone) await this.onDone();
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

class GraphAIWorkspaceView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentCard = null;
    this.currentConversationId = null;
    this.screen = 'list';
    this.contextItems = [];
    this.messages = [];
    this.selectedQuote = null;
    this.isThinking = false;
    this.selectedAgent = plugin.settings.defaultAgent || 'codex';
    this.selectedModel = '';
    this.selectedReasoningEffort = plugin.settings.defaultReasoningEffort || 'auto';
    this.imageAttachments = [];
    this.draftText = '';
    this.activeSelectionToolbar = null;
    this.activeTextSelection = null;
    this.liveRuntimeEvents = [];
    this.runtimeUnsubscribe = null;
    this.bottomSafeObserver = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Graph AI';
  }

  getIcon() {
    return 'message-square-more';
  }

  async onOpen() {
    if (this.runtimeUnsubscribe) this.runtimeUnsubscribe();
    this.runtimeUnsubscribe = this.plugin.subscribeRuntimeEvents((event) => this.handleRuntimeEvent(event));
    await this.render();
  }

  async onClose() {
    this.clearConversationSelectionToolbar();
    if (this.runtimeUnsubscribe) this.runtimeUnsubscribe();
    this.runtimeUnsubscribe = null;
    if (this.bottomSafeObserver) this.bottomSafeObserver.disconnect();
    this.bottomSafeObserver = null;
  }

  watchBottomSafeInset(root) {
    if (!root) return;
    if (this.bottomSafeObserver) this.bottomSafeObserver.disconnect();
    const update = () => {
      const statusBar = document.querySelector('.status-bar');
      let safe = 10;
      if (statusBar && statusBar.isConnected) {
        const rootRect = root.getBoundingClientRect();
        const statusRect = statusBar.getBoundingClientRect();
        const overlapsHorizontally = statusRect.right > rootRect.left && statusRect.left < rootRect.right;
        const overlapsVertically = statusRect.bottom > rootRect.top && statusRect.top < rootRect.bottom;
        if (overlapsHorizontally && overlapsVertically) {
          safe = Math.max(safe, Math.ceil(rootRect.bottom - statusRect.top + 6));
        }
      }
      root.style.setProperty('--gaw-bottom-safe', `${safe}px`);
    };
    update();
    if (typeof ResizeObserver !== 'undefined') {
      this.bottomSafeObserver = new ResizeObserver(update);
      this.bottomSafeObserver.observe(root);
    }
  }

  handleRuntimeEvent(event) {
    const payload = event && event.payload || {};
    if (!this.isThinking || !this.currentConversationId || payload.conversationId !== this.currentConversationId) return;
    this.liveRuntimeEvents.push(event);
    if (this.liveRuntimeEvents.length > 80) this.liveRuntimeEvents.splice(0, this.liveRuntimeEvents.length - 80);
    const live = this.containerEl.querySelector('.gaw-live-runtime');
    if (!live) return;
    live.empty();
    this.renderLiveAgentStream(live, { runtimeEvents: this.liveRuntimeEvents });
  }

  clearConversationSelectionToolbar() {
    if (this.activeSelectionToolbar && this.activeSelectionToolbar.isConnected) {
      this.activeSelectionToolbar.remove();
    }
    this.activeSelectionToolbar = null;
    this.activeTextSelection = null;
    document.querySelectorAll('.gaw-selection-toolbar').forEach((el) => el.remove());
  }

  async setCurrentCard(card) {
    if (!card) return { mode: 'noop' };
    const existingConversation = this.currentConversationId
      ? this.plugin.getConversation(this.currentConversationId)
      : null;
    if (this.screen === 'chat' && existingConversation) {
      await this.addContextItem(this.plugin.contextItemFromCard(card));
      return { mode: 'added-to-current', conversationId: existingConversation.id };
    }
    const conversation = await this.plugin.createConversation({
      title: card.label,
      pendingContextItems: [this.plugin.contextItemFromCard(card)],
    });
    // A Canvas card is Question Context, just like a file attachment. It is not
    // a privileged anchor/owner of the new conversation.
    await this.openConversation(conversation.id, null);
    return { mode: 'created-new', conversationId: conversation.id };
  }

  async openConversation(conversationId, anchorCard = null) {
    const conversation = this.plugin.getConversation(conversationId);
    if (!conversation) {
      new Notice('找不到这段历史对话。');
      return;
    }
    this.screen = 'chat';
    this.currentConversationId = conversationId;
    this.currentCard = anchorCard || this.plugin.getFirstLinkedCard(conversationId);
    this.messages = (conversation.messages || []).map((message) => cloneMessage(message));
    this.selectedQuote = null;
    this.draftText = '';
    this.selectedAgent = conversation.agentId || this.plugin.resolveConversationAgentId(conversation);
    this.selectedModel = conversation.agentModels && conversation.agentModels[this.selectedAgent] || '';
    this.selectedReasoningEffort = conversation.reasoningEffort || this.plugin.settings.defaultReasoningEffort || 'auto';
    this.contextItems = (conversation.pendingContextItems || []).map((item) => ({ ...item }));
    this.imageAttachments = (conversation.pendingAttachments || []).map((item) => ({ ...item }));
    await this.render();
    if (this.selectedAgent === 'codex') {
      this.plugin.prepareConversationAgentSession(conversationId, 'codex').catch((error) => console.warn('[Graph AI] Codex conversation prewarm failed', error));
    }
  }

  async showConversationList() {
    this.screen = 'list';
    this.selectedQuote = null;
    await this.render();
  }

  async setSelectedQuote(text, sourceLabel = '') {
    const quote = String(text || '').trim();
    if (!quote) return;
    this.selectedQuote = { text: quote, sourceLabel };
    await this.render();
    window.setTimeout(() => {
      const textarea = this.containerEl.querySelector('.gaw-composer textarea');
      if (textarea) textarea.focus();
    }, 0);
  }

  clearSelectedQuote() {
    this.selectedQuote = null;
  }

  async addContextItem(item) {
    if (!item || this.contextItems.some((x) => x.id === item.id)) return;
    this.contextItems.push({ ...item, kind: item.kind || 'manual' });
    if (this.currentConversationId) {
      await this.plugin.updateConversation(this.currentConversationId, { pendingContextItems: this.contextItems });
    }
    await this.render();
  }

  async removeContextItem(id) {
    this.contextItems = this.contextItems.filter((item) => item.id !== id);
    if (this.currentConversationId) {
      await this.plugin.updateConversation(this.currentConversationId, { pendingContextItems: this.contextItems });
    }
    await this.render();
  }

  buildRuntimeRows(message = {}) {
    const events = Array.isArray(message.runtimeEvents) ? message.runtimeEvents : [];
    const rows = [];
    const completedToolIds = new Set();
    for (const event of events) {
      if (!event || !event.type) continue;
      const payload = event.payload || {};
      if (event.type === 'tool.completed') {
        if (payload.toolCallId) completedToolIds.add(payload.toolCallId);
        const location = Array.isArray(payload.locations) && payload.locations.length
          ? payload.locations.find((item) => item && item.path) || payload.locations[0]
          : null;
        const kind = String(payload.kind || '').toLowerCase();
        const diff = payload.diffStats || null;
        rows.push({
          type: 'tool',
          icon: kind === 'edit' ? 'file-pen-line' : kind === 'execute' ? 'terminal' : kind === 'read' ? 'file-search' : kind === 'search' ? 'search' : 'wrench',
          title: payload.title || (kind ? kind[0].toUpperCase() + kind.slice(1) : 'Tool'),
          meta: location && location.path ? this.plugin.compactWorkspacePath(location.path) : '',
          diff,
          status: payload.status === 'failed' ? 'failed' : 'done',
          detail: [payload.inputPreview && `Input\n${payload.inputPreview}`, payload.outputPreview && `Output\n${payload.outputPreview}`].filter(Boolean).join('\n\n'),
        });
        continue;
      }
      if (event.type === 'artifact.modified' && !completedToolIds.has(payload.toolCallId)) {
        rows.push({
          type: 'artifact',
          icon: 'file-pen-line',
          title: 'Modified',
          meta: this.plugin.compactWorkspacePath(payload.path || ''),
          diff: payload.diffStats || null,
          status: 'done',
          detail: '',
        });
        continue;
      }
      if (event.type === 'handoff.created') {
        const handoff = payload.handoff || {};
        rows.push({
          type: 'handoff',
          icon: 'arrow-right-left',
          title: 'Context handoff',
          meta: [handoff.sourceAgentId, handoff.targetAgentId].filter(Boolean).join(' → ') || handoff.kind || '',
          status: 'done',
          detail: handoff.objective ? `Objective\n${handoff.objective}` : '',
        });
        continue;
      }
      if (event.type === 'plan.created' || event.type === 'plan.updated') {
        rows.push({
          type: 'plan',
          icon: 'list-checks',
          title: 'Plan updated',
          meta: '',
          status: 'done',
          detail: '',
        });
        continue;
      }
      if (event.type === 'task.failed') {
        rows.push({
          type: 'failed',
          icon: 'triangle-alert',
          title: payload.title || 'Task failed',
          meta: payload.error || '',
          status: 'failed',
          detail: payload.error || '',
        });
      }
    }

    if (!rows.length && Array.isArray(message.toolRuns)) {
      for (const run of message.toolRuns) {
        const label = run.agent || run.executor || run.backend || this.plugin.agentDisplayName(message.agentId);
        rows.push({
          type: 'run',
          icon: 'bot',
          title: label,
          meta: run.resumed ? 'session resumed' : run.sessionId ? 'session active' : '',
          status: run.ok ? 'done' : run.denied ? 'denied' : 'failed',
          detail: run.error || '',
        });
      }
    }
    return rows;
  }

  renderRuntimeTimeline(parent, message = {}) {
    const rows = this.buildRuntimeRows(message);
    if (!rows.length) return;
    const timeline = parent.createDiv({ cls: 'gaw-runtime-timeline' });
    for (const row of rows) {
      const container = row.detail
        ? timeline.createEl('details', { cls: `gaw-runtime-row is-${row.status || 'done'}` })
        : timeline.createDiv({ cls: `gaw-runtime-row is-${row.status || 'done'}` });
      const line = row.detail
        ? container.createEl('summary', { cls: 'gaw-runtime-line' })
        : container.createDiv({ cls: 'gaw-runtime-line' });
      const icon = line.createSpan({ cls: 'gaw-runtime-icon' });
      setIcon(icon, row.icon || 'wrench');
      line.createSpan({ cls: 'gaw-runtime-title', text: row.title || 'Tool' });
      if (row.meta) line.createSpan({ cls: 'gaw-runtime-meta', text: row.meta });
      if (row.diff) {
        line.createSpan({
          cls: 'gaw-runtime-diff',
          text: `+${Number(row.diff.additions || 0)} −${Number(row.diff.deletions || 0)}`,
        });
      }
      const state = line.createSpan({ cls: 'gaw-runtime-state' });
      setIcon(state, row.status === 'failed' || row.status === 'denied' ? 'x' : 'check');
      if (row.detail) container.createEl('pre', { cls: 'gaw-runtime-detail', text: row.detail });
    }
  }

  runtimeStreamText(message = {}, type = '') {
    return (Array.isArray(message.runtimeEvents) ? message.runtimeEvents : [])
      .filter((event) => event && event.type === type && event.payload && event.payload.text)
      .map((event) => String(event.payload.text || ''))
      .join('');
  }

  renderReasoningStream(parent, message = {}, { live = false } = {}) {
    const text = this.runtimeStreamText(message, 'thought.delta').trim();
    if (!text) return null;
    const details = parent.createEl('details', { cls: `gaw-reasoning-stream${live ? ' is-live' : ''}` });
    if (live) details.setAttribute('open', '');
    const summary = details.createEl('summary', { cls: 'gaw-reasoning-summary' });
    const icon = summary.createSpan({ cls: 'gaw-reasoning-icon' });
    setIcon(icon, 'brain');
    summary.createSpan({ text: live ? 'Thinking' : 'Reasoning' });
    summary.createSpan({ cls: 'gaw-reasoning-note', text: live ? ' · streaming' : ' · agent-exposed' });
    details.createDiv({ cls: 'gaw-reasoning-text', text });
    return details;
  }

  renderLiveAgentStream(parent, message = {}) {
    this.renderReasoningStream(parent, message, { live: true });
    this.renderRuntimeTimeline(parent, message);
    const answer = this.runtimeStreamText(message, 'message.delta');
    if (answer) {
      const stream = parent.createDiv({ cls: 'gaw-live-answer' });
      stream.setText(answer);
    }
  }

  async render() {
    this.clearConversationSelectionToolbar();
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('gaw-root');
    this.watchBottomSafeInset(root);

    if (this.screen === 'list') {
      this.renderConversationList(root);
      return;
    }

    const header = root.createDiv({ cls: 'gaw-header gaw-header-compact gaw-chat-header' });
    const back = header.createEl('button', {
      cls: 'gaw-back-button clickable-icon',
      attr: { 'aria-label': 'Back to conversations' },
    });
    setIcon(back, 'arrow-left');
    back.onclick = () => this.showConversationList();
    const titleWrap = header.createDiv({ cls: 'gaw-title-wrap' });
    const conversation = this.plugin.getConversation(this.currentConversationId);
    titleWrap.createEl('h3', { text: conversation ? conversation.title : 'Untitled conversation' });
    const agentNames = { codex: 'Codex', opencode: 'OpenCode', zcode: 'ZCode', kimi: 'Kimi' };
    const agentLabel = agentNames[this.selectedAgent] || this.selectedAgent || 'Agent';
    const activeSession = conversation ? this.plugin.getAgentBinding(conversation.id, this.selectedAgent) : null;
    const chatMeta = titleWrap.createDiv({ cls: 'gaw-chat-meta' });
    chatMeta.createSpan({ text: `${this.messages.length} messages` });
    const agentState = activeSession && activeSession.state
      ? activeSession.state
      : activeSession && activeSession.sessionId
        ? 'ready'
        : 'new';
    const agentBadge = chatMeta.createSpan({ cls: `gaw-chat-agent-state is-${agentState}` });
    const badgeDot = agentBadge.createSpan({ cls: 'gaw-chat-agent-dot' });
    badgeDot.setAttribute('aria-hidden', 'true');
    agentBadge.createSpan({ text: `${agentLabel}${activeSession && activeSession.protocol ? ` · ${activeSession.protocol}` : ''}` });
    if (activeSession && activeSession.sessionId) agentBadge.setAttribute('title', `Session: ${activeSession.sessionId}`);
    const headerMenu = header.createEl('button', {
      cls: 'gaw-chat-menu clickable-icon',
      attr: { 'aria-label': 'Conversation actions' },
    });
    setIcon(headerMenu, 'more-horizontal');
    headerMenu.onclick = (evt) => {
      if (!conversation) return;
      const menu = new Menu();
      menu.addItem((item) => item
        .setTitle('Delete conversation')
        .setIcon('trash-2')
        .onClick(() => {
          new ConversationDeleteModal(this.app, this.plugin, conversation, async () => this.showConversationList()).open();
        }));
      menu.showAtMouseEvent(evt);
    };
    const chat = root.createDiv({ cls: 'gaw-chat' });
    if (!this.messages.length) {
      const empty = chat.createDiv({ cls: 'gaw-empty-chat gaw-empty-discussion' });
      empty.createDiv({ cls: 'gaw-empty-icon', text: '↗' });
      empty.createEl('strong', { text: '这是一段新的独立对话。' });
      empty.createEl('p', { text: '它可以链接到一张或多张 Canvas 卡片；旧对话只有点击卡片里的历史链接才会打开。' });
    }

    for (let i = 0; i < this.messages.length; i++) {
      const message = this.messages[i];
      const bubble = chat.createDiv({ cls: `gaw-message is-${message.role}` });
      bubble.dataset.messageIndex = String(i);
      const messageAgentId = message.agentId || message.engine || (conversation && conversation.agentId) || this.selectedAgent;
      const messageAgentLabel = this.plugin.agentDisplayName(messageAgentId);
      const messageHeader = bubble.createDiv({ cls: 'gaw-message-header' });
      const messageRoleIcon = messageHeader.createSpan({ cls: 'gaw-message-role-icon' });
      setIcon(messageRoleIcon, message.role === 'user' ? 'user-round' : 'bot');
      messageHeader.createSpan({ cls: 'gaw-message-role', text: message.role === 'user' ? 'You' : messageAgentLabel });
      const body = bubble.createDiv({ cls: 'gaw-message-body' });
      if (message.role === 'user' && Array.isArray(message.contextItems) && message.contextItems.length) {
        const attachments = body.createDiv({ cls: 'gaw-message-contexts' });
        for (const contextItem of message.contextItems) {
          const contextButton = attachments.createEl('button', {
            cls: 'gaw-message-context-link',
            text: `${contextItem.kind === 'canvas' ? '◇' : contextItem.kind === 'folder' ? '▣' : '▤'} ${contextItem.label || contextItem.source || 'Context'}`,
            attr: { 'aria-label': `Open source: ${contextItem.label || contextItem.source || 'Context'}` },
          });
          contextButton.onclick = () => this.plugin.openContextItem(contextItem);
        }
      }
      if (message.role === 'user' && Array.isArray(message.attachments) && message.attachments.length) {
        const media = body.createDiv({ cls: 'gaw-message-images' });
        for (const attachment of message.attachments) {
          const src = this.plugin.getAttachmentResourceUrl(attachment);
          if (!src) continue;
          const figure = media.createEl('button', {
            cls: 'gaw-message-image-button',
            attr: { title: attachment.label || 'Open attached image', 'aria-label': attachment.label || 'Open attached image' },
          });
          figure.createEl('img', { cls: 'gaw-message-image', attr: { src, alt: attachment.label || 'Attached image' } });
          figure.onclick = () => this.plugin.openAttachment(attachment);
        }
      }
      if (message.quote) {
        const quote = body.createDiv({ cls: 'gaw-message-quote' });
        quote.createDiv({ cls: 'gaw-message-quote-label', text: message.quote.sourceLabel || 'Quoted text' });
        quote.createDiv({ cls: 'gaw-message-quote-text', text: message.quote.text });
      }
      if (message.role === 'assistant') {
        this.renderReasoningStream(body, message, { live: false });
        this.renderRuntimeTimeline(body, message);
      }
      const contentEl = body.createDiv({ cls: `gaw-message-content${message.role === 'assistant' ? ' markdown-rendered' : ''}` });
      if (message.role === 'assistant') {
        await MarkdownRenderer.render(
          this.app,
          String(message.content || ''),
          contentEl,
          this.currentCard && this.currentCard.canvasPath || '',
          this,
        );
      } else {
        contentEl.setText(String(message.content || ''));
      }
      if (message.role === 'assistant') {
        const actions = bubble.createDiv({ cls: 'gaw-message-actions' });
        const addIconAction = (icon, label, description, handler) => {
          const button = actions.createEl('button', {
            cls: 'gaw-message-action-icon clickable-icon',
            attr: {
              'aria-label': description,
              title: description,
              'data-tooltip-position': 'top',
            },
          });
          setIcon(button, icon);
          button.onclick = handler;
          return button;
        };

        addIconAction('copy', 'Copy', 'Copy this entire answer to the clipboard.', async () => {
          try {
            await navigator.clipboard.writeText(message.content || '');
            new Notice('Copied.');
          } catch (_) {
            new Notice('Copy failed.');
          }
        });

        addIconAction('square-plus', 'Add to Canvas', 'Create a new Canvas card from this entire answer. This does not create a new conversation branch.', async () => {
          try {
            await this.plugin.addConversationTextToCanvas({
              text: message.content,
              currentCard: this.currentCard,
              sourceConversationId: this.currentConversationId,
              sourceMessageId: message.id || i,
            });
            new Notice('Added to Canvas.');
          } catch (error) {
            console.error(error);
            new Notice(`写回 Canvas 失败：${error.message || error}`);
          }
        });

        addIconAction('git-fork', 'Fork conversation', 'Create a new conversation branch at this answer. No Canvas card is created.', async () => {
          await this.forkConversationAt(i);
        });

        addIconAction('git-branch-plus', 'Add to Canvas + Fork', 'Create a Canvas card from this entire answer and create a new conversation branch linked to that card.', async () => {
          try {
            const child = await this.plugin.addConversationTextToCanvas({
              text: message.content,
              currentCard: this.currentCard,
              sourceConversationId: this.currentConversationId,
            });
            await this.forkConversationAt(i, { cardContext: child, linkNewConversationToCard: true });
          } catch (error) {
            console.error(error);
            new Notice(`Add to Canvas + Fork 失败：${error.message || error}`);
          }
        });
      }
    }

    chat.addEventListener('mouseup', () => {
      window.setTimeout(() => this.handleConversationSelection(root, chat), 0);
    });
    chat.addEventListener('keyup', () => {
      window.setTimeout(() => this.handleConversationSelection(root, chat), 0);
    });

    if (this.isThinking) {
      const thinking = chat.createDiv({ cls: 'gaw-message is-assistant gaw-thinking' });
      const thinkingAgent = this.plugin.agentDisplayName(this.selectedAgent);
      const thinkingHeader = thinking.createDiv({ cls: 'gaw-message-header' });
      const thinkingIcon = thinkingHeader.createSpan({ cls: 'gaw-message-role-icon' });
      setIcon(thinkingIcon, 'bot');
      thinkingHeader.createSpan({ cls: 'gaw-message-role', text: thinkingAgent });
      const thinkingBody = thinking.createDiv({ cls: 'gaw-message-body' });
      const live = thinkingBody.createDiv({ cls: 'gaw-live-runtime' });
      this.renderLiveAgentStream(live, { runtimeEvents: this.liveRuntimeEvents });
      const activity = thinkingBody.createDiv({ cls: 'gaw-agent-activity' });
      activity.createSpan({ cls: 'gaw-agent-activity-dot' });
      activity.createSpan({ text: `${thinkingAgent} working…` });
    }

    const composerShell = root.createDiv({ cls: 'gaw-composer-shell' });
    const composer = composerShell.createDiv({ cls: 'gaw-composer' });
    const contextTray = composer.createDiv({ cls: 'gaw-context-tray' });
    if (this.selectedQuote) {
      const quote = contextTray.createDiv({ cls: 'gaw-composer-quote' });
      const copy = quote.createDiv({ cls: 'gaw-composer-quote-copy' });
      copy.createDiv({ cls: 'gaw-composer-quote-label', text: this.selectedQuote.sourceLabel || 'Selected text' });
      copy.createDiv({ cls: 'gaw-composer-quote-text', text: this.selectedQuote.text });
      const clear = quote.createEl('button', { text: '×', attr: { 'aria-label': 'Remove quote' } });
      clear.onclick = async () => {
        this.clearSelectedQuote();
        await this.render();
      };
    }
    if (this.contextItems.length) {
      const chips = contextTray.createDiv({ cls: 'gaw-composer-chips' });
      for (const item of this.contextItems) {
        const chip = chips.createDiv({ cls: 'gaw-chip' });
        chip.createSpan({ cls: 'gaw-chip-icon', text: item.kind === 'canvas' ? '◇' : item.kind === 'folder' ? '▣' : '▤' });
        chip.createSpan({ text: item.label });
        const x = chip.createEl('button', { cls: 'gaw-chip-x', text: '×', attr: { 'aria-label': `Remove ${item.label}` } });
        x.onclick = () => this.removeContextItem(item.id);
      }
    }

    if (this.imageAttachments.length) {
      const attachmentStrip = contextTray.createDiv({ cls: 'gaw-attachment-strip' });
      for (const attachment of this.imageAttachments) {
        const item = attachmentStrip.createDiv({ cls: 'gaw-attachment-item' });
        const src = this.plugin.getAttachmentResourceUrl(attachment);
        if (src) item.createEl('img', { cls: 'gaw-attachment-thumb', attr: { src, alt: attachment.label || 'Attached image' } });
        const meta = item.createDiv({ cls: 'gaw-attachment-meta' });
        meta.createDiv({ cls: 'gaw-attachment-name', text: attachment.label || 'Image' });
        meta.createDiv({ cls: 'gaw-attachment-size', text: attachment.size ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : 'image' });
        const remove = item.createEl('button', {
          cls: 'gaw-attachment-remove',
          text: '×',
          attr: { title: 'Remove this image from the next question.', 'aria-label': 'Remove image attachment' },
        });
        remove.onclick = async () => {
          this.imageAttachments = this.imageAttachments.filter((candidate) => candidate.id !== attachment.id);
          const conversation = this.plugin.getConversation(this.currentConversationId);
          if (conversation) await this.plugin.updateConversation(conversation.id, { pendingAttachments: this.imageAttachments });
          await this.render();
        };
      }
      if (!(await this.plugin.agentSupportsImages(this.selectedAgent))) {
        const warning = contextTray.createDiv({ cls: 'gaw-attachment-warning' });
        warning.setText(`${this.plugin.agentDisplayName(this.selectedAgent)} 当前配置不支持图片。图片会保留；切换到支持 Vision 的 Agent 后再发送。`);
      }
    }

    const textarea = composer.createEl('textarea', {
      placeholder: 'Message agent…',
    });
    textarea.rows = 1;
    textarea.value = this.draftText || '';
    const resizeComposer = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 42), 220)}px`;
    };
    textarea.addEventListener('input', () => {
      this.draftText = textarea.value;
      resizeComposer();
    });
    window.requestAnimationFrame(resizeComposer);

    const addImageAttachments = async (files) => {
      const remaining = Math.max(0, 10 - this.imageAttachments.length);
      if (!remaining) {
        new Notice('Up to 10 attachments per question.');
        return;
      }
      const selected = Array.from(files || []).slice(0, remaining);
      if (!selected.length) return;
      this.draftText = textarea.value;
      const imported = await this.plugin.importImageFiles(selected, this.currentCard && this.currentCard.canvasPath || '');
      if (!imported.length) return;
      this.imageAttachments = [...this.imageAttachments, ...imported].slice(0, 10);
      const conversation = this.plugin.getConversation(this.currentConversationId);
      if (conversation) await this.plugin.updateConversation(conversation.id, { pendingAttachments: this.imageAttachments });
      await this.render();
    };

    textarea.addEventListener('paste', async (evt) => {
      const files = Array.from(evt.clipboardData && evt.clipboardData.items || [])
        .filter((item) => item.kind === 'file' && /^image\//i.test(item.type || ''))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (!files.length) return;
      evt.preventDefault();
      await addImageAttachments(files);
    });
    composer.addEventListener('dragover', (evt) => {
      if (evt.dataTransfer && Array.from(evt.dataTransfer.types || []).includes('Files')) {
        evt.preventDefault();
        composer.addClass('is-dragging-file');
      }
    });
    composer.addEventListener('dragleave', () => composer.removeClass('is-dragging-file'));
    composer.addEventListener('drop', async (evt) => {
      composer.removeClass('is-dragging-file');
      const files = Array.from(evt.dataTransfer && evt.dataTransfer.files || []).filter((file) => /^image\//i.test(file.type || ''));
      if (!files.length) return;
      evt.preventDefault();
      await addImageAttachments(files);
    });

    const composerBottom = composer.createDiv({ cls: 'gaw-composer-bottom' });
    const modeActions = composerBottom.createDiv({ cls: 'gaw-mode-actions' });
    const addContextBtn = modeActions.createEl('button', {
      cls: 'gaw-composer-icon-btn',
      text: '+',
      attr: {
        title: 'Add Card, file, or folder context to the next question.',
        'aria-label': 'Add Card, file, or folder context',
        'data-tooltip-position': 'top',
      },
    });
    addContextBtn.onclick = () => this.plugin.openContextPicker(this);

    const imageInput = composer.createEl('input', {
      type: 'file',
      attr: { accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: 'true' },
    });
    imageInput.style.display = 'none';
    imageInput.addEventListener('change', async () => {
      await addImageAttachments(imageInput.files || []);
      imageInput.value = '';
    });
    const attachImageBtn = modeActions.createEl('button', {
      cls: 'gaw-composer-icon-btn',
      attr: {
        title: 'Attach images. You can also paste a screenshot or drag images into the composer.',
        'aria-label': 'Attach images; paste and drag-and-drop are also supported',
        'data-tooltip-position': 'top',
      },
    });
    setIcon(attachImageBtn, 'paperclip');
    attachImageBtn.onclick = () => imageInput.click();

    const agentButton = modeActions.createEl('button', {
      cls: 'gaw-agent-selector',
      attr: {
        title: `Agent: ${this.plugin.agentDisplayName(this.selectedAgent)}. Choose the Agent behind this Conversation.`,
        'aria-label': 'Choose conversation agent',
        'data-tooltip-position': 'top',
      },
    });
    const agentSelectorIcon = agentButton.createSpan({ cls: 'gaw-selector-icon' });
    setIcon(agentSelectorIcon, 'bot');
    agentButton.createSpan({ cls: 'gaw-selector-label', text: this.plugin.agentDisplayName(this.selectedAgent) });
    agentButton.createSpan({ cls: 'gaw-selector-chevron', text: '▾' });
    agentButton.onclick = async (evt) => {
      const menu = new Menu();
      const statuses = await this.plugin.getAgentStatuses();
      for (const status of statuses) {
        const id = status.id;
        const protocol = status.protocol ? ` · ${status.protocol}` : '';
        const state = status.runnable ? 'ready' : status.available ? 'needs setup' : 'unavailable';
        menu.addItem((item) => item
          .setTitle(`${status.name || this.plugin.agentDisplayName(id)} · ${state}${status.runnable ? protocol : ''}`)
          .setIcon(status.runnable ? 'bot' : 'circle-dashed')
          .setChecked(this.selectedAgent === id)
          .setDisabled(!status.runnable)
          .onClick(async () => {
            this.selectedAgent = id;
            const conversation = this.plugin.getConversation(this.currentConversationId);
            this.selectedModel = conversation && conversation.agentModels && conversation.agentModels[id] || '';
            const options = await this.plugin.getAgentReasoningOptions(id, this.selectedModel);
            if (!options.some((option) => option.value === this.selectedReasoningEffort)) {
              this.selectedReasoningEffort = 'auto';
            }
            if (conversation) {
              await this.plugin.updateConversation(conversation.id, {
                agentId: id,
                agentModels: { ...(conversation.agentModels || {}), [id]: this.selectedModel || '' },
                reasoningEffort: this.selectedReasoningEffort,
              });
            }
            if (id === 'codex' && conversation) {
              this.plugin.prepareConversationAgentSession(conversation.id, 'codex').catch((error) => console.warn('[Graph AI] Codex conversation prewarm failed', error));
            }
            await this.render();
          }));
      }
      menu.addSeparator();
      menu.addItem((item) => item
        .setTitle('Refresh Agent status')
        .setIcon('refresh-cw')
        .onClick(async () => {
          await this.plugin.ensureAgentRuntime({ force: true });
          const refreshed = await this.plugin.getAgentStatuses();
          new Notice(refreshed.map((status) => `${status.name}: ${status.runnable ? 'ready' : 'unavailable'}`).join(' · '));
          await this.render();
        }));
      menu.showAtMouseEvent(evt);
    };

    const modelLabel = this.selectedModel ? String(this.selectedModel).split('/').pop() : 'Auto model';
    const modelButton = modeActions.createEl('button', {
      cls: 'gaw-model-selector',
      attr: {
        title: `Model: ${modelLabel}. Choose the model used by the current Agent.`,
        'aria-label': 'Choose Agent model',
        'data-tooltip-position': 'top',
      },
    });
    const modelSelectorIcon = modelButton.createSpan({ cls: 'gaw-selector-icon' });
    setIcon(modelSelectorIcon, 'cpu');
    modelButton.createSpan({ cls: 'gaw-selector-label gaw-model-label', text: modelLabel });
    modelButton.createSpan({ cls: 'gaw-selector-chevron', text: '▾' });
    modelButton.onclick = async (evt) => {
      const menu = new Menu();
      const options = await this.plugin.getAgentModelOptions(this.selectedAgent);
      menu.addItem((item) => item
        .setTitle('Agent default')
        .setIcon('sparkles')
        .setChecked(!this.selectedModel)
        .onClick(async () => {
          this.selectedModel = '';
          const conversation = this.plugin.getConversation(this.currentConversationId);
          if (conversation) {
            await this.plugin.clearConversationAgentBinding(conversation.id, this.selectedAgent);
            await this.plugin.updateConversation(conversation.id, {
              agentModels: { ...(conversation.agentModels || {}), [this.selectedAgent]: '' },
            });
          }
          this.selectedReasoningEffort = 'auto';
          await this.render();
        }));
      if (!options.length) {
        menu.addItem((item) => item
          .setTitle('This Agent does not expose model selection')
          .setIcon('info')
          .setDisabled(true));
      } else {
        menu.addSeparator();
        for (const option of options) {
          menu.addItem((item) => item
            .setTitle(`${option.label || option.value}${option.description ? ` · ${option.description}` : ''}`)
            .setIcon(option.current ? 'check' : 'circle')
            .setChecked(this.selectedModel === option.value)
            .onClick(async () => {
              this.selectedModel = option.value;
              const reasoningOptions = await this.plugin.getAgentReasoningOptions(this.selectedAgent, this.selectedModel);
              if (!reasoningOptions.some((candidate) => candidate.value === this.selectedReasoningEffort)) {
                this.selectedReasoningEffort = 'auto';
              }
              const conversation = this.plugin.getConversation(this.currentConversationId);
              if (conversation) {
                await this.plugin.clearConversationAgentBinding(conversation.id, this.selectedAgent);
                await this.plugin.updateConversation(conversation.id, {
                  agentModels: { ...(conversation.agentModels || {}), [this.selectedAgent]: this.selectedModel },
                  reasoningEffort: this.selectedReasoningEffort,
                });
              }
              await this.render();
            }));
        }
      }
      menu.showAtMouseEvent(evt);
    };

    const reasoningButton = modeActions.createEl('button', {
      cls: 'gaw-reasoning-selector',
      attr: {
        title: `Reasoning: ${this.selectedReasoningEffort === 'auto' ? 'Auto' : this.selectedReasoningEffort}. Available levels come from Agent capabilities.`,
        'aria-label': 'Choose reasoning effort',
        'data-tooltip-position': 'top',
      },
    });
    const reasoningSelectorIcon = reasoningButton.createSpan({ cls: 'gaw-selector-icon' });
    setIcon(reasoningSelectorIcon, 'brain');
    reasoningButton.createSpan({
      cls: 'gaw-selector-label',
      text: this.selectedReasoningEffort === 'auto' ? 'Auto' : this.selectedReasoningEffort,
    });
    reasoningButton.createSpan({ cls: 'gaw-selector-chevron', text: '▾' });
    reasoningButton.onclick = async (evt) => {
      const menu = new Menu();
      const options = await this.plugin.getAgentReasoningOptions(this.selectedAgent, this.selectedModel);
      for (const option of options) {
        menu.addItem((item) => item
          .setTitle(`${option.label || option.value}${option.description ? ` · ${option.description}` : ''}`)
          .setIcon(option.value === 'auto' ? 'sparkles' : 'brain')
          .setChecked(this.selectedReasoningEffort === option.value)
          .onClick(async () => {
            this.selectedReasoningEffort = option.value;
            this.plugin.settings.defaultReasoningEffort = option.value;
            const conversation = this.plugin.getConversation(this.currentConversationId);
            if (conversation) await this.plugin.updateConversation(conversation.id, { reasoningEffort: option.value });
            await this.plugin.saveSettings();
            await this.render();
          }));
      }
      menu.showAtMouseEvent(evt);
    };

    const permission = this.plugin.settings.computerPermission || 'ask';
    const permissionLabels = {
      'read-only': 'Read only',
      ask: 'Ask before changes',
      'allow-edits': 'Allow edits in project',
    };
    const permissionShortLabels = {
      'read-only': 'Read',
      ask: 'Ask',
      'allow-edits': 'Auto',
    };
    const permissionButton = modeActions.createEl('button', {
      cls: `gaw-permission-selector is-${permission}`,
      attr: {
        title: `Computer access: ${permissionLabels[permission] || permission}`,
        'aria-label': `Computer access: ${permissionLabels[permission] || permission}`,
        'data-tooltip-position': 'top',
      },
    });
    const permissionIcon = permissionButton.createSpan({ cls: 'gaw-selector-icon' });
    setIcon(permissionIcon, permission === 'read-only' ? 'eye' : permission === 'allow-edits' ? 'shield-check' : 'shield-question');
    permissionButton.createSpan({ cls: 'gaw-selector-label gaw-permission-label', text: permissionShortLabels[permission] || permission });
    permissionButton.onclick = (evt) => {
      const menu = new Menu();
      const setPermission = async (value) => {
        this.plugin.settings.computerPermission = value;
        await this.plugin.saveSettings();
        new Notice(`Computer access: ${permissionLabels[value]}`);
        await this.render();
      };
      menu.addItem((item) => item
        .setTitle('Read only')
        .setIcon('eye')
        .setChecked(permission === 'read-only')
        .onClick(() => setPermission('read-only')));
      menu.addItem((item) => item
        .setTitle('Ask before changes')
        .setIcon('circle-help')
        .setChecked(permission === 'ask')
        .onClick(() => setPermission('ask')));
      menu.addItem((item) => item
        .setTitle('Allow edits in project')
        .setIcon('square-pen')
        .setChecked(permission === 'allow-edits')
        .onClick(() => setPermission('allow-edits')));
      menu.showAtMouseEvent(evt);
    };

    const rightActions = composerBottom.createDiv({ cls: 'gaw-composer-right' });
    const send = rightActions.createEl('button', {
      cls: `gaw-send gaw-send-round${this.isThinking ? ' is-stop' : ''}`,
      attr: { 'aria-label': this.isThinking ? 'Stop agent' : 'Send message' },
    });
    setIcon(send, this.isThinking ? 'square' : 'arrow-up');
    send.onclick = async () => {
      if (this.isThinking) {
        const stopped = await this.plugin.stopConversationAgent(this.currentConversationId, this.selectedAgent);
        if (!stopped) new Notice('Agent cannot be stopped through the current runtime.');
        return;
      }
      await this.submit(textarea);
    };
    textarea.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter' || evt.isComposing) return;
      if (!evt.shiftKey) {
        evt.preventDefault();
        this.submit(textarea);
      }
    });

  }

  renderConversationList(root) {
    const header = root.createDiv({ cls: 'gaw-header gaw-list-header' });
    const top = header.createDiv({ cls: 'gaw-list-title-row' });
    top.createEl('h3', { text: 'Conversations' });
    const newChat = top.createEl('button', { cls: 'gaw-new-chat-button', text: '+ New' });
    newChat.onclick = async () => {
      const conversation = await this.plugin.createConversation({ title: 'Untitled conversation' });
      await this.openConversation(conversation.id, null);
    };

    const search = header.createEl('input', {
      type: 'search',
      cls: 'gaw-chat-search',
      placeholder: 'Search conversations…',
    });
    const tagBar = header.createDiv({ cls: 'gaw-tag-filter-bar' });
    const list = root.createDiv({ cls: 'gaw-conversation-list' });
    let activeTag = '';

    const renderRows = () => {
      const all = this.plugin.listConversations();
      const tags = Array.from(new Set(all.flatMap((conversation) => conversation.tags || []))).sort();
      tagBar.empty();
      const allTag = tagBar.createEl('button', { cls: `gaw-tag-filter${activeTag ? '' : ' is-active'}`, text: 'All' });
      allTag.onclick = () => { activeTag = ''; renderRows(); };
      for (const tag of tags) {
        const button = tagBar.createEl('button', { cls: `gaw-tag-filter${activeTag === tag ? ' is-active' : ''}`, text: `#${tag}` });
        button.onclick = () => { activeTag = tag; renderRows(); };
      }

      const q = search.value.trim().toLowerCase();
      const filtered = all.filter((conversation) => {
        if (activeTag && !(conversation.tags || []).includes(activeTag)) return false;
        if (!q) return true;
        const haystack = [conversation.title, ...(conversation.tags || []), ...(conversation.messages || []).map((m) => m.content || '')].join(' ').toLowerCase();
        return haystack.includes(q);
      });
      list.empty();
      if (!filtered.length) {
        list.createDiv({ cls: 'gaw-list-empty', text: '没有匹配的对话。' });
        return;
      }
      for (const conversation of filtered) {
        const row = list.createDiv({ cls: 'gaw-conversation-row' });
        const main = row.createDiv({ cls: 'gaw-conversation-main' });
        const titleRow = main.createDiv({ cls: 'gaw-conversation-title-row' });
        titleRow.createDiv({ cls: 'gaw-conversation-title', text: conversation.title || 'Untitled conversation' });
        titleRow.createSpan({
          cls: 'gaw-conversation-agent',
          text: this.plugin.agentDisplayName(this.plugin.resolveConversationAgentId(conversation)),
        });
        const lastMessage = [...(conversation.messages || [])].reverse().find((message) => message && message.content);
        if (lastMessage) {
          main.createDiv({
            cls: 'gaw-conversation-preview',
            text: String(lastMessage.content || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          });
        }
        const cards = this.plugin.getLinkedCardsForConversation(conversation.id);
        main.createDiv({
          cls: 'gaw-conversation-meta',
          text: `${(conversation.messages || []).length} messages${cards.length ? ` · ${cards.map((card) => card.label).slice(0, 2).join(' / ')}` : ''}`,
        });
        const tagsRow = main.createDiv({ cls: 'gaw-conversation-tags' });
        for (const tag of conversation.tags || []) tagsRow.createSpan({ text: `#${tag}` });
        const actions = row.createDiv({ cls: 'gaw-conversation-actions' });
        const addTag = actions.createEl('button', { text: '+ tag' });
        addTag.onclick = (evt) => {
          evt.stopPropagation();
          new ConversationTagModal(this.app, this.plugin, conversation.id, async () => this.render()).open();
        };
        const remove = actions.createEl('button', {
          cls: 'gaw-delete-conversation',
          attr: { 'aria-label': `Delete ${conversation.title || 'conversation'}` },
        });
        setIcon(remove, 'trash-2');
        remove.onclick = (evt) => {
          evt.stopPropagation();
          new ConversationDeleteModal(this.app, this.plugin, conversation, async () => this.render()).open();
        };
        row.onclick = () => this.openConversation(conversation.id, null);
      }
    };
    search.addEventListener('input', renderRows);
    renderRows();
  }

  handleConversationSelection(root, chat) {
    this.clearConversationSelectionToolbar();
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : '';
    if (!selection || selection.isCollapsed || !text || !selection.rangeCount) return;
    const range = selection.getRangeAt(0).cloneRange();
    const nodeElement = (node) => {
      if (!node) return null;
      return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    };
    const startEl = nodeElement(range.startContainer);
    const endEl = nodeElement(range.endContainer);
    if (!startEl || !endEl || !chat.contains(startEl) || !chat.contains(endEl)) return;
    const startBubble = startEl.closest('.gaw-message[data-message-index]');
    const endBubble = endEl.closest('.gaw-message[data-message-index]');
    const indices = [startBubble, endBubble]
      .filter(Boolean)
      .map((bubble) => Number(bubble.dataset.messageIndex))
      .filter(Number.isFinite);
    if (!indices.length) return;
    const messageIndex = Math.max(...indices);
    const sourceMessage = this.messages[messageIndex] || null;
    const rect = range.getBoundingClientRect();
    const snapshot = {
      text,
      messageIndex,
      messageId: sourceMessage && sourceMessage.id || '',
      source: 'conversation',
      sourceLabel: 'Selected conversation text',
    };
    this.activeTextSelection = snapshot;

    const toolbar = document.createElement('div');
    toolbar.className = 'gaw-selection-toolbar';
    this.activeSelectionToolbar = toolbar;

    const addButton = (label, description, handler) => {
      const button = document.createElement('button');
      button.textContent = label;
      button.setAttribute('title', description);
      button.setAttribute('aria-label', description);
      button.setAttribute('data-tooltip-position', 'top');
      button.addEventListener('pointerdown', (evt) => evt.preventDefault());
      button.addEventListener('click', async (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const frozen = { ...snapshot };
        this.clearConversationSelectionToolbar();
        const liveSelection = window.getSelection();
        if (liveSelection) liveSelection.removeAllRanges();
        await handler(frozen);
      });
      toolbar.appendChild(button);
    };

    addButton('Ask', 'Continue this conversation using only the selected text as a Quote. No Canvas card or new branch is created.', async (frozen) => {
      if (this.currentCard) {
        const item = this.plugin.contextItemFromCard(this.currentCard);
        if (!this.contextItems.some((existing) => existing.id === item.id)) {
          await this.addContextItem(item);
        }
      }
      await this.setSelectedQuote(frozen.text, 'From this discussion');
    });

    addButton('Add to Canvas', 'Create a new Canvas text card from only the selected text. The current conversation is not forked.', async (frozen) => {
      try {
        await this.plugin.addConversationTextToCanvas({
          text: frozen.text,
          currentCard: this.currentCard,
          sourceConversationId: this.currentConversationId,
        });
      } catch (error) {
        new Notice(`Add to Canvas 失败：${error.message || error}`);
      }
    });

    addButton('Fork', 'Create a new conversation branch at this point. The selected text becomes a Quote; no Canvas card is created.', async (frozen) => {
      await this.forkConversationAt(frozen.messageIndex, {
        quote: frozen.text,
        quoteLabel: 'Forked selection',
      });
    });

    addButton('Add + Fork', 'Create a Canvas card from only the selected text and create a new conversation branch linked to that new card.', async (frozen) => {
      try {
        const child = await this.plugin.addConversationTextToCanvas({
          text: frozen.text,
          currentCard: this.currentCard,
          sourceConversationId: this.currentConversationId,
        });
        await this.forkConversationAt(frozen.messageIndex, {
          quote: frozen.text,
          quoteLabel: 'Forked selection',
          cardContext: child,
          linkNewConversationToCard: true,
        });
      } catch (error) {
        new Notice(`Add to Canvas + Fork 失败：${error.message || error}`);
      }
    });

    document.body.appendChild(toolbar);
    const width = toolbar.offsetWidth || 360;
    const height = toolbar.offsetHeight || 40;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    const preferredTop = rect.bottom + 7;
    const top = preferredTop + height + 8 <= window.innerHeight
      ? preferredTop
      : Math.max(8, rect.top - height - 7);
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;

    window.setTimeout(() => {
      const close = (evt) => {
        if (!toolbar.contains(evt.target)) this.clearConversationSelectionToolbar();
        document.removeEventListener('pointerdown', close, true);
      };
      document.addEventListener('pointerdown', close, true);
    }, 0);
  }

  async forkConversationAt(messageIndex, {
    quote = '',
    quoteLabel = '',
    cardContext = null,
    linkNewConversationToCard = false,
  } = {}) {
    const sourceConversation = this.plugin.getConversation(this.currentConversationId);
    if (!sourceConversation) return null;
    const safeIndex = Number.isInteger(messageIndex) && messageIndex >= 0
      ? Math.min(messageIndex, this.messages.length - 1)
      : this.messages.length - 1;
    const pendingContextItems = cardContext
      ? [this.plugin.contextItemFromCard(cardContext)]
      : [];
    const forked = await this.plugin.createConversation({
      title: this.plugin.makeUniqueConversationTitle(`${sourceConversation.title || 'Conversation'} · Fork`),
      tags: [...(sourceConversation.tags || [])],
      pendingContextItems,
      agentId: sourceConversation.agentId || this.selectedAgent || this.plugin.settings.defaultAgent || 'codex',
      agentModels: { ...(sourceConversation.agentModels || {}) },
      reasoningEffort: sourceConversation.reasoningEffort || this.selectedReasoningEffort || 'auto',
      forkFrom: {
        sourceConversationId: sourceConversation.id,
        messageIndex: safeIndex,
      },
    });
    if (cardContext && linkNewConversationToCard) {
      await this.plugin.linkConversationToCard(cardContext, forked.id, { writeLink: true });
    }
    await this.openConversation(forked.id, cardContext || this.currentCard);
    if (quote) await this.setSelectedQuote(quote, quoteLabel || 'Forked selection');
    return forked;
  }

  async submit(textarea) {
    const text = textarea.value.trim();
    if ((!text && !this.imageAttachments.length) || this.isThinking || !this.currentConversationId) return;
    if (this.imageAttachments.length && !(await this.plugin.agentSupportsImages(this.selectedAgent))) {
      new Notice(`${this.plugin.agentDisplayName(this.selectedAgent)} 当前 Agent 配置不支持图片输入。可以保留图片并切换到支持 Vision 的 Agent。`);
      return;
    }
    const quote = this.selectedQuote ? { ...this.selectedQuote } : null;
    const sentContextItems = this.contextItems.map((item) => ({ ...item }));
    const sentAttachments = this.imageAttachments.map((item) => ({ ...item }));
    this.messages.push({
      id: makeId('msg'),
      role: 'user',
      content: text,
      quote,
      contextItems: sentContextItems,
      attachments: sentAttachments,
      modelId: this.selectedModel || '',
      reasoningEffort: this.selectedReasoningEffort || 'auto',
    });
    this.selectedQuote = null;
    this.contextItems = [];
    this.imageAttachments = [];
    const conversation = this.plugin.getConversation(this.currentConversationId);
    const updates = {
      messages: this.messages,
      pendingContextItems: [],
      pendingAttachments: [],
      agentId: this.selectedAgent,
      agentModels: { ...((conversation && conversation.agentModels) || {}), [this.selectedAgent]: this.selectedModel || '' },
      reasoningEffort: this.selectedReasoningEffort || 'auto',
    };
    if (conversation && (!conversation.title || conversation.title === 'Untitled conversation')) {
      updates.title = firstUsefulLine(text).slice(0, 72);
    }
    await this.plugin.updateConversation(this.currentConversationId, updates);
    this.draftText = '';
    textarea.value = '';
    this.liveRuntimeEvents = [];
    this.isThinking = true;
    await this.render();
    try {
      const response = await this.plugin.askConversation(
        this.messages,
        sentContextItems,
        this.currentConversationId,
        this.selectedAgent,
        this.selectedModel || '',
        this.selectedReasoningEffort || 'auto',
      );
      const normalized = typeof response === 'string'
        ? { content: response, toolRuns: [], runtimeEvents: [], stopped: false }
        : {
            content: response && response.content || '',
            toolRuns: response && response.toolRuns || [],
            runtimeEvents: response && response.runtimeEvents || [],
            stopped: Boolean(response && response.stopped),
          };
      if (normalized.stopped && !String(normalized.content || '').trim()) {
        return;
      }
      const assistantMessage = {
        id: makeId('msg'),
        role: 'assistant',
        content: normalized.content,
        toolRuns: normalized.toolRuns,
        runtimeEvents: normalized.runtimeEvents,
        agentId: this.selectedAgent,
        modelId: this.selectedModel || '',
      };
      this.messages.push(assistantMessage);
      await this.plugin.updateConversation(this.currentConversationId, { messages: this.messages });
      await this.plugin.markConversationAgentSynced(this.currentConversationId, this.selectedAgent, assistantMessage.id);
    } catch (error) {
      console.error(error);
      this.messages.push({
        id: makeId('msg'),
        role: 'assistant',
        agentId: this.selectedAgent,
        content: `调用失败：${error.message || error}\n\n请检查 ${this.plugin.agentDisplayName(this.selectedAgent)} 的状态、网络或权限设置。`,
      });
      await this.plugin.updateConversation(this.currentConversationId, { messages: this.messages });
    } finally {
      this.isThinking = false;
      this.liveRuntimeEvents = [];
      await this.render();
      const chat = this.containerEl.querySelector('.gaw-chat');
      if (chat) chat.scrollTop = chat.scrollHeight;
    }
  }
}

class GraphAISettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Graph AI Workspace' });
    containerEl.createEl('p', {
      text: '每段 Conversation 只选择一个 Agent。Agent 可以只回答，也可以在同一会话中执行工具或修改文件；Graph AI 不再区分 Chat Mode 与 Agent Mode。',
    });

    new Setting(containerEl)
      .setName('Default Agent')
      .setDesc('新 Conversation 默认使用的 Agent。每段 Conversation 可以独立切换 Agent。')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('codex', 'Codex')
          .addOption('opencode', 'OpenCode')
          .addOption('zcode', 'ZCode')
          .setValue(this.plugin.settings.defaultAgent || 'codex')
          .onChange(async (value) => {
            this.plugin.settings.defaultAgent = value;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: 'Internal Lightweight Model' });
    containerEl.createEl('p', {
      text: '仅供标题生成、摘要、分类、未来 Memory consolidation 等内部小任务使用，不作为 Conversation 的用户可选 Agent。',
    });

    new Setting(containerEl)
      .setName('Internal model provider')
      .setDesc('内部 LightweightModelRuntime 的 provider。Desktop Provider Bridge 只在运行时读取本机 credential，不复制进 Graph AI data.json。')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('desktop-provider-bridge', 'Desktop Provider Bridge · existing credential')
          .addOption('mock', 'Mock · no API needed')
          .addOption('openai-compatible', 'OpenAI-compatible · manual API key')
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            this.plugin.settings.provider = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Desktop bridge provider')
      .setDesc('ZCode Desktop 中 provider 的显示名称。只读取本机配置，不显示 credential。当前推荐 opencode。')
      .addText((text) =>
        text
          .setPlaceholder('opencode')
          .setValue(this.plugin.settings.desktopBridgeProviderName || 'opencode')
          .onChange(async (value) => {
            this.plugin.settings.desktopBridgeProviderName = value.trim() || 'opencode';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Internal model')
      .setDesc('LightweightModelRuntime 使用的模型。')
      .addText((text) =>
        text
          .setPlaceholder('kimi-k3')
          .setValue(this.plugin.settings.desktopBridgeModel || 'kimi-k3')
          .onChange(async (value) => {
            this.plugin.settings.desktopBridgeModel = value.trim() || 'kimi-k3';
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: 'Agent Runtime' });

    new Setting(containerEl)
      .setName('Computer access')
      .setDesc('控制 Conversation Agent 对本地项目的默认写入权限；显式点击 Add to Canvas 不受此项限制。')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('read-only', 'Read only')
          .addOption('ask', 'Ask before changes')
          .addOption('allow-edits', 'Allow edits in project')
          .setValue(this.plugin.settings.computerPermission || 'ask')
          .onChange(async (value) => {
            this.plugin.settings.computerPermission = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Local tools')
      .setDesc('保留给内部 LightweightModelRuntime 的轻量本地工具。Conversation Agent 自己拥有其 Agent Runtime 工具。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.localToolsEnabled !== false)
          .onChange(async (value) => {
            this.plugin.settings.localToolsEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Codex isolated mode')
      .setDesc('默认开启。Graph AI 自己管理 Context 与权限，因此 Codex 执行时不再额外加载 ~/.codex/config.toml 中的用户级配置；关闭后可让 Codex 同时加载你原有的用户配置。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.codexIgnoreUserConfig !== false)
          .onChange(async (value) => {
            this.plugin.settings.codexIgnoreUserConfig = value;
            await this.plugin.rebuildExecutionBackends();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('OpenCode isolated mode')
      .setDesc('默认开启。使用 --pure，避免 OpenCode 自己的外部插件/规则与 Graph AI 的 Context 重复叠加。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openCodePure !== false)
          .onChange(async (value) => {
            this.plugin.settings.openCodePure = value;
            await this.plugin.rebuildExecutionBackends();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('OpenCode model')
      .setDesc('可选的全局覆盖。留空时跟随 OpenCode ACP 当前默认模型；Conversation 里的 Model 选择优先级更高。')
      .addText((text) =>
        text
          .setPlaceholder('Leave empty to follow Agent default')
          .setValue(this.plugin.settings.openCodeModel || '')
          .onChange(async (value) => {
            this.plugin.settings.openCodeModel = value.trim();
            await this.plugin.rebuildExecutionBackends();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('ZCode Node runtime')
      .setDesc('可选高级设置。留空时从 PATH / 常见安装目录自动发现 Node；当前 ZCode Adapter 主要面向 macOS Desktop 安装。')
      .addText((text) =>
        text
          .setPlaceholder('Leave empty to auto-detect Node')
          .setValue(this.plugin.settings.zcodeNodePath || '')
          .onChange(async (value) => {
            this.plugin.settings.zcodeNodePath = value.trim();
            await this.plugin.rebuildExecutionBackends();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('ZCode credential bridge provider')
      .setDesc('只填写 ZCode Desktop 中已有 provider 的名称。Graph AI 不复制或显示密钥，只在启动 ZCode 子进程时本地传递。')
      .addText((text) =>
        text
          .setPlaceholder('opencode')
          .setValue(this.plugin.settings.zcodeDesktopProviderName || 'opencode')
          .onChange(async (value) => {
            this.plugin.settings.zcodeDesktopProviderName = value.trim() || 'opencode';
            await this.plugin.rebuildExecutionBackends();
            await this.plugin.saveSettings();
          }),
      );

    const addAgentPathSetting = (id, label, placeholder) => {
      new Setting(containerEl)
        .setName(`${label} Agent executable`)
        .setDesc('高级设置。留空时由 Agent Runtime 从 PATH / 常见安装目录自动发现。')
        .addText((text) =>
          text
            .setPlaceholder(placeholder)
            .setValue((this.plugin.settings.executorPaths || {})[id] || '')
            .onChange(async (value) => {
              this.plugin.settings.executorPaths = this.plugin.settings.executorPaths || {};
              this.plugin.settings.executorPaths[id] = value.trim();
              await this.plugin.rebuildExecutionBackends();
              await this.plugin.saveSettings();
            }),
        );
    };
    addAgentPathSetting('codex', 'Codex', 'Leave empty to auto-detect');
    addAgentPathSetting('opencode', 'OpenCode', 'Leave empty to auto-detect');
    addAgentPathSetting('zcode', 'ZCode', 'Optional: path to ZCode bundled .cjs');

    new Setting(containerEl)
      .setName('Base URL')
      .setDesc('例如你的模型服务根地址；插件会请求 /chat/completions。')
      .addText((text) =>
        text
          .setPlaceholder('https://…/v1')
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Model')
      .addText((text) =>
        text.setPlaceholder('model-name').setValue(this.plugin.settings.model).onChange(async (value) => {
          this.plugin.settings.model = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('API key')
      .setDesc('只保存在当前 Vault 的插件 data.json。')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('sk-…').setValue(this.plugin.settings.apiKey).onChange(async (value) => {
          this.plugin.settings.apiKey = value.trim();
          await this.plugin.saveSettings();
        });
      });
  }
}

module.exports = class GraphAIWorkspacePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    await this.migrateRuntimeConfig();
    this.settings.conversations = this.settings.conversations || {};
    this.settings.cardConversationLinks = this.settings.cardConversationLinks || {};
    const adapter = this.app.vault && this.app.vault.adapter;
    const vaultRoot = adapter && (adapter.basePath || (typeof adapter.getBasePath === 'function' && adapter.getBasePath()));
    this.vaultRoot = vaultRoot || process.cwd();
    this.runtimeLoadErrors = [];
    this.canonicalStateStore = null;
    this.contextCompiler = null;
    this.localToolRuntime = null;
    this.agentRegistry = null;
    this.agentSessionManager = null;
    this.agentController = null;
    this.lightweightModelRuntime = null;
    this.runtimeEventBuffer = [];
    this.runtimeEventSubscribers = new Set();

    await this.loadRuntimeModules(this.vaultRoot);

    await this.ensurePlaygroundConversations();
    await this.migrateConversationContextModel();
    if (this.canonicalStateStore && this.canonicalStateStore.migrateConversations(this.settings.conversations)) {
      await this.saveSettings();
    }

    this.registerView(VIEW_TYPE, (leaf) => new GraphAIWorkspaceView(leaf, this));
    this.addSettingTab(new GraphAISettingTab(this.app, this));

    this.addRibbonIcon('message-square-more', 'Open Graph AI', async () => {
      await this.activateView();
    });

    this.addCommand({
      id: 'open-graph-ai-sidebar',
      name: 'Open Graph AI sidebar',
      callback: async () => {
        await this.activateView();
      },
    });

    if (this.app.vault.getAbstractFileByPath(PLAYGROUND_PATH)) {
      this.addCommand({
        id: 'open-graph-ai-interaction-playground',
        name: 'Open Interaction Playground',
        callback: async () => {
          await this.openPlayground();
        },
      });
    }

    this.addCommand({
      id: 'test-graph-ai-local-tools',
      name: 'Test local agent tools',
      callback: async () => {
        if (!this.localToolRuntime) {
          new Notice(`Local tools unavailable${this.runtimeLoadErrors && this.runtimeLoadErrors.length ? ` · ${this.runtimeLoadErrors.join(' | ')}` : ''}`);
          return;
        }
        const result = await this.localToolRuntime.executeTool('list_directory', { path: '.' }, {
          permission: 'read-only',
        });
        if (result && result.ok) {
          new Notice(`Local tools ready · ${result.items.length} items in workspace root`);
        } else {
          new Notice(`Local tools test failed: ${(result && result.error) || 'unknown error'}`);
        }
      },
    });

    this.addCommand({
      id: 'refresh-graph-ai-executors',
      name: 'Refresh Agent runtimes',
      callback: async () => {
        await this.ensureAgentRuntime({ force: true });
        const statuses = await this.getAgentStatuses();
        const summary = statuses.map((status) => `${status.name}: ${status.runnable ? 'ready' : status.available ? 'detected' : 'missing'}`).join(' · ');
        new Notice(summary || 'No Agent runtimes configured.');
        const view = this.getView();
        if (view) await view.render();
      },
    });

    this.addCommand({
      id: 'test-graph-ai-codex-connection',
      name: 'Test Codex connection',
      callback: async () => {
        const ready = await this.ensureAgentRuntime({ force: true });
        const codex = ready && this.agentRegistry ? this.agentRegistry.get('codex') : null;
        if (!codex) {
          new Notice(`Codex unavailable: ${(this.runtimeLoadErrors || []).join(' | ') || 'Agent runtime did not load.'}`);
          return;
        }
        new Notice('Testing Codex…');
        const result = await codex.send({
          prompt: 'Reply with exactly CODEX_CONNECTED. Do not inspect or modify files.',
          cwd: '.',
          permission: 'read-only',
        });
        if (result && result.ok) {
          new Notice(`Codex connected${result.sessionId ? ` · ${result.sessionId.slice(0, 8)}…` : ''}`);
        } else {
          new Notice(`Codex test failed: ${(result && result.error) || 'unknown error'}`);
        }
      },
    });

    this.addCommand({
      id: 'ask-ai-selected-canvas-card',
      name: 'Ask AI with selected Canvas card',
      callback: async () => {
        await this.activateView();
        await this.syncSelectedCardToSidebar(true);
      },
    });

    if (typeof this.registerObsidianProtocolHandler === 'function') {
      this.registerObsidianProtocolHandler('graph-ai-chat', async (params) => {
        if (!params || !params.chat) return;
        const view = await this.activateView();
        if (!view) return;
        await view.openConversation(params.chat, null);
      });
    }

    this.registerEvent(this.app.workspace.on('file-menu', async (menu, file) => {
      if (file) {
        menu.addItem((item) => item
          .setTitle(file.children ? 'Add folder to current AI context' : 'Add file to current AI context')
          .setIcon('plus-circle')
          .onClick(async () => {
            await this.addAbstractFileToCurrentConversation(file);
          }));
      }
    }));

    this.registerDomEvent(document, 'click', (evt) => {
      const target = evt.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('a[href^="obsidian://graph-ai-chat"]');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      try {
        const url = new URL(href);
        const conversationId = url.searchParams.get('chat');
        if (!conversationId) return;
        evt.preventDefault();
        evt.stopPropagation();
        window.setTimeout(async () => {
          const view = await this.activateView();
          if (view) await view.openConversation(conversationId, null);
        }, 0);
      } catch (_) {}
    }, true);

    this.registerDomEvent(document, 'mouseup', (evt) => {
      const target = evt.target;
      if (!(target instanceof Element) || !target.closest('.canvas-node')) return;
      const activeLeaf = this.app.workspace.activeLeaf;
      const activeView = activeLeaf && activeLeaf.view;
      if (!activeView || typeof activeView.getViewType !== 'function' || activeView.getViewType() !== 'canvas') return;
      window.setTimeout(async () => {
        const selection = window.getSelection();
        const text = selection ? selection.toString().trim() : '';
        if (!selection || selection.isCollapsed || !text || !selection.rangeCount) return;
        const card = await this.getSelectedCanvasCard();
        if (!card) return;
        this.showCanvasSelectionToolbar(selection, card, text);
      }, 0);
    });

    this.registerDomEvent(document, 'contextmenu', (evt) => {
      const target = evt.target;
      if (!(target instanceof Element)) return;
      const activeLeaf = this.app.workspace.activeLeaf;
      const activeView = activeLeaf && activeLeaf.view;
      if (!activeView || typeof activeView.getViewType !== 'function' || activeView.getViewType() !== 'canvas') return;

      const tryInject = async () => {
        const card = await this.getSelectedCanvasCard();
        if (card) this.injectAddToChatMenuItem(card);
      };

      window.setTimeout(tryInject, 40);
      window.setTimeout(tryInject, 120);
      window.setTimeout(tryInject, 260);
    });

    const tryInjectToolbar = () => {
      window.setTimeout(() => this.injectAddToChatToolbarButton(), 20);
      window.setTimeout(() => this.injectAddToChatToolbarButton(), 80);
      window.setTimeout(() => this.injectAddToChatToolbarButton(), 180);
    };

    this.registerDomEvent(document, 'click', (evt) => {
      const target = evt.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.canvas-node') || target.closest('.canvas-menu') || target.closest('.canvas-node-menu')) tryInjectToolbar();
    }, true);

    const toolbarObserver = new MutationObserver(() => {
      const activeLeaf = this.app.workspace.activeLeaf;
      const activeView = activeLeaf && activeLeaf.view;
      if (activeView && typeof activeView.getViewType === 'function' && activeView.getViewType() === 'canvas') {
        this.injectAddToChatToolbarButton();
      }
      this.injectFileExplorerContextButtons();
    });
    toolbarObserver.observe(document.body, { childList: true, subtree: true });
    this.register(() => toolbarObserver.disconnect());
    this.injectFileExplorerContextButtons();

    console.log('[Graph AI Workspace] loaded');
  }

  onunload() {
    if (this.agentController && typeof this.agentController.close === 'function') {
      this.agentController.close();
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async migrateRuntimeConfig() {
    const previousVersion = Number(this.settings.runtimeConfigVersion || 0);
    const targetVersion = 5;
    if (previousVersion >= targetVersion) return false;
    let changed = false;

    // Keep migrations deterministic and local to Graph AI's own saved state.
    // A fresh install must not silently inspect another app's credentials or
    // persist machine-specific executable paths into data.json.
    if (this.settings.openCodeModel === 'opencode/deepseek-v4-flash-free') {
      this.settings.openCodeModel = '';
      changed = true;
    }
    if (
      previousVersion > 0
      && this.settings.provider === 'desktop-provider-bridge'
      && this.settings.desktopBridgeProviderName === 'opencode'
      && (!this.settings.desktopBridgeModel || this.settings.desktopBridgeModel === 'deepseek-v4-flash')
    ) {
      this.settings.desktopBridgeModel = 'kimi-k3';
      changed = true;
    }
    this.settings.executorPaths = { ...(this.settings.executorPaths || {}) };
    if (!this.settings.defaultAgent || !['codex', 'opencode', 'zcode'].includes(this.settings.defaultAgent)) {
      this.settings.defaultAgent = ['codex', 'opencode', 'zcode'].includes(this.settings.defaultConversationEngine)
        ? this.settings.defaultConversationEngine
        : 'codex';
      changed = true;
    }
    if (!this.settings.defaultReasoningEffort) {
      this.settings.defaultReasoningEffort = 'auto';
      changed = true;
    }
    this.settings.runtimeConfigVersion = targetVersion;
    changed = true;
    if (changed) await this.saveData(this.settings);
    return changed;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  recordRuntimeEvent(event) {
    if (!event) return;
    this.runtimeEventBuffer = this.runtimeEventBuffer || [];
    this.runtimeEventBuffer.push(event);
    if (this.runtimeEventBuffer.length > 200) this.runtimeEventBuffer.splice(0, this.runtimeEventBuffer.length - 200);
    for (const listener of this.runtimeEventSubscribers || []) {
      try { listener(event); } catch (error) { console.warn('[Graph AI] Runtime event listener failed', error); }
    }
  }

  subscribeRuntimeEvents(listener) {
    if (typeof listener !== 'function') return () => {};
    this.runtimeEventSubscribers = this.runtimeEventSubscribers || new Set();
    this.runtimeEventSubscribers.add(listener);
    return () => this.runtimeEventSubscribers && this.runtimeEventSubscribers.delete(listener);
  }

  async loadRuntimeModules(rootPath, { force = false } = {}) {
    this.runtimeLoadErrors = [];

    if (!this.canonicalStateStore) {
      try {
        this.canonicalStateStore = new CanonicalStateStore(this.settings);
        this.contextCompiler = new ContextCompiler(this.canonicalStateStore);
      } catch (error) {
        this.canonicalStateStore = null;
        this.contextCompiler = null;
        this.runtimeLoadErrors.push(`Context state: ${error.message || error}`);
        console.error('[Graph AI] Canonical context state unavailable; falling back to legacy conversation projection', error);
      }
    }

    if (!this.localToolRuntime || force) {
      try {
        this.localToolRuntime = new LocalAgentRuntime(rootPath || process.cwd());
      } catch (error) {
        this.localToolRuntime = null;
        this.runtimeLoadErrors.push(`Local tools: ${error.message || error}`);
        console.error('[Graph AI] Local tool runtime unavailable', error);
      }
    }

    if (!this.lightweightModelRuntime || force) {
      try {
        this.lightweightModelRuntime = new LightweightModelRuntime({
          settings: this.settings,
          getDesktopProviderBridge: () => this.getDesktopProviderBridge(),
          requestChatCompletion: (...args) => this.requestChatCompletion(...args),
          requestAnthropicCompletion: (...args) => this.requestAnthropicCompletion(...args),
          buildMultimodalChatMessages: (...args) => this.buildMultimodalChatMessages(...args),
          buildAnthropicChatMessages: (...args) => this.buildAnthropicChatMessages(...args),
        });
      } catch (error) {
        this.lightweightModelRuntime = null;
        this.runtimeLoadErrors.push(`Lightweight model: ${error.message || error}`);
        console.error('[Graph AI] LightweightModelRuntime unavailable', error);
      }
    }

    if (!this.agentController || force) {
      try {
        if (force && this.agentController && typeof this.agentController.close === 'function') {
          this.agentController.close();
        }
        this.agentRegistry = new AgentRegistry();
        for (const adapter of createAgentAdapters({
          rootPath: rootPath || process.cwd(),
          settings: this.settings,
          onRuntimeEvent: (event) => this.recordRuntimeEvent(event),
        })) {
          this.agentRegistry.register(adapter);
        }
        this.agentSessionManager = new AgentSessionManager({ canonicalStateStore: this.canonicalStateStore });
        this.agentController = new AgentRuntimeController({
          registry: this.agentRegistry,
          sessionManager: this.agentSessionManager,
          onEvent: (event) => this.recordRuntimeEvent(event),
        });
      } catch (error) {
        this.agentRegistry = null;
        this.agentSessionManager = null;
        this.agentController = null;
        this.runtimeLoadErrors.push(`Agent runtime: ${error.message || error}`);
        console.error('[Graph AI] Unified Agent Runtime unavailable; Conversation UI will stay loaded without Agent execution', error);
      }
    }

    return {
      localTools: Boolean(this.localToolRuntime),
      lightweightModel: Boolean(this.lightweightModelRuntime),
      agents: Boolean(this.agentController),
      errors: [...this.runtimeLoadErrors],
    };
  }

  async ensureAgentRuntime({ force = false } = {}) {
    if (this.agentController && this.agentRegistry && !force) return true;
    const adapter = this.app.vault && this.app.vault.adapter;
    const vaultRoot = this.vaultRoot || (adapter && (adapter.basePath || (typeof adapter.getBasePath === 'function' && adapter.getBasePath()))) || process.cwd();
    this.vaultRoot = vaultRoot;
    await this.loadRuntimeModules(vaultRoot, { force });
    return Boolean(this.agentController && this.agentRegistry);
  }

  async migrateConversationContextModel() {
    let changed = false;
    for (const conversation of Object.values(this.settings.conversations || {})) {
      if (!Array.isArray(conversation.pendingContextItems)) {
        conversation.pendingContextItems = [];
        changed = true;
      }
      if (!Array.isArray(conversation.pendingAttachments)) {
        conversation.pendingAttachments = [];
        changed = true;
      }
      if (!conversation.engine) {
        conversation.engine = this.settings.defaultConversationEngine || 'model';
        changed = true;
      }
      if (!conversation.agentId) {
        conversation.agentId = ['codex', 'opencode', 'zcode', 'kimi'].includes(conversation.engine)
          ? conversation.engine
          : this.settings.defaultAgent || 'codex';
        changed = true;
      }
      if (!conversation.agentModels || typeof conversation.agentModels !== 'object') {
        conversation.agentModels = {};
        changed = true;
      }
      if (!conversation.reasoningEffort) {
        conversation.reasoningEffort = this.settings.defaultReasoningEffort || 'auto';
        changed = true;
      }
      if (!conversation.agentBindings || typeof conversation.agentBindings !== 'object') {
        conversation.agentBindings = Object.fromEntries(
          Object.entries(conversation.executorSessions || {}).map(([key, value]) => [key, { ...value }]),
        );
        changed = true;
      }
      if (!conversation.executorSessions || typeof conversation.executorSessions !== 'object') {
        conversation.executorSessions = Object.fromEntries(
          Object.entries(conversation.agentBindings || {}).map(([key, value]) => [key, { ...value }]),
        );
        changed = true;
      }

      const legacy = Array.isArray(conversation.contextItems)
        ? conversation.contextItems.map((item) => ({ ...item }))
        : [];
      if (!legacy.length) continue;

      const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      let lastUserIndex = -1;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i] && messages[i].role === 'user') {
          lastUserIndex = i;
          break;
        }
      }

      if (lastUserIndex >= 0) {
        const existing = Array.isArray(messages[lastUserIndex].contextItems)
          ? messages[lastUserIndex].contextItems
          : [];
        if (!existing.length) messages[lastUserIndex].contextItems = legacy;
      } else if (!conversation.pendingContextItems.length) {
        conversation.pendingContextItems = legacy;
      }

      delete conversation.contextItems;
      changed = true;
    }

    if (changed) await this.saveSettings();
  }

  async rebuildExecutionBackends() {
    const rootPath = this.vaultRoot || (this.localToolRuntime && this.localToolRuntime.rootPath) || process.cwd();
    await this.loadRuntimeModules(rootPath, { force: true });
    return Boolean(this.agentController);
  }

  async rebuildAgentRuntime() {
    return this.rebuildExecutionBackends();
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf.view;
  }

  async openPlayground() {
    const file = this.app.vault.getAbstractFileByPath(PLAYGROUND_PATH);
    if (!file) {
      new Notice(`找不到测试白板：${PLAYGROUND_PATH}`);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }

  openContextPicker(view) {
    new ContextPickerModal(this.app, this, view).open();
  }

  async importImageFiles(fileList, sourcePath = '') {
    const files = Array.from(fileList || []).filter((file) => file && /^image\//i.test(file.type || ''));
    if (!files.length) return [];
    const attachments = [];
    for (const file of files) {
      if (attachments.length >= 10) break;
      if (Number(file.size || 0) > 5 * 1024 * 1024) {
        new Notice(`Image too large: ${file.name || 'pasted image'} · max 5 MB`);
        continue;
      }
      const rawName = String(file.name || 'image').replace(/[^a-zA-Z0-9._-]+/g, '-');
      const extFromName = rawName.includes('.') ? rawName.split('.').pop() : '';
      const mimeExt = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
      }[String(file.type || '').toLowerCase()] || 'png';
      const ext = (extFromName && extFromName.length <= 5 ? extFromName : mimeExt).toLowerCase();
      const preferredName = `${makeId('graph-ai-image')}.${ext}`;
      const vaultPath = this.app.fileManager && typeof this.app.fileManager.getAvailablePathForAttachment === 'function'
        ? await this.app.fileManager.getAvailablePathForAttachment(preferredName, sourcePath)
        : preferredName;
      const buffer = await file.arrayBuffer();
      await this.app.vault.createBinary(vaultPath, buffer);
      attachments.push({
        id: makeId('attachment'),
        type: 'image',
        label: rawName || `image.${ext}`,
        path: vaultPath,
        mime: file.type || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        size: Number(file.size || buffer.byteLength || 0),
      });
    }
    return attachments;
  }

  getAttachmentResourceUrl(attachment) {
    if (!attachment || !attachment.path) return '';
    const file = this.app.vault.getAbstractFileByPath(attachment.path);
    if (!file || typeof this.app.vault.getResourcePath !== 'function') return '';
    return this.app.vault.getResourcePath(file);
  }

  async openAttachment(attachment) {
    if (!attachment || !attachment.path) return;
    const file = this.app.vault.getAbstractFileByPath(attachment.path);
    if (!file) return;
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async attachmentAbsolutePaths(attachments = []) {
    const root = this.vaultRoot || process.cwd();
    return (attachments || [])
      .filter((item) => item && item.type === 'image' && item.path)
      .map((item) => ({ ...item, absolutePath: `${String(root).replace(/\/$/, '')}/${String(item.path).replace(/^\//, '')}` }));
  }

  async attachmentDataUrl(attachment) {
    if (!attachment || !attachment.path) throw new Error('Image attachment has no Vault path.');
    const file = this.app.vault.getAbstractFileByPath(attachment.path);
    if (!file) throw new Error(`Image attachment not found: ${attachment.path}`);
    const binary = await this.app.vault.readBinary(file);
    const bytes = Buffer.from(binary);
    const mime = attachment.mime || 'image/png';
    return `data:${mime};base64,${bytes.toString('base64')}`;
  }

  async buildMultimodalChatMessages(sourceMessages = [], limit = 20) {
    const sliced = sourceMessages.slice(-limit);
    const lastUserIndex = [...sliced].map((message) => message.role).lastIndexOf('user');
    const output = [];
    for (let i = 0; i < sliced.length; i += 1) {
      const message = sliced[i];
      let text = String(message.content || '');
      if (message.quote && message.role === 'user') {
        text = `[Quoted context: ${message.quote.sourceLabel || 'selected text'}]\n${message.quote.text}\n\n${text}`;
      }
      const attachments = message.role === 'user' && Array.isArray(message.attachments) ? message.attachments : [];
      if (!attachments.length || i !== lastUserIndex) {
        if (attachments.length) {
          const refs = attachments.map((item) => `[Attached image: ${item.label || 'image'} · ${item.path || ''}]`).join('\n');
          text = `${refs}\n\n${text}`.trim();
        }
        output.push({ role: message.role, content: text });
        continue;
      }
      const content = [{ type: 'text', text: text || 'Please inspect the attached image(s).' }];
      for (const attachment of attachments) {
        content.push({ type: 'image_url', image_url: { url: await this.attachmentDataUrl(attachment) } });
      }
      output.push({ role: message.role, content });
    }
    return output;
  }

  async addCardToChat(card) {
    const view = await this.activateView();
    if (!view) return;
    const result = await view.setCurrentCard(card);
    if (result && result.mode === 'added-to-current') {
      new Notice(`Added to current conversation: ${card.label}`);
    } else if (result && result.mode === 'created-new') {
      new Notice(`New conversation started with: ${card.label}`);
    }
  }

  injectAddToChatMenuItem(card) {
    const menus = Array.from(document.querySelectorAll('.menu'))
      .filter((el) => el instanceof HTMLElement && el.offsetParent !== null);
    const menu = menus[menus.length - 1];
    if (!menu || menu.querySelector('.gaw-add-to-chat-menu-item')) return;

    const item = document.createElement('div');
    item.className = 'menu-item gaw-add-to-chat-menu-item';
    item.setAttribute('role', 'menuitem');
    const currentView = this.getView();
    const hasOpenConversation = Boolean(
      currentView
      && currentView.screen === 'chat'
      && currentView.currentConversationId
      && this.getConversation(currentView.currentConversationId),
    );
    item.innerHTML = `<div class="menu-item-icon">◇</div><div class="menu-item-title">${hasOpenConversation ? 'Add card to current conversation' : 'Start conversation with card'}</div>`;
    item.addEventListener('click', async (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      menu.remove();
      await this.addCardToChat(card);
    });
    menu.appendChild(item);
  }

  injectAddToChatToolbarButton() {
    const toolbars = Array.from(document.querySelectorAll('.canvas-menu, .canvas-node-menu'))
      .filter((el) => el instanceof HTMLElement && el.offsetParent !== null);
    const toolbar = toolbars[toolbars.length - 1];
    if (!toolbar || toolbar.querySelector('.gaw-add-to-chat-toolbar-button')) return;

    const button = document.createElement('button');
    button.className = 'clickable-icon gaw-add-to-chat-toolbar-button';
    const currentView = this.getView();
    const hasOpenConversation = Boolean(
      currentView
      && currentView.screen === 'chat'
      && currentView.currentConversationId
      && this.getConversation(currentView.currentConversationId),
    );
    button.setAttribute('aria-label', hasOpenConversation ? 'Add card to current conversation' : 'Start conversation with card');
    button.setAttribute('title', hasOpenConversation
      ? 'Add this card as Context for the next question in the currently open conversation.'
      : 'No conversation is open. Create a new conversation with this card as its first pending Context.');
    button.setAttribute('data-tooltip-position', 'top');
    button.type = 'button';
    setIcon(button, 'message-square-plus');
    button.addEventListener('pointerdown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
    });
    button.addEventListener('click', async (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const card = await this.getSelectedCanvasCard();
      if (!card) {
        new Notice('没有读取到当前 Canvas 卡片，请重新点一下卡片。');
        return;
      }
      await this.addCardToChat(card);
    });

    toolbar.appendChild(button);

    const view = this.getView();
    if (view && view.currentConversationId && !toolbar.querySelector('.gaw-link-chat-toolbar-button')) {
      const link = document.createElement('button');
      link.className = 'clickable-icon gaw-link-chat-toolbar-button';
      link.setAttribute('aria-label', 'Link current chat to card');
      link.setAttribute('data-tooltip-position', 'top');
      link.type = 'button';
      setIcon(link, 'link-2');
      link.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
      });
      link.addEventListener('click', async (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const card = await this.getSelectedCanvasCard();
        if (!card) return;
        await this.linkConversationToCard(card, view.currentConversationId, { writeLink: true });
        new Notice('当前对话已作为历史链接挂到这张卡片。');
      });
      toolbar.appendChild(link);
    }
  }

  showCanvasSelectionToolbar(selection, card, text) {
    document.querySelectorAll('.gaw-canvas-selection-toolbar').forEach((el) => el.remove());
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const toolbar = document.createElement('div');
    toolbar.className = 'gaw-canvas-selection-toolbar';
    toolbar.style.left = `${Math.max(8, rect.left)}px`;
    toolbar.style.top = `${Math.max(8, rect.bottom + 7)}px`;

    const addButton = (label, description, handler) => {
      const button = document.createElement('button');
      button.textContent = label;
      button.setAttribute('title', description);
      button.setAttribute('aria-label', description);
      button.setAttribute('data-tooltip-position', 'top');
      button.addEventListener('pointerdown', (evt) => evt.preventDefault());
      button.addEventListener('click', async (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        toolbar.remove();
        selection.removeAllRanges();
        await handler();
      });
      toolbar.appendChild(button);
    };

    addButton('Ask', 'Continue with the selected text as a Quote. This card is added as Context; no new Canvas card is created.', async () => {
      const view = await this.activateView();
      if (!view) return;
      if (!view.currentConversationId || view.screen !== 'chat') {
        const conversation = await this.createConversation({
          title: card.label,
          pendingContextItems: [this.contextItemFromCard(card)],
        });
        await view.openConversation(conversation.id, card);
      } else {
        await view.addContextItem(this.contextItemFromCard(card));
      }
      await view.setSelectedQuote(text, 'From card text');
    });

    addButton('Add to Canvas', 'Create a new Canvas card from only the selected text. No new conversation branch is created.', async () => {
      await this.createCanvasCardFromSelection(card, text);
      new Notice('Added as a new Canvas card.');
    });

    addButton('Fork', 'Create a new conversation branch using this card as Context and the selected text as a Quote. No new Canvas card is created.', async () => {
      const view = await this.activateView();
      if (!view) return;
      if (view.currentConversationId && view.screen === 'chat') {
        await view.forkConversationAt(view.messages.length - 1, {
          quote: text,
          quoteLabel: 'Forked from card text',
          cardContext: card,
        });
        return;
      }
      const conversation = await this.createConversation({
        title: this.makeUniqueConversationTitle(`${card.label} · Fork`),
        pendingContextItems: [this.contextItemFromCard(card)],
      });
      await view.openConversation(conversation.id, card);
      await view.setSelectedQuote(text, 'Forked from card text');
    });

    addButton('Add + Fork', 'Create a new Canvas card from the selected text and create a new conversation branch linked to that new card.', async () => {
      const child = await this.createCanvasCardFromSelection(card, text);
      if (!child) return;
      const view = await this.activateView();
      if (!view) return;
      if (view.currentConversationId && view.screen === 'chat') {
        await view.forkConversationAt(view.messages.length - 1, {
          quote: text,
          quoteLabel: 'Forked from new Canvas card',
          cardContext: child,
          linkNewConversationToCard: true,
        });
        return;
      }
      const conversation = await this.createConversation({
        title: this.makeUniqueConversationTitle(`${child.label} · Fork`),
        pendingContextItems: [this.contextItemFromCard(child)],
      });
      await this.linkConversationToCard(child, conversation.id, { writeLink: true });
      await view.openConversation(conversation.id, child);
      await view.setSelectedQuote(text, 'Forked from new Canvas card');
    });

    document.body.appendChild(toolbar);
    window.setTimeout(() => {
      const close = (evt) => {
        if (!toolbar.contains(evt.target)) toolbar.remove();
        document.removeEventListener('pointerdown', close, true);
      };
      document.addEventListener('pointerdown', close, true);
    }, 0);
  }

  cardKey(card) {
    return card && card.canvasPath && card.nodeId ? `${card.canvasPath}::${card.nodeId}` : '';
  }

  contextItemFromCard(card) {
    return {
      id: `card:${this.cardKey(card)}`,
      label: card.label,
      text: card.text,
      source: card.canvasPath,
      kind: 'canvas',
      cardKey: this.cardKey(card),
      canvasPath: card.canvasPath,
      nodeId: card.nodeId,
    };
  }

  getConversation(id) {
    const conversation = id && this.settings.conversations ? this.settings.conversations[id] || null : null;
    if (conversation && this.canonicalStateStore) this.canonicalStateStore.projectConversation(conversation);
    return conversation;
  }

  listConversations() {
    return Object.values(this.settings.conversations || {})
      .slice()
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  }

  makeUniqueConversationTitle(baseTitle = 'Untitled conversation') {
    const base = String(baseTitle || 'Untitled conversation').trim() || 'Untitled conversation';
    const existing = new Set(this.listConversations().map((conversation) => conversation.title || ''));
    if (!existing.has(base)) return base;
    let index = 2;
    while (existing.has(`${base} ${index}`)) index += 1;
    return `${base} ${index}`;
  }

  async createConversation({
    title = 'Untitled conversation',
    messages = [],
    tags = [],
    pendingContextItems = [],
    pendingAttachments = [],
    linkedCards = [],
    forkMeta = null,
    forkFrom = null,
    agentId = this.settings.defaultAgent || 'codex',
    agentModels = {},
    engine = this.settings.defaultConversationEngine || 'model',
    reasoningEffort = this.settings.defaultReasoningEffort || 'auto',
    agentBindings = {},
    executorSessions = {},
  } = {}) {
    const id = makeId('chat');
    const now = Date.now();
    const initialAgentBindings = Object.keys(agentBindings || {}).length ? agentBindings : executorSessions;
    const conversation = {
      id,
      title: title === 'Untitled conversation' ? title : this.makeUniqueConversationTitle(title),
      messages: (messages || []).map((message) => cloneMessage(message)),
      tags: Array.from(new Set(tags || [])),
      pendingContextItems: (pendingContextItems || []).map((item) => ({ ...item })),
      pendingAttachments: (pendingAttachments || []).map((item) => ({ ...item })),
      linkedCards: Array.from(new Set(linkedCards || [])),
      linkedCardRefs: [],
      forkMeta: forkMeta ? { ...forkMeta } : null,
      agentId,
      agentModels: { ...(agentModels || {}) },
      // Legacy migration field. Product/runtime selection uses agentId.
      engine,
      reasoningEffort,
      agentBindings: Object.fromEntries(Object.entries(initialAgentBindings || {}).map(([key, value]) => [key, { ...value }])),
      executorSessions: Object.fromEntries(Object.entries(initialAgentBindings || {}).map(([key, value]) => [key, { ...value }])),
      createdAt: now,
      updatedAt: now,
    };
    this.settings.conversations = this.settings.conversations || {};
    this.settings.conversations[id] = conversation;
    if (this.canonicalStateStore) {
      if (forkFrom && forkFrom.sourceConversationId) {
        const sourceConversation = this.settings.conversations[forkFrom.sourceConversationId];
        if (!sourceConversation) throw new Error('Cannot fork: source conversation not found.');
        this.canonicalStateStore.createFork(sourceConversation, conversation, forkFrom.messageIndex);
      } else {
        this.canonicalStateStore.ensureConversation(conversation);
      }
    }
    await this.saveSettings();
    return conversation;
  }

  async updateConversation(id, updates = {}) {
    const conversation = this.getConversation(id);
    if (!conversation) return null;
    Object.assign(conversation, updates, { updatedAt: Date.now() });
    if (updates.messages) {
      if (this.canonicalStateStore) {
        this.canonicalStateStore.replaceProjection(conversation, updates.messages);
      } else {
        conversation.messages = updates.messages.map((message) => cloneMessage(message));
      }
    }
    if (updates.pendingContextItems) conversation.pendingContextItems = updates.pendingContextItems.map((item) => ({ ...item }));
    if (updates.pendingAttachments) conversation.pendingAttachments = updates.pendingAttachments.map((item) => ({ ...item }));
    const bindingUpdates = updates.agentBindings || updates.executorSessions;
    if (bindingUpdates) {
      conversation.agentBindings = Object.fromEntries(Object.entries(bindingUpdates).map(([key, value]) => [key, { ...value }]));
      conversation.executorSessions = Object.fromEntries(Object.entries(conversation.agentBindings).map(([key, value]) => [key, { ...value }]));
      if (this.canonicalStateStore) {
        const branch = this.canonicalStateStore.getBranchForConversation(conversation);
        if (branch) {
          branch.agentBindings = Object.fromEntries(
            Object.entries(conversation.agentBindings).map(([key, value]) => [key, { ...value }]),
          );
          branch.updatedAt = Date.now();
        }
      }
    }
    await this.saveSettings();
    return conversation;
  }

  async addConversationTag(id, tag) {
    const conversation = this.getConversation(id);
    if (!conversation) return;
    conversation.tags = Array.from(new Set([...(conversation.tags || []), tag]));
    conversation.updatedAt = Date.now();
    await this.saveSettings();
  }

  async deleteConversation(conversationId) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return false;

    const refs = (conversation.linkedCardRefs || []).map((ref) => ({ ...ref }));
    for (const ref of refs) {
      try {
        await this.removeConversationLinkFromCard(ref, conversationId);
      } catch (error) {
        console.warn('[Graph AI] Failed to remove card link during conversation delete', error);
      }
    }

    this.settings.cardConversationLinks = this.settings.cardConversationLinks || {};
    for (const [key, ids] of Object.entries(this.settings.cardConversationLinks)) {
      const next = (ids || []).filter((id) => id !== conversationId);
      if (next.length) this.settings.cardConversationLinks[key] = next;
      else delete this.settings.cardConversationLinks[key];
    }

    if (this.canonicalStateStore) this.canonicalStateStore.detachConversation(conversation);
    delete this.settings.conversations[conversationId];
    await this.saveSettings();

    const view = this.getView();
    if (view && view.currentConversationId === conversationId) {
      view.currentConversationId = null;
      view.currentCard = null;
      view.messages = [];
      view.contextItems = [];
      view.selectedQuote = null;
      view.screen = 'list';
      await view.render();
    }

    new Notice('Conversation deleted.');
    return true;
  }

  async removeConversationLinkFromCard(card, conversationId) {
    if (!card || !card.canvasPath || !card.nodeId) return;
    const file = this.app.vault.getAbstractFileByPath(card.canvasPath);
    if (!file) return;
    const raw = await this.app.vault.cachedRead(file);
    const data = JSON.parse(raw);
    const node = (data.nodes || []).find((item) => item.id === card.nodeId);
    if (!node || node.type !== 'text') return;

    const encodedId = encodeURIComponent(conversationId);
    const marker = `obsidian://graph-ai-chat?chat=${encodedId}`;
    const lines = String(node.text || '').split('\n');
    const filtered = lines.filter((line) => !line.includes(marker));
    if (filtered.length === lines.length) return;

    while (filtered.length && !filtered[filtered.length - 1].trim()) filtered.pop();
    if (filtered[filtered.length - 1] && filtered[filtered.length - 1].trim() === '---') filtered.pop();
    while (filtered.length && !filtered[filtered.length - 1].trim()) filtered.pop();

    node.text = filtered.join('\n');
    node.height = Math.max(160, (node.height || 160) - 42);
    await this.app.vault.modify(file, JSON.stringify(data, null, 2));
  }

  getLinkedCardsForConversation(conversationId) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return [];
    return (conversation.linkedCardRefs || []).map((ref) => ({ ...ref }));
  }

  getFirstLinkedCard(conversationId) {
    return this.getLinkedCardsForConversation(conversationId)[0] || null;
  }

  async openLinkedCard(card) {
    if (!card || !card.canvasPath) return;
    const file = this.app.vault.getAbstractFileByPath(card.canvasPath);
    if (!file) return;
    let leaf = this.app.workspace.getLeavesOfType('canvas')
      .find((candidate) => candidate.view && candidate.view.file && candidate.view.file.path === card.canvasPath);
    if (!leaf) leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
    window.setTimeout(() => {
      try {
        const canvas = leaf.view && leaf.view.canvas;
        const node = canvas && canvas.nodes && typeof canvas.nodes.get === 'function' ? canvas.nodes.get(card.nodeId) : null;
        if (!canvas || !node) return;
        if (typeof canvas.selectOnly === 'function') canvas.selectOnly(node);
        else if (canvas.selection && typeof canvas.selection.clear === 'function' && typeof canvas.selection.add === 'function') {
          canvas.selection.clear();
          canvas.selection.add(node);
        }
        if (typeof canvas.zoomToSelection === 'function') canvas.zoomToSelection();
      } catch (_) {}
    }, 120);
  }

  async openContextItem(item) {
    if (!item) return;

    if (item.kind === 'canvas' || item.canvasPath || item.cardKey) {
      let canvasPath = item.canvasPath || '';
      let nodeId = item.nodeId || '';
      if ((!canvasPath || !nodeId) && item.cardKey) {
        const separator = String(item.cardKey).lastIndexOf('::');
        if (separator >= 0) {
          canvasPath = canvasPath || String(item.cardKey).slice(0, separator);
          nodeId = nodeId || String(item.cardKey).slice(separator + 2);
        }
      }
      if (canvasPath && nodeId) {
        await this.openLinkedCard({
          canvasPath,
          nodeId,
          label: item.label || 'Canvas card',
          text: item.text || '',
        });
        return;
      }
    }

    const sourcePath = item.path || item.source || '';
    const file = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : null;
    if (!file) {
      new Notice(`找不到来源：${sourcePath || item.label || 'unknown'}`);
      return;
    }

    if (file.children) {
      const explorerLeaf = (this.app.workspace.getLeavesOfType('file-explorer') || [])[0];
      const explorer = explorerLeaf && explorerLeaf.view;
      if (explorer && typeof explorer.revealInFolder === 'function') {
        await explorer.revealInFolder(file);
        this.app.workspace.revealLeaf(explorerLeaf);
        return;
      }
      new Notice(`Folder: ${file.path}`);
      return;
    }

    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  async linkConversationToCard(card, conversationId, { writeLink = false } = {}) {
    const conversation = this.getConversation(conversationId);
    const key = this.cardKey(card);
    if (!conversation || !key) return;

    this.settings.cardConversationLinks = this.settings.cardConversationLinks || {};
    const links = this.settings.cardConversationLinks[key] || [];
    if (!links.includes(conversationId)) links.push(conversationId);
    this.settings.cardConversationLinks[key] = links;

    conversation.linkedCards = Array.from(new Set([...(conversation.linkedCards || []), key]));
    conversation.linkedCardRefs = conversation.linkedCardRefs || [];
    if (!conversation.linkedCardRefs.some((ref) => this.cardKey(ref) === key)) {
      conversation.linkedCardRefs.push({
        nodeId: card.nodeId,
        label: card.label,
        text: card.text,
        canvasPath: card.canvasPath,
        nodeData: card.nodeData,
      });
    }
    conversation.updatedAt = Date.now();
    await this.saveSettings();
    if (writeLink) await this.appendConversationLinkToCard(card, conversation);
  }

  async appendConversationLinkToCard(card, conversation) {
    if (!card || !conversation || !card.canvasPath) return;
    const file = this.app.vault.getAbstractFileByPath(card.canvasPath);
    if (!file) return;
    const raw = await this.app.vault.cachedRead(file);
    const data = JSON.parse(raw);
    const node = (data.nodes || []).find((item) => item.id === card.nodeId);
    if (!node || node.type !== 'text') return;
    const token = `chat=${encodeURIComponent(conversation.id)}`;
    if (String(node.text || '').includes(token)) return;
    const link = `↗ [${conversation.title || 'Conversation'}](obsidian://graph-ai-chat?chat=${encodeURIComponent(conversation.id)})`;
    if (String(node.text || '').includes('obsidian://graph-ai-chat?chat=')) {
      node.text = `${node.text}\n${link}`;
    } else {
      node.text = `${node.text}\n\n---\n${link}`;
    }
    node.height = Math.max(node.height || 160, (node.height || 160) + 42);
    await this.app.vault.modify(file, JSON.stringify(data, null, 2));
  }

  async ensurePlaygroundConversations() {
    const seeds = [
      {
        id: 'playground-chat-history',
        nodeId: 'demo-history',
        title: '为什么传播速度和内容成熟度要拆开？',
        messages: PLAYGROUND_DISCUSSIONS['demo-history'],
        tags: ['demo', '热点判断'],
      },
      {
        id: 'playground-chat-child',
        nodeId: 'demo-child',
        title: '内容成熟度可以看哪些信号？',
        messages: PLAYGROUND_DISCUSSIONS['demo-child'],
        tags: ['demo', 'fork'],
      },
    ];
    const file = this.app.vault.getAbstractFileByPath(PLAYGROUND_PATH);
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await this.app.vault.cachedRead(file));
    } catch (_) {
      return;
    }
    let changed = false;
    for (const seed of seeds) {
      const node = (data.nodes || []).find((item) => item.id === seed.nodeId);
      if (!node) continue;
      const card = {
        nodeId: node.id,
        label: firstUsefulLine(node.text).slice(0, 72),
        text: node.text,
        canvasPath: PLAYGROUND_PATH,
        nodeData: node,
      };
      if (!this.settings.conversations[seed.id]) {
        const seededMessages = seed.messages.map((message) => ({ ...message }));
        const firstUserMessage = seededMessages.find((message) => message.role === 'user');
        if (firstUserMessage) firstUserMessage.contextItems = [this.contextItemFromCard(card)];
        this.settings.conversations[seed.id] = {
          id: seed.id,
          title: seed.title,
          messages: seededMessages,
          tags: seed.tags,
          pendingContextItems: [],
          linkedCards: [this.cardKey(card)],
          linkedCardRefs: [{ ...card }],
          createdAt: Date.now() - 60000,
          updatedAt: Date.now() - 30000,
        };
        changed = true;
      }
      const key = this.cardKey(card);
      const links = this.settings.cardConversationLinks[key] || [];
      if (!links.includes(seed.id)) {
        this.settings.cardConversationLinks[key] = [...links, seed.id];
        changed = true;
      }
      const token = `chat=${encodeURIComponent(seed.id)}`;
      if (!String(node.text || '').includes(token)) {
        const link = `↗ [${seed.title}](obsidian://graph-ai-chat?chat=${encodeURIComponent(seed.id)})`;
        node.text = String(node.text || '').includes('obsidian://graph-ai-chat?chat=')
          ? `${node.text}\n${link}`
          : `${node.text}\n\n---\n${link}`;
        node.height = (node.height || 200) + 46;
        changed = true;
      }
    }
    if (changed) {
      await this.saveSettings();
      await this.app.vault.modify(file, JSON.stringify(data, null, 2));
    }
  }

  getCardMessages(card) {
    const key = this.cardKey(card);
    if (!key) return [];
    const store = this.settings.cardDiscussions || {};
    if (Array.isArray(store[key])) return store[key].map((message) => ({ ...message }));
    if (card.canvasPath === PLAYGROUND_PATH && PLAYGROUND_DISCUSSIONS[card.nodeId]) {
      return PLAYGROUND_DISCUSSIONS[card.nodeId].map((message) => ({ ...message }));
    }
    return [];
  }

  async saveCardMessages(card, messages) {
    const key = this.cardKey(card);
    if (!key) return;
    this.settings.cardDiscussions = this.settings.cardDiscussions || {};
    this.settings.cardDiscussions[key] = (messages || []).map((message) => ({ ...message }));
    await this.saveSettings();
  }

  getCardMeta(card) {
    const key = this.cardKey(card);
    if (!key) return null;
    const stored = (this.settings.cardMeta || {})[key];
    if (stored) return stored;
    if (card.canvasPath === PLAYGROUND_PATH && PLAYGROUND_META[card.nodeId]) {
      return PLAYGROUND_META[card.nodeId];
    }
    return null;
  }

  async createCanvasCardFromSelection(parentCard, text) {
    const file = this.app.vault.getAbstractFileByPath(parentCard.canvasPath);
    if (!file) throw new Error(`找不到 Canvas：${parentCard.canvasPath}`);
    const raw = await this.app.vault.cachedRead(file);
    const data = JSON.parse(raw);
    data.nodes = Array.isArray(data.nodes) ? data.nodes : [];
    data.edges = Array.isArray(data.edges) ? data.edges : [];
    const parent = data.nodes.find((node) => node.id === parentCard.nodeId);
    const nodeId = makeId('card');
    const width = 360;
    const estimatedLines = Math.max(4, String(text).split('\n').length + Math.ceil(String(text).length / 42));
    const height = Math.min(420, Math.max(160, estimatedLines * 21 + 58));
    const siblingCount = data.edges.filter((edge) => edge.fromNode === parentCard.nodeId).length;
    const fallbackX = data.nodes.reduce((max, node) => Math.max(max, (node.x || 0) + (node.width || 0)), 0) + 120;
    const newNode = {
      id: nodeId,
      type: 'text',
      text,
      x: parent ? parent.x + parent.width + 140 : fallbackX,
      y: parent ? parent.y + siblingCount * (height + 70) : 0,
      width,
      height,
    };
    data.nodes.push(newNode);
    if (parent) {
      data.edges.push({
        id: makeId('edge'),
        fromNode: parent.id,
        fromSide: 'right',
        toNode: nodeId,
        toSide: 'left',
        toEnd: 'arrow',
      });
    }
    await this.app.vault.modify(file, JSON.stringify(data, null, 2));

    const child = {
      nodeId,
      label: firstUsefulLine(text).slice(0, 72),
      text,
      canvasPath: parentCard.canvasPath,
      nodeData: newNode,
    };
    const key = this.cardKey(child);
    this.settings.cardMeta = this.settings.cardMeta || {};
    this.settings.cardMeta[key] = {
      parentNodeId: parentCard.nodeId,
      parentLabel: parentCard.label,
      sourceText: text,
      createdAt: Date.now(),
    };
    await this.saveSettings();
    return child;
  }

  getView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    return leaf ? leaf.view : null;
  }

  agentDisplayName(agentId = '') {
    return ({ codex: 'Codex', opencode: 'OpenCode', zcode: 'ZCode', kimi: 'Kimi' })[agentId] || agentId || 'Agent';
  }

  compactWorkspacePath(input = '') {
    const value = String(input || '');
    const root = String(this.vaultRoot || '').replace(/\/$/, '');
    if (root && value.startsWith(`${root}/`)) return value.slice(root.length + 1);
    const parts = value.split('/').filter(Boolean);
    return parts.length > 4 ? `…/${parts.slice(-4).join('/')}` : value;
  }

  resolveConversationAgentId(conversation = null) {
    const directLegacy = conversation && ['codex', 'opencode', 'zcode', 'kimi'].includes(conversation.engine)
      ? conversation.engine
      : '';
    return conversation && conversation.agentId
      || directLegacy
      || this.settings.defaultAgent
      || 'codex';
  }

  async getAgentStatuses() {
    if (!this.agentRegistry) await this.ensureAgentRuntime();
    if (this.agentRegistry && typeof this.agentRegistry.statuses === 'function') {
      return this.agentRegistry.statuses();
    }
    return [{
      id: 'runtime-error',
      name: 'Agent Runtime',
      protocol: '',
      available: false,
      runnable: false,
      detail: (this.runtimeLoadErrors || []).join(' | ') || 'Agent Runtime failed to load.',
    }];
  }

  async getAgentCapabilities(agentId) {
    if (this.agentController && typeof this.agentController.capabilities === 'function') {
      return this.agentController.capabilities(agentId);
    }
    return {
      persistentSession: false,
      resume: false,
      vision: false,
      attachments: false,
      reasoningEffort: false,
      reasoningLevels: [],
      tools: false,
      permissions: false,
    };
  }

  async agentSupportsImages(agentId) {
    const capabilities = await this.getAgentCapabilities(agentId);
    return Boolean(capabilities.vision || capabilities.attachments);
  }

  async getAgentReasoningOptions(agentId, modelId = '') {
    const backend = this.agentRegistry && this.agentRegistry.get(agentId);
    if (backend && typeof backend.getReasoningOptions === 'function') {
      try {
        const options = await backend.getReasoningOptions(modelId);
        if (Array.isArray(options) && options.length) return options;
      } catch (_) {}
    }
    const capabilities = await this.getAgentCapabilities(agentId);
    const levels = Array.from(new Map((capabilities.reasoningLevels || [])
      .filter(Boolean)
      .map((item) => {
        const value = typeof item === 'string' ? item : item.value;
        return [value, typeof item === 'string'
          ? { value, label: value }
          : { value, label: item.label || item.name || value, description: item.description || '' }];
      })
      .filter(([value]) => Boolean(value))).values());
    const labelFor = (value) => value === 'xhigh'
      ? 'XHigh'
      : value === 'max'
        ? 'Max'
        : value === 'ultra'
          ? 'Ultra'
          : value.charAt(0).toUpperCase() + value.slice(1);
    return [
      { value: 'auto', label: capabilities.reasoningEffort ? 'Auto' : 'Auto · Agent managed' },
      ...levels.map((item) => ({
        value: item.value,
        label: item.label && item.label !== item.value ? item.label : labelFor(item.value),
        description: item.description || '',
      })),
    ];
  }

  async getAgentModelOptions(agentId) {
    const backend = this.agentRegistry && this.agentRegistry.get(agentId);
    if (!backend || typeof backend.getModelOptions !== 'function') return [];
    try {
      const options = await backend.getModelOptions();
      return Array.isArray(options) ? options.filter((item) => item && item.value) : [];
    } catch (error) {
      console.warn(`[Graph AI] Failed to load model options for ${agentId}`, error);
      return [];
    }
  }

  // Compatibility aliases while settings / internal lightweight-model code are
  // migrated. Product UI must call the Agent capability methods above.
  async engineSupportsImages(engine) {
    if (engine && engine !== 'model') return this.agentSupportsImages(engine);
    return false;
  }

  async getReasoningOptions(engine) {
    if (engine && engine !== 'model') return this.getAgentReasoningOptions(engine);
    return [{ value: 'auto', label: 'Auto · internal model' }];
  }

  async syncSelectedCardToSidebar(showNotice) {
    const view = this.getView();
    if (!view) return;
    const card = await this.getSelectedCanvasCard();
    if (!card) {
      if (showNotice) new Notice('请先在 Canvas 中选中一张文字/文件卡片。');
      return;
    }
    await view.setCurrentCard(card);
  }

  async getSelectedCanvasCard() {
    const activeLeaf = this.app.workspace.activeLeaf;
    const leaves = this.app.workspace.getLeavesOfType('canvas') || [];
    const orderedLeaves = [];
    if (activeLeaf && activeLeaf.view && typeof activeLeaf.view.getViewType === 'function' && activeLeaf.view.getViewType() === 'canvas') {
      orderedLeaves.push(activeLeaf);
    }
    for (const leaf of leaves) {
      if (!orderedLeaves.includes(leaf)) orderedLeaves.push(leaf);
    }

    for (const leaf of orderedLeaves) {
      const view = leaf && leaf.view;
      const canvas = view && view.canvas;
      if (!canvas) continue;

      let selected = [];
      if (canvas.selection && typeof canvas.selection[Symbol.iterator] === 'function') {
        selected = Array.from(canvas.selection);
      } else if (typeof canvas.getSelection === 'function') {
        selected = Array.from(canvas.getSelection() || []);
      }
      if (!selected.length) continue;

      const node = selected[0];
      const data = typeof node.getData === 'function' ? node.getData() : node;
      if (!data || !data.id) continue;

      let text = '';
      if (data.type === 'text') {
        text = data.text || node.text || '';
      } else if (data.type === 'file' && data.file) {
        const file = this.app.vault.getAbstractFileByPath(data.file);
        if (file && file.extension === 'md') text = await this.app.vault.cachedRead(file);
        else text = `File: ${data.file}`;
      } else if (data.type === 'link') {
        text = `URL: ${data.url || ''}`;
      } else if (data.type === 'group') {
        text = data.label || 'Canvas group';
      }

      const canvasPath = view.file && view.file.path;
      if (!canvasPath) continue;

      return {
        nodeId: data.id,
        label: firstUsefulLine(text || data.label || data.file || data.url || 'Canvas card').slice(0, 72),
        text: text || JSON.stringify(data, null, 2),
        canvasPath,
        nodeData: data,
      };
    }

    return null;
  }

  async getRecentContextItems(limit = 10) {
    const files = this.app.vault.getFiles()
      .filter((file) => ['md', 'canvas', 'txt', 'json'].includes(file.extension))
      .sort((a, b) => (b.stat && b.stat.mtime || 0) - (a.stat && a.stat.mtime || 0))
      .slice(0, limit);
    const items = [];
    for (const file of files) items.push(await this.contextItemFromAbstractFile(file));
    return items.filter(Boolean);
  }

  async contextItemFromAbstractFile(file) {
    if (!file || !file.path) return null;
    if (file.children) {
      const prefix = file.path ? `${file.path}/` : '';
      const files = this.app.vault.getFiles().filter((child) => child.path.startsWith(prefix));
      const visiblePaths = files.slice(0, 200).map((child) => `- ${child.path}`);
      if (files.length > visiblePaths.length) visiblePaths.push(`- …and ${files.length - visiblePaths.length} more files`);
      return {
        id: `folder:${file.path}`,
        label: file.name || file.path || 'Vault root',
        text: `Folder scope: ${file.path || '/'}\nThis context grants access to all ${files.length} files under the folder. Use local search/read tools to inspect only the files needed for the current question.\n\n${visiblePaths.join('\n')}`,
        source: `${file.path || '/'} · ${files.length} files`,
        kind: 'folder',
        path: file.path,
        fileCount: files.length,
      };
    }

    let text = '';
    try {
      text = ['md', 'canvas', 'txt', 'json'].includes(file.extension)
        ? await this.app.vault.cachedRead(file)
        : `File: ${file.path}`;
    } catch (_) {
      text = `File: ${file.path}`;
    }
    return {
      id: `file:${file.path}`,
      label: file.basename || file.name,
      text,
      source: file.path,
      kind: 'file',
      path: file.path,
    };
  }

  async addAbstractFileToCurrentConversation(file) {
    const view = this.getView();
    if (!view || !view.currentConversationId || view.screen !== 'chat') {
      new Notice('请先打开一段对话，再把文件或文件夹加入 Context。');
      return;
    }
    const item = await this.contextItemFromAbstractFile(file);
    if (!item) return;
    await view.addContextItem(item);
    new Notice(file.children ? `Folder added: ${file.path}` : `File added: ${file.path}`);
  }

  injectFileExplorerContextButtons() {
    const titles = Array.from(document.querySelectorAll('.nav-file-title, .nav-folder-title'));
    for (const title of titles) {
      if (!(title instanceof HTMLElement) || title.querySelector('.gaw-explorer-add-context')) continue;
      const holder = title.closest('[data-path]');
      const path = title.getAttribute('data-path') || (holder && holder.getAttribute('data-path'));
      if (!path) continue;
      const button = document.createElement('button');
      button.className = 'gaw-explorer-add-context clickable-icon';
      button.type = 'button';
      button.setAttribute('aria-label', 'Add to current AI context');
      button.setAttribute('data-tooltip-position', 'right');
      setIcon(button, 'plus');
      button.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
      });
      button.addEventListener('click', async (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) return;
        await this.addAbstractFileToCurrentConversation(file);
      });
      title.appendChild(button);
    }
  }

  async searchVault(query) {
    const q = query.toLowerCase();
    const files = this.app.vault.getFiles().filter((file) => file.extension === 'md' || file.extension === 'canvas');
    const results = [];

    for (const file of files) {
      if (results.length >= 16) break;
      const pathMatch = file.path.toLowerCase().includes(q);
      let content = '';
      try {
        content = await this.app.vault.cachedRead(file);
      } catch (_) {
        continue;
      }

      if (file.extension === 'md') {
        const idx = content.toLowerCase().indexOf(q);
        if (!pathMatch && idx < 0) continue;
        const snippet = idx >= 0 ? content.slice(Math.max(0, idx - 500), idx + 1400) : content.slice(0, 1600);
        results.push({
          id: `file:${file.path}`,
          label: file.basename,
          text: snippet,
          source: file.path,
          kind: 'file',
          path: file.path,
        });
        continue;
      }

      try {
        const data = JSON.parse(content);
        const matchingNodes = (data.nodes || [])
          .filter((node) => node.type === 'text' && typeof node.text === 'string')
          .filter((node) => node.text.toLowerCase().includes(q))
          .slice(0, 6);
        for (const node of matchingNodes) {
          if (results.length >= 16) break;
          results.push({
            id: `canvas:${file.path}:${node.id}`,
            label: firstUsefulLine(node.text).slice(0, 72),
            text: node.text,
            source: `${file.path} · Canvas card`,
            kind: 'canvas',
            canvasPath: file.path,
            nodeId: node.id,
          });
        }
        if (pathMatch && !matchingNodes.length && results.length < 16) {
          results.push({
            id: `canvas-file:${file.path}`,
            label: file.basename,
            text: content.slice(0, 1800),
            source: file.path,
            kind: 'file',
            path: file.path,
          });
        }
      } catch (_) {}
    }

    return results;
  }

  buildContextBlock(contextItems) {
    if (!contextItems.length) return 'No explicit context was provided.';
    return contextItems
      .map((item, index) => `[#${index + 1} ${item.label}]\nSource: ${item.source}\n${item.text}`)
      .join('\n\n---\n\n');
  }

  async approveLocalToolCall(toolCall) {
    const modal = new ToolApprovalModal(this.app, toolCall);
    modal.open();
    return modal.promise;
  }

  getDesktopProviderBridge() {
    try {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const configPath = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const providers = data && data.provider && typeof data.provider === 'object' ? data.provider : {};
      const wanted = String(this.settings.desktopBridgeProviderName || 'opencode').trim().toLowerCase();
      for (const provider of Object.values(providers)) {
        if (!provider || typeof provider !== 'object') continue;
        if (String(provider.name || '').trim().toLowerCase() !== wanted) continue;
        const options = provider.options && typeof provider.options === 'object' ? provider.options : {};
        const models = provider.models && typeof provider.models === 'object' ? Object.keys(provider.models) : [];
        const model = this.settings.desktopBridgeModel || models[0] || '';
        if (!['openai-compatible', 'anthropic'].includes(provider.kind)) throw new Error(`Desktop provider ${provider.name} uses unsupported protocol: ${provider.kind || 'unknown'}.`);
        if (!options.baseURL) throw new Error(`Desktop provider ${provider.name} has no Base URL.`);
        if (!options.apiKey) throw new Error(`Desktop provider ${provider.name} has no credential.`);
        if (!model) throw new Error(`Desktop provider ${provider.name} has no model configured.`);
        return {
          name: provider.name || wanted,
          kind: provider.kind,
          baseUrl: String(options.baseURL).replace(/\/$/, ''),
          apiKey: String(options.apiKey),
          model: String(model),
        };
      }
      throw new Error(`Desktop provider not found: ${wanted}`);
    } catch (error) {
      throw new Error(`Desktop Provider Bridge unavailable: ${error.message || error}`);
    }
  }

  async requestChatCompletion(baseUrl, headers, payload) {
    return requestUrl({
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  }

  async requestAnthropicCompletion(baseUrl, headers, payload) {
    return requestUrl({
      url: `${baseUrl}/messages`,
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  }

  async buildAnthropicChatMessages(sourceMessages = [], limit = 20) {
    const sliced = sourceMessages.slice(-limit);
    const lastUserIndex = [...sliced].map((message) => message.role).lastIndexOf('user');
    const output = [];
    for (let i = 0; i < sliced.length; i += 1) {
      const message = sliced[i];
      if (!['user', 'assistant'].includes(message.role)) continue;
      let text = String(message.content || '');
      if (message.quote && message.role === 'user') {
        text = `[Quoted context: ${message.quote.sourceLabel || 'selected text'}]\n${message.quote.text}\n\n${text}`;
      }
      const attachments = message.role === 'user' && Array.isArray(message.attachments) ? message.attachments : [];
      if (!attachments.length || i !== lastUserIndex) {
        if (attachments.length) {
          const refs = attachments.map((item) => `[Attached image: ${item.label || 'image'} · ${item.path || ''}]`).join('\n');
          text = `${refs}\n\n${text}`.trim();
        }
        output.push({ role: message.role, content: text });
        continue;
      }
      const blocks = [{ type: 'text', text: text || 'Please inspect the attached image(s).' }];
      for (const attachment of attachments) {
        const dataUrl = await this.attachmentDataUrl(attachment);
        const comma = dataUrl.indexOf(',');
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.mime || 'image/png',
            data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
          },
        });
      }
      output.push({ role: message.role, content: blocks });
    }
    return output;
  }

  getAgentBinding(conversationId, agentId) {
    const conversation = this.getConversation(conversationId);
    if (!conversation || !agentId) return null;
    if (this.agentSessionManager) return this.agentSessionManager.getBinding(conversation, agentId);
    if (this.canonicalStateStore) return this.canonicalStateStore.getAgentBinding(conversation, agentId);
    const bindings = conversation.agentBindings || conversation.executorSessions || {};
    return bindings[agentId] ? { ...bindings[agentId] } : null;
  }

  // Compatibility alias for pre-0.7 callers.
  getExecutorSession(conversationId, backendId) {
    return this.getAgentBinding(conversationId, backendId);
  }

  async prepareConversationAgentSession(conversationId, agentId = 'codex') {
    if (!conversationId || !this.agentController) return null;
    const conversation = this.getConversation(conversationId);
    const branchMessages = conversation && this.canonicalStateStore
      ? this.canonicalStateStore.projectConversation(conversation)
      : (conversation && conversation.messages || []);
    const lastMessage = branchMessages.length ? branchMessages[branchMessages.length - 1] : null;
    const result = await this.agentController.prepare({
      conversation,
      agentId,
      cwd: '.',
      permission: this.settings.computerPermission || 'ask',
      branchHeadMessageId: lastMessage && lastMessage.id || '',
      modelId: conversation && conversation.agentModels && conversation.agentModels[agentId] || '',
    });
    if (result && result.ok) await this.saveSettings();
    return result;
  }

  // Compatibility alias for pre-0.7 callers.
  async prepareDirectEngineSession(conversationId, backendId = 'codex') {
    return this.prepareConversationAgentSession(conversationId, backendId);
  }

  async persistAgentBinding(conversationId, result, {
    preparedOnly = false,
    syncedThroughMessageId = '',
  } = {}) {
    if (!conversationId || !result || !result.backend || !result.sessionId) return;
    const conversation = this.getConversation(conversationId);
    if (!conversation) return;
    const binding = {
      agentId: result.backend,
      protocol: result.protocol || '',
      sessionId: result.sessionId,
      permission: result.permission || this.settings.computerPermission || 'ask',
      cwd: result.cwd || '.',
      transport: result.transport || '',
      modelId: result.modelId || '',
      bindingRole: 'conversation-agent',
      preparedOnly,
      syncedThroughMessageId,
      updatedAt: Date.now(),
    };
    if (this.canonicalStateStore) {
      this.canonicalStateStore.setAgentBinding(conversation, result.backend, binding);
      await this.saveSettings();
      return;
    }
    const agentBindings = { ...(conversation.agentBindings || conversation.executorSessions || {}) };
    agentBindings[result.backend] = binding;
    await this.updateConversation(conversationId, { agentBindings });
  }

  async persistExecutorSession(conversationId, result, options = {}) {
    return this.persistAgentBinding(conversationId, result, options);
  }

  async markConversationAgentSynced(conversationId, agentId, messageId) {
    if (!conversationId || !agentId || !messageId) return;
    const conversation = this.getConversation(conversationId);
    if (!conversation) return;
    if (this.agentController) {
      this.agentController.markSynced(conversation, agentId, messageId);
      await this.saveSettings();
      return;
    }
    const current = this.getAgentBinding(conversationId, agentId);
    if (!current || !current.sessionId) return;
    const next = {
      ...current,
      bindingRole: 'conversation-agent',
      preparedOnly: false,
      syncedThroughMessageId: messageId,
      updatedAt: Date.now(),
    };
    if (this.canonicalStateStore) {
      this.canonicalStateStore.setAgentBinding(conversation, agentId, next);
      await this.saveSettings();
      return;
    }
    const agentBindings = { ...(conversation.agentBindings || conversation.executorSessions || {}), [agentId]: next };
    await this.updateConversation(conversationId, { agentBindings });
  }

  async markDirectAgentSynced(conversationId, backendId, messageId) {
    return this.markConversationAgentSynced(conversationId, backendId, messageId);
  }

  async clearConversationAgentBinding(conversationId, agentId) {
    if (!conversationId || !agentId) return false;
    const conversation = this.getConversation(conversationId);
    if (!conversation) return false;
    if (this.agentSessionManager) {
      this.agentSessionManager.clear(conversation, agentId);
    } else if (this.canonicalStateStore) {
      const branch = this.canonicalStateStore.getBranchForConversation(conversation);
      if (branch && branch.agentBindings) delete branch.agentBindings[agentId];
    }
    if (conversation.agentBindings) delete conversation.agentBindings[agentId];
    if (conversation.executorSessions) delete conversation.executorSessions[agentId];
    await this.saveSettings();
    return true;
  }

  async stopConversationAgent(conversationId, agentId) {
    if (!this.agentController || !conversationId || !agentId) return false;
    const conversation = this.getConversation(conversationId);
    if (!conversation) return false;
    try {
      return Boolean(await this.agentController.stop(conversation, agentId));
    } catch (error) {
      console.warn('[Graph AI] Failed to stop Agent runtime', error);
      return false;
    }
  }

  summarizeAgentRun(result) {
    if (!result) return null;
    return {
      backend: result.backend || '',
      agent: result.executor || result.backend || 'Agent',
      ok: Boolean(result.ok),
      denied: Boolean(result.denied),
      resumed: Boolean(result.resumed),
      sessionId: result.sessionId || '',
      cwd: result.cwd || '.',
      error: result.error ? String(result.error).slice(0, 500) : '',
    };
  }

  buildAgentDirectPrompt(agentId, agentName, conversation, messages, contextItems, hasSession) {
    const compiled = this.contextCompiler && conversation
      ? this.contextCompiler.compile({
          conversation,
          currentContextItems: contextItems,
          executionMode: 'conversation',
          selectedSkill: '',
          hasAgentSession: hasSession,
        })
      : null;
    const sourceMessages = compiled ? compiled.messages : messages;
    const latestIndex = [...sourceMessages].map((message) => message.role).lastIndexOf('user');
    const latest = compiled && compiled.latestUser ? compiled.latestUser : latestIndex >= 0 ? sourceMessages[latestIndex] : null;
    const quoteBlock = latest && latest.quote
      ? `\n\nQUOTE FOR THIS QUESTION:\n${latest.quote.sourceLabel || 'Selected text'}\n${latest.quote.text}`
      : '';
    const historyBlock = !compiled && !hasSession
      ? messages
          .slice(Math.max(0, latestIndex - 12), Math.max(0, latestIndex))
          .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content || ''}`)
          .join('\n\n')
      : '';
    let structuredHandoff = '';
    let handoff = null;
    if (!hasSession && compiled && createAgentHandoff && renderAgentHandoff) {
      let sourceAgentId = '';
      if (this.canonicalStateStore && conversation) {
        const branch = this.canonicalStateStore.getBranchForConversation(conversation);
        const bindings = branch && branch.agentBindings ? Object.entries(branch.agentBindings) : [];
        const previous = bindings
          .filter(([id, binding]) => id !== agentId && binding && binding.sessionId)
          .sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0))[0];
        if (previous) sourceAgentId = previous[0];
      }
      const kind = conversation && conversation.forkMeta
        ? 'fork_handoff'
        : sourceAgentId
          ? 'migration_handoff'
          : 'checkpoint_handoff';
      handoff = createAgentHandoff({
        kind,
        conversation,
        compiled,
        sourceAgentId,
        targetAgentId: agentId,
      });
      structuredHandoff = renderAgentHandoff(handoff);
    }
    const prompt = [
      this.settings.systemPrompt,
      '',
      'You are the active Agent for this Graph AI Conversation inside an Obsidian workspace.',
      'Answer the user directly. When the task requires tools, local coding, file edits, or commands, execute them within the granted permission instead of handing off to a separate chat/executor mode.',
      `COMPUTER PERMISSION: ${this.settings.computerPermission || 'ask'}`,
      structuredHandoff ? `\n${structuredHandoff}` : '',
      compiled ? `\n${compiled.handoffText}` : '',
      historyBlock ? `\nCONVERSATION HISTORY BEFORE THIS ${String(agentName || 'AGENT').toUpperCase()} SESSION:\n${historyBlock}` : '',
      !compiled ? `\nEXPLICIT CONTEXT FOR THIS QUESTION:\n${this.buildContextBlock(contextItems)}` : '',
      quoteBlock,
      `\nUSER QUESTION:\n${latest ? latest.content || '' : ''}`,
    ].filter(Boolean).join('\n');
    return { prompt, handoff };
  }

  async askAgentDirect(backendId, agentName, messages, contextItems, conversationId, modelId = '', reasoningEffort = 'auto') {
    if (!this.agentController || !this.agentRegistry) throw new Error('Unified Agent Runtime is unavailable.');
    const status = await this.agentController.status(backendId);
    if (!status || !status.runnable) {
      throw new Error(`${agentName} direct is unavailable. ${status && status.detail ? status.detail : 'The backend is not ready.'}`);
    }
    const conversation = this.getConversation(conversationId);
    const sourceMessages = conversation && this.canonicalStateStore
      ? this.canonicalStateStore.projectConversation(conversation)
      : messages;
    const latestUserIndex = [...sourceMessages].map((message) => message.role).lastIndexOf('user');
    const previousMessageId = latestUserIndex > 0 ? sourceMessages[latestUserIndex - 1] && sourceMessages[latestUserIndex - 1].id : '';
    const permission = this.settings.computerPermission || 'ask';
    const resumeState = this.agentSessionManager
      ? this.agentSessionManager.canResume(conversation, backendId, previousMessageId, { permission, cwd: '.', modelId })
      : { canResume: false, preparedOnly: false };
    const sessionHasBranchContext = Boolean(resumeState.canResume);
    const latestUser = latestUserIndex >= 0 ? sourceMessages[latestUserIndex] : null;
    const attachments = await this.attachmentAbsolutePaths(latestUser && latestUser.attachments || []);
    const projection = this.buildAgentDirectPrompt(backendId, agentName, conversation, messages, contextItems, sessionHasBranchContext);
    const result = await this.agentController.send({
      conversation,
      agentId: backendId,
      prompt: projection.prompt,
      handoff: projection.handoff,
      cwd: '.',
      permission,
      approve: (toolCall) => this.approveLocalToolCall(toolCall),
      attachments,
      reasoningEffort,
      modelId,
      previousMessageId,
    });
    await this.saveSettings();
    const toolRun = this.summarizeAgentRun(result);
    if (!result.ok && !result.output) throw new Error(result.error || `${agentName} direct task failed.`);
    const stopped = /cancel|interrupt|abort/i.test(String(result.stopReason || ''));
    return {
      content: result.output || (stopped ? '' : result.error || `${agentName} finished without a text response.`),
      toolRuns: toolRun ? [toolRun] : [],
      runtimeEvents: Array.isArray(result.runtimeEvents) ? result.runtimeEvents : [],
      stopped,
    };
  }

  async askConversation(messages, contextItems, conversationId = '', agentId = '', modelId = '', reasoningEffort = 'auto') {
    const conversation = this.getConversation(conversationId);
    const resolvedAgentId = agentId || this.resolveConversationAgentId(conversation);
    return this.askAgentDirect(
      resolvedAgentId,
      this.agentDisplayName(resolvedAgentId),
      messages,
      contextItems,
      conversationId,
      modelId,
      reasoningEffort,
    );
  }

  async askLightweightModel(messages, contextItems = [], {
    conversationId = '',
    reasoningEffort = 'auto',
    task = 'internal',
  } = {}) {
    if (!this.lightweightModelRuntime) {
      throw new Error('LightweightModelRuntime is unavailable.');
    }
    const conversation = this.getConversation(conversationId);
    const compiled = this.contextCompiler && conversation
      ? this.contextCompiler.compile({
          conversation,
          currentContextItems: contextItems,
          executionMode: 'lightweight',
          selectedSkill: task,
          hasAgentSession: false,
          recentMessageLimit: 20,
        })
      : null;
    const sourceMessages = compiled ? compiled.chatMessages : messages;
    const systemPrompt = [
      this.settings.systemPrompt,
      compiled && `Canonical branch: ${compiled.lineage.map((item) => item.branchId).join(' → ') || conversation.branchId || 'root'}`,
      compiled && `Persistent memory:\n${compiled.memoryBlock}`,
      compiled && `Question context:\n${compiled.currentContextBlock}`,
    ].filter(Boolean).join('\n\n');
    return this.lightweightModelRuntime.run({
      messages: sourceMessages,
      systemPrompt,
      task,
      reasoningEffort,
    });
  }

  async addConversationTextToCanvas({ text, currentCard = null, sourceConversationId = '', sourceMessageId = '' } = {}) {
    // Keep original Markdown source. Do not pass through rendered/plain text,
    // otherwise headings, lists, code blocks and embeds are lost in Canvas.
    const child = await this.addTextNodeToCurrentCanvas(text, currentCard);
    if (child && sourceConversationId) {
      await this.linkConversationToCard(child, sourceConversationId, { writeLink: true });
      child.sourceMessageId = sourceMessageId;
    }
    return child;
  }

  getCanvasViewportCenter(canvasPath) {
    const leaves = this.app.workspace.getLeavesOfType('canvas') || [];
    const leaf = leaves.find((candidate) => (
      candidate
      && candidate.view
      && candidate.view.file
      && candidate.view.file.path === canvasPath
    ));
    const view = leaf && leaf.view;
    const canvas = view && view.canvas;
    if (!view || !canvas) return null;

    // Prefer a center exposed directly by the live Canvas runtime when present.
    // Canvas internals are not part of Obsidian's public API, so keep this
    // capability-probed instead of depending on one private property name.
    const directCandidates = [
      canvas.posCenter,
      canvas.viewportCenter,
      canvas.viewCenter,
      canvas.center,
    ];
    for (const point of directCandidates) {
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        return { x: point.x, y: point.y };
      }
    }

    for (const methodName of ['getViewportBounds', 'getViewport', 'getViewBounds']) {
      try {
        const method = canvas[methodName];
        if (typeof method !== 'function') continue;
        const bounds = method.call(canvas);
        if (!bounds) continue;
        const left = Number.isFinite(bounds.left) ? bounds.left : bounds.x;
        const top = Number.isFinite(bounds.top) ? bounds.top : bounds.y;
        const width = Number.isFinite(bounds.width)
          ? bounds.width
          : Number.isFinite(bounds.right) && Number.isFinite(left)
            ? bounds.right - left
            : NaN;
        const height = Number.isFinite(bounds.height)
          ? bounds.height
          : Number.isFinite(bounds.bottom) && Number.isFinite(top)
            ? bounds.bottom - top
            : NaN;
        if ([left, top, width, height].every(Number.isFinite)) {
          return { x: left + width / 2, y: top + height / 2 };
        }
      } catch (_) {}
    }

    // Robust fallback: infer the current pan/zoom from any rendered Canvas node.
    // A node gives us one known world-space rectangle and one screen-space
    // rectangle, which is enough to map the visible screen center back to Canvas
    // coordinates without knowing Obsidian's private transform implementation.
    const host = canvas.wrapperEl
      || canvas.canvasEl
      || (view.containerEl && view.containerEl.querySelector('.canvas-wrapper'))
      || (view.containerEl && view.containerEl.querySelector('.canvas'))
      || view.containerEl;
    const hostRect = host && typeof host.getBoundingClientRect === 'function'
      ? host.getBoundingClientRect()
      : null;
    if (!hostRect || !hostRect.width || !hostRect.height) return null;
    const screenCenterX = hostRect.left + hostRect.width / 2;
    const screenCenterY = hostRect.top + hostRect.height / 2;

    const runtimeNodes = canvas.nodes && typeof canvas.nodes.values === 'function'
      ? Array.from(canvas.nodes.values())
      : [];
    for (const runtimeNode of runtimeNodes) {
      try {
        const data = typeof runtimeNode.getData === 'function' ? runtimeNode.getData() : runtimeNode;
        if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y)) continue;
        const nodeEl = runtimeNode.nodeEl || runtimeNode.el || runtimeNode.containerEl;
        if (!nodeEl || typeof nodeEl.getBoundingClientRect !== 'function') continue;
        const rect = nodeEl.getBoundingClientRect();
        const scaleCandidates = [];
        if (Number(data.width) > 0 && rect.width > 0) scaleCandidates.push(rect.width / Number(data.width));
        if (Number(data.height) > 0 && rect.height > 0) scaleCandidates.push(rect.height / Number(data.height));
        const validScales = scaleCandidates.filter((value) => Number.isFinite(value) && value > 0.0001);
        if (!validScales.length) continue;
        const scale = validScales.reduce((sum, value) => sum + value, 0) / validScales.length;
        return {
          x: Number(data.x) + (screenCenterX - rect.left) / scale,
          y: Number(data.y) + (screenCenterY - rect.top) / scale,
        };
      } catch (_) {}
    }
    return null;
  }

  async addTextNodeToCurrentCanvas(text, currentCard) {
    let anchorCard = currentCard || null;
    if (!anchorCard || !anchorCard.canvasPath) {
      try {
        anchorCard = await this.getSelectedCanvasCard();
      } catch (_) {}
    }

    let canvasPath = anchorCard && anchorCard.canvasPath;
    if (!canvasPath) {
      const leaves = this.app.workspace.getLeavesOfType('canvas') || [];
      const leaf = leaves.find((candidate) => candidate.view && candidate.view.file) || null;
      canvasPath = leaf && leaf.view && leaf.view.file && leaf.view.file.path;
    }
    if (!canvasPath) throw new Error('请先打开一个 Canvas，再使用 Add to Canvas。');

    const file = this.app.vault.getAbstractFileByPath(canvasPath);
    if (!file) throw new Error(`找不到 Canvas：${canvasPath}`);

    const raw = await this.app.vault.cachedRead(file);
    const data = JSON.parse(raw);
    data.nodes = Array.isArray(data.nodes) ? data.nodes : [];
    data.edges = Array.isArray(data.edges) ? data.edges : [];

    const parent = anchorCard && anchorCard.nodeId
      ? data.nodes.find((node) => node.id === anchorCard.nodeId)
      : null;
    const width = 420;
    const estimatedLines = Math.max(5, String(text).split('\n').length + Math.ceil(String(text).length / 46));
    const height = Math.min(520, Math.max(220, estimatedLines * 22 + 70));

    const viewportCenter = this.getCanvasViewportCenter(canvasPath);
    const fallbackCenter = parent
      ? { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 }
      : { x: 0, y: 0 };
    const targetCenter = viewportCenter || fallbackCenter;
    const nodeId = makeId('ai');
    const newNode = {
      id: nodeId,
      type: 'text',
      text,
      x: Math.round(targetCenter.x - width / 2),
      y: Math.round(targetCenter.y - height / 2),
      width,
      height,
      color: '4',
    };
    data.nodes.push(newNode);

    if (parent) {
      data.edges.push({
        id: makeId('edge'),
        fromNode: parent.id,
        fromSide: 'right',
        toNode: nodeId,
        toSide: 'left',
        toEnd: 'arrow',
        label: 'curated from chat',
      });
    }

    await this.app.vault.modify(file, JSON.stringify(data, null, 2));
    return {
      nodeId,
      label: firstUsefulLine(String(text || '')).slice(0, 72),
      text: String(text || ''),
      canvasPath,
      nodeData: newNode,
    };
  }
};
