function makeStateId(prefix = 'state') {
  const core = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  return `${prefix}-${core}`;
}

function cloneContextItem(item = {}) {
  return { ...item };
}

function cloneMessage(message = {}, { ensureId = false } = {}) {
  const next = {
    ...message,
    quote: message.quote ? { ...message.quote } : undefined,
    contextItems: Array.isArray(message.contextItems)
      ? message.contextItems.map(cloneContextItem)
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
  if (ensureId && !next.id) next.id = makeStateId('msg');
  return next;
}

function cloneBinding(binding = {}) {
  return { ...binding };
}

function normalizeState(settings) {
  settings.canonicalState = settings.canonicalState || {};
  const state = settings.canonicalState;
  state.version = 1;
  state.branches = state.branches || {};
  state.checkpoints = state.checkpoints || {};
  state.memories = state.memories || {};
  return state;
}

class CanonicalStateStore {
  constructor(settings) {
    this.settings = settings;
    this.state = normalizeState(settings);
  }

  getBranch(branchId) {
    return branchId ? this.state.branches[branchId] || null : null;
  }

  getBranchForConversation(conversation) {
    if (!conversation) return null;
    if (conversation.branchId && this.state.branches[conversation.branchId]) {
      return this.state.branches[conversation.branchId];
    }
    return null;
  }

  ensureConversation(conversation) {
    if (!conversation) return { branch: null, changed: false };
    let changed = false;
    let branch = this.getBranchForConversation(conversation);
    if (!branch) {
      const branchId = conversation.branchId || makeStateId('branch');
      const now = Date.now();
      const localMessages = (conversation.messages || []).map((message) => cloneMessage(message, { ensureId: true }));
      branch = {
        id: branchId,
        conversationId: conversation.id,
        parentBranchId: null,
        forkAtMessageId: null,
        localMessages,
        agentBindings: Object.fromEntries(
          Object.entries(conversation.agentBindings || conversation.executorSessions || {}).map(([key, value]) => [key, cloneBinding(value)]),
        ),
        createdAt: conversation.createdAt || now,
        updatedAt: conversation.updatedAt || now,
      };
      this.state.branches[branchId] = branch;
      conversation.branchId = branchId;
      conversation.messages = localMessages.map((message) => cloneMessage(message));
      changed = true;
    } else {
      if (!Array.isArray(branch.localMessages)) {
        branch.localMessages = [];
        changed = true;
      }
      if (!branch.agentBindings || typeof branch.agentBindings !== 'object') {
        branch.agentBindings = {};
        changed = true;
      }
      for (let i = 0; i < branch.localMessages.length; i += 1) {
        if (!branch.localMessages[i].id) {
          branch.localMessages[i].id = makeStateId('msg');
          changed = true;
        }
      }
      const projected = this.resolveBranchMessages(branch.id);
      if (!this.sameProjection(conversation.messages || [], projected)) {
        conversation.messages = projected.map((message) => cloneMessage(message));
        changed = true;
      }
    }
    return { branch, changed };
  }

  migrateConversations(conversations = {}) {
    let changed = false;
    for (const conversation of Object.values(conversations || {})) {
      const result = this.ensureConversation(conversation);
      changed = result.changed || changed;
    }
    // Recover legacy forks that used to duplicate the inherited message prefix into
    // each child conversation. Convert them to copy-on-write lineage in place.
    for (const conversation of Object.values(conversations || {})) {
      const meta = conversation && conversation.forkMeta;
      if (!meta || !meta.parentConversationId) continue;
      const parentConversation = conversations[meta.parentConversationId];
      if (!parentConversation) continue;
      const childBranch = this.getBranchForConversation(conversation);
      const parentBranch = this.getBranchForConversation(parentConversation);
      if (!childBranch || !parentBranch || childBranch.parentBranchId) continue;
      const parentMessages = this.resolveBranchMessages(parentBranch.id);
      if (!parentMessages.length) continue;
      const safeIndex = Math.max(0, Math.min(
        Number.isInteger(meta.messageIndex) ? meta.messageIndex : parentMessages.length - 1,
        parentMessages.length - 1,
      ));
      const inherited = parentMessages.slice(0, safeIndex + 1);
      const legacyProjection = (conversation.messages || childBranch.localMessages || [])
        .map((message) => cloneMessage(message, { ensureId: true }));
      let prefixMatches = legacyProjection.length >= inherited.length;
      if (prefixMatches) {
        for (let i = 0; i < inherited.length; i += 1) {
          if (legacyProjection[i].role !== inherited[i].role || legacyProjection[i].content !== inherited[i].content) {
            prefixMatches = false;
            break;
          }
        }
      }
      if (!prefixMatches) continue;
      childBranch.parentBranchId = parentBranch.id;
      childBranch.forkAtMessageId = inherited[inherited.length - 1].id;
      childBranch.localMessages = legacyProjection.slice(inherited.length);
      childBranch.updatedAt = Date.now();
      conversation.forkMeta = {
        ...meta,
        parentBranchId: parentBranch.id,
        forkAtMessageId: childBranch.forkAtMessageId,
      };
      conversation.messages = this.resolveBranchMessages(childBranch.id);
      changed = true;
    }
    return changed;
  }

  projectionMessageKey(message = {}) {
    return JSON.stringify({
      id: message.id || '',
      role: message.role || '',
      content: message.content || '',
      quote: message.quote || null,
      contextItems: Array.isArray(message.contextItems) ? message.contextItems : [],
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
      toolRuns: Array.isArray(message.toolRuns) ? message.toolRuns : [],
      runtimeEvents: Array.isArray(message.runtimeEvents) ? message.runtimeEvents : [],
      agentId: message.agentId || '',
      modelId: message.modelId || '',
      engine: message.engine || '',
      reasoningEffort: message.reasoningEffort || '',
    });
  }

  messageProjectionEqual(left = {}, right = {}) {
    return this.projectionMessageKey(left) === this.projectionMessageKey(right);
  }

  sameProjection(a = [], b = []) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!this.messageProjectionEqual(a[i] || {}, b[i] || {})) return false;
    }
    return true;
  }

  inheritedMessages(branch) {
    if (!branch || !branch.parentBranchId) return [];
    const parentMessages = this.resolveBranchMessages(branch.parentBranchId);
    if (!branch.forkAtMessageId) return parentMessages;
    const index = parentMessages.findIndex((message) => message.id === branch.forkAtMessageId);
    return index >= 0 ? parentMessages.slice(0, index + 1) : parentMessages;
  }

  resolveBranchMessages(branchId, seen = new Set()) {
    const branch = this.getBranch(branchId);
    if (!branch) return [];
    if (seen.has(branchId)) throw new Error(`Canonical branch cycle detected at ${branchId}`);
    const nextSeen = new Set(seen);
    nextSeen.add(branchId);
    let inherited = [];
    if (branch.parentBranchId) {
      const parentMessages = this.resolveBranchMessages(branch.parentBranchId, nextSeen);
      if (branch.forkAtMessageId) {
        const forkIndex = parentMessages.findIndex((message) => message.id === branch.forkAtMessageId);
        inherited = forkIndex >= 0 ? parentMessages.slice(0, forkIndex + 1) : parentMessages;
      } else {
        inherited = parentMessages;
      }
    }
    return [
      ...inherited.map((message) => cloneMessage(message)),
      ...(branch.localMessages || []).map((message) => cloneMessage(message)),
    ];
  }

  projectConversation(conversation) {
    const { branch } = this.ensureConversation(conversation);
    if (!branch) return [];
    const messages = this.resolveBranchMessages(branch.id);
    conversation.messages = messages.map((message) => cloneMessage(message));
    conversation.agentBindings = Object.fromEntries(
      Object.entries(branch.agentBindings || {}).map(([key, value]) => [key, cloneBinding(value)]),
    );
    conversation.executorSessions = Object.fromEntries(
      Object.entries(conversation.agentBindings).map(([key, value]) => [key, cloneBinding(value)]),
    );
    return messages;
  }

  replaceProjection(conversation, projectedMessages = []) {
    const { branch } = this.ensureConversation(conversation);
    if (!branch) return [];
    const normalized = projectedMessages.map((message) => cloneMessage(message, { ensureId: true }));
    const inherited = this.inheritedMessages(branch);
    let prefixMatches = normalized.length >= inherited.length;
    if (prefixMatches) {
      for (let i = 0; i < inherited.length; i += 1) {
        const a = normalized[i];
        const b = inherited[i];
        if (!this.messageProjectionEqual(a, b)) {
          prefixMatches = false;
          break;
        }
      }
    }
    if (!prefixMatches) {
      // A caller rewrote inherited history. Materialize a new root branch rather than silently
      // mutating an ancestor shared by other branches.
      branch.parentBranchId = null;
      branch.forkAtMessageId = null;
      branch.localMessages = normalized;
    } else {
      branch.localMessages = normalized.slice(inherited.length);
    }
    branch.updatedAt = Date.now();
    return this.projectConversation(conversation);
  }

  createFork(sourceConversation, childConversation, messageIndex) {
    const { branch: sourceBranch } = this.ensureConversation(sourceConversation);
    if (!sourceBranch) throw new Error('Source conversation has no canonical branch.');
    const sourceMessages = this.resolveBranchMessages(sourceBranch.id);
    const safeIndex = sourceMessages.length
      ? Math.max(0, Math.min(Number.isInteger(messageIndex) ? messageIndex : sourceMessages.length - 1, sourceMessages.length - 1))
      : -1;
    const forkAtMessageId = safeIndex >= 0 ? sourceMessages[safeIndex].id : null;
    const now = Date.now();
    const branchId = makeStateId('branch');
    const branch = {
      id: branchId,
      conversationId: childConversation.id,
      parentBranchId: sourceBranch.id,
      forkAtMessageId,
      localMessages: [],
      agentBindings: {},
      createdAt: now,
      updatedAt: now,
    };
    this.state.branches[branchId] = branch;
    childConversation.branchId = branchId;
    childConversation.messages = this.resolveBranchMessages(branchId);
    childConversation.agentBindings = {};
    childConversation.executorSessions = {};
    childConversation.forkMeta = {
      parentConversationId: sourceConversation.id,
      parentBranchId: sourceBranch.id,
      messageIndex: safeIndex,
      forkAtMessageId,
    };
    this.createCheckpoint(childConversation, safeIndex, 'fork');
    return branch;
  }

  getAgentBinding(conversation, agentId) {
    const { branch } = this.ensureConversation(conversation);
    if (!branch || !agentId) return null;
    const binding = branch.agentBindings && branch.agentBindings[agentId];
    return binding ? cloneBinding(binding) : null;
  }

  setAgentBinding(conversation, agentId, binding) {
    const { branch } = this.ensureConversation(conversation);
    if (!branch || !agentId) return null;
    branch.agentBindings = branch.agentBindings || {};
    branch.agentBindings[agentId] = cloneBinding(binding || {});
    branch.updatedAt = Date.now();
    conversation.agentBindings = Object.fromEntries(
      Object.entries(branch.agentBindings).map(([key, value]) => [key, cloneBinding(value)]),
    );
    conversation.executorSessions = Object.fromEntries(
      Object.entries(conversation.agentBindings).map(([key, value]) => [key, cloneBinding(value)]),
    );
    return cloneBinding(branch.agentBindings[agentId]);
  }

  clearAgentBindings(conversation) {
    const { branch } = this.ensureConversation(conversation);
    if (!branch) return;
    branch.agentBindings = {};
    conversation.agentBindings = {};
    conversation.executorSessions = {};
    branch.updatedAt = Date.now();
  }

  detachConversation(conversation) {
    const branch = this.getBranchForConversation(conversation);
    if (!branch) return;
    // Keep the branch as a tombstoned historical ancestor when descendants still
    // point to it. Deleting a UI Conversation must not sever child branch history.
    branch.conversationId = null;
    branch.deletedAt = Date.now();
    branch.updatedAt = Date.now();
  }

  createCheckpoint(conversation, messageIndex = null, reason = 'manual') {
    const { branch } = this.ensureConversation(conversation);
    if (!branch) return null;
    const messages = this.resolveBranchMessages(branch.id);
    const safeIndex = messages.length
      ? Math.max(0, Math.min(Number.isInteger(messageIndex) ? messageIndex : messages.length - 1, messages.length - 1))
      : -1;
    const checkpoint = {
      id: makeStateId('checkpoint'),
      branchId: branch.id,
      conversationId: conversation.id,
      atMessageId: safeIndex >= 0 ? messages[safeIndex].id : null,
      messageIndex: safeIndex,
      reason,
      createdAt: Date.now(),
    };
    this.state.checkpoints[checkpoint.id] = checkpoint;
    return checkpoint;
  }

  getLineage(conversation) {
    const { branch } = this.ensureConversation(conversation);
    if (!branch) return [];
    const lineage = [];
    let current = branch;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      lineage.unshift({
        branchId: current.id,
        conversationId: current.conversationId,
        forkAtMessageId: current.forkAtMessageId || null,
      });
      seen.add(current.id);
      current = current.parentBranchId ? this.getBranch(current.parentBranchId) : null;
    }
    return lineage;
  }

  addMemory({ scope = 'project', key = '', content = '', source = '', metadata = {} } = {}) {
    const memory = {
      id: makeStateId('memory'),
      scope,
      key: String(key || '').trim(),
      content: String(content || '').trim(),
      source: String(source || ''),
      metadata: { ...metadata },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.state.memories[memory.id] = memory;
    return { ...memory, metadata: { ...memory.metadata } };
  }

  listMemories({ scope = '', limit = 50 } = {}) {
    return Object.values(this.state.memories || {})
      .filter((memory) => !scope || memory.scope === scope)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit)
      .map((memory) => ({ ...memory, metadata: { ...(memory.metadata || {}) } }));
  }

  branchSnapshot(conversation, { atMessageIndex = null } = {}) {
    const { branch } = this.ensureConversation(conversation);
    if (!branch) return null;
    let messages = this.resolveBranchMessages(branch.id);
    if (Number.isInteger(atMessageIndex)) messages = messages.slice(0, Math.max(0, atMessageIndex + 1));
    const contextRefs = [];
    for (const message of messages) {
      for (const item of message.contextItems || []) {
        contextRefs.push({
          messageId: message.id,
          label: item.label || '',
          source: item.source || item.path || '',
          kind: item.kind || '',
        });
      }
    }
    return {
      version: 1,
      conversationId: conversation.id,
      branchId: branch.id,
      lineage: this.getLineage(conversation),
      messages: messages.map((message) => cloneMessage(message)),
      contextRefs,
      memories: this.listMemories({ limit: 30 }),
      createdAt: Date.now(),
    };
  }
}

function formatHistoricalMessage(message = {}) {
  const parts = [];
  if (message.quote && message.quote.text) {
    parts.push(`[Quote: ${message.quote.sourceLabel || 'selected text'}]\n${message.quote.text}`);
  }
  if (Array.isArray(message.contextItems) && message.contextItems.length) {
    const refs = message.contextItems.map((item) => `- ${item.label || item.source || 'Context'}${item.source ? ` (${item.source})` : ''}`);
    parts.push(`[Context used for this question]\n${refs.join('\n')}`);
  }
  if (Array.isArray(message.attachments) && message.attachments.length) {
    const refs = message.attachments.map((item) => `- ${item.label || 'Image'}${item.path ? ` (${item.path})` : ''}`);
    parts.push(`[Image attachments used for this question]\n${refs.join('\n')}`);
  }
  parts.push(String(message.content || ''));
  return parts.filter(Boolean).join('\n\n');
}

class ContextCompiler {
  constructor(canonicalState) {
    this.canonicalState = canonicalState;
  }

  compile({
    conversation,
    currentContextItems = [],
    executionMode = 'chat',
    selectedSkill = '',
    hasAgentSession = false,
    recentMessageLimit = 14,
  } = {}) {
    const messages = conversation && this.canonicalState
      ? this.canonicalState.projectConversation(conversation)
      : (conversation && conversation.messages || []).map((message) => cloneMessage(message));
    const latestUserIndex = [...messages].map((message) => message.role).lastIndexOf('user');
    const latestUser = latestUserIndex >= 0 ? messages[latestUserIndex] : null;
    const historyMessages = latestUserIndex >= 0 ? messages.slice(0, latestUserIndex) : messages;
    const recentMessages = historyMessages.slice(-recentMessageLimit);
    const lineage = conversation && this.canonicalState ? this.canonicalState.getLineage(conversation) : [];
    const memories = this.canonicalState ? this.canonicalState.listMemories({ limit: 20 }) : [];
    const currentContextBlock = currentContextItems.length
      ? currentContextItems.map((item, index) => `[#${index + 1} ${item.label || 'Context'}]\nSource: ${item.source || item.path || ''}\n${item.text || ''}`).join('\n\n---\n\n')
      : 'No explicit context was provided.';
    const memoryBlock = memories.length
      ? memories.map((memory) => `- [${memory.scope}] ${memory.key ? `${memory.key}: ` : ''}${memory.content}`).join('\n')
      : 'No persistent memory entries.';
    const historyText = recentMessages
      .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}:\n${formatHistoricalMessage(message)}`)
      .join('\n\n');
    const branchHeader = conversation
      ? `Conversation: ${conversation.title || conversation.id}\nBranch: ${conversation.branchId || 'legacy'}\nLineage depth: ${lineage.length}`
      : 'Conversation: unknown';
    const handoffText = [
      'GRAPH AI BRANCH HANDOFF',
      branchHeader,
      `Run mode: ${executionMode}${executionMode === 'skill' && selectedSkill ? ` (${selectedSkill})` : ''}`,
      '',
      'Persistent memory:',
      memoryBlock,
      !hasAgentSession ? `\nRecent branch history:\n${historyText || 'No previous messages.'}` : '',
      `\nExplicit context for this question:\n${currentContextBlock}`,
    ].filter(Boolean).join('\n');
    const chatMessages = messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.role === 'user' ? formatHistoricalMessage(message) : String(message.content || ''),
      attachments: Array.isArray(message.attachments) ? message.attachments.map((item) => ({ ...item })) : [],
    }));
    return {
      messages,
      recentMessages,
      latestUser,
      lineage,
      memories,
      currentContextBlock,
      memoryBlock,
      historyText,
      handoffText,
      chatMessages,
      snapshot: conversation && this.canonicalState ? this.canonicalState.branchSnapshot(conversation) : null,
    };
  }
}

module.exports = {
  CanonicalStateStore,
  ContextCompiler,
  cloneCanonicalMessage: cloneMessage,
};
