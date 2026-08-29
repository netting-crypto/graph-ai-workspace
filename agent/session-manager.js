class AgentSessionManager {
  constructor({ canonicalStateStore = null } = {}) {
    this.canonicalStateStore = canonicalStateStore;
    this.fallbackBindings = {};
  }

  _branchKey(conversation, agentId) {
    const branchId = conversation && conversation.branchId || conversation && conversation.id || 'unknown';
    return `${branchId}:${agentId}`;
  }

  getBinding(conversation, agentId) {
    if (!conversation || !agentId) return null;
    if (this.canonicalStateStore && typeof this.canonicalStateStore.getAgentBinding === 'function') {
      return this.canonicalStateStore.getAgentBinding(conversation, agentId);
    }
    const binding = this.fallbackBindings[this._branchKey(conversation, agentId)];
    return binding ? { ...binding } : null;
  }

  bind(conversation, agentId, binding = {}) {
    if (!conversation || !agentId) return null;
    const next = {
      agentId,
      protocol: binding.protocol || null,
      sessionId: binding.sessionId || null,
      permission: binding.permission || 'ask',
      cwd: binding.cwd || '.',
      transport: binding.transport || '',
      modelId: binding.modelId || '',
      syncedThroughMessageId: binding.syncedThroughMessageId || '',
      preparedOnly: Boolean(binding.preparedOnly),
      bindingRole: binding.bindingRole || 'conversation-agent',
      state: binding.state || (binding.preparedOnly ? 'prepared' : 'ready'),
      lastError: binding.lastError || '',
      updatedAt: Date.now(),
    };
    if (this.canonicalStateStore && typeof this.canonicalStateStore.setAgentBinding === 'function') {
      return this.canonicalStateStore.setAgentBinding(conversation, agentId, next);
    }
    this.fallbackBindings[this._branchKey(conversation, agentId)] = next;
    return { ...next };
  }

  clear(conversation, agentId) {
    if (!conversation || !agentId) return;
    if (this.canonicalStateStore && typeof this.canonicalStateStore.getBranchForConversation === 'function') {
      const branch = this.canonicalStateStore.getBranchForConversation(conversation);
      if (branch && branch.agentBindings) {
        delete branch.agentBindings[agentId];
        branch.updatedAt = Date.now();
      }
      return;
    }
    delete this.fallbackBindings[this._branchKey(conversation, agentId)];
  }

  isSyncedThrough(conversation, agentId, messageId) {
    const binding = this.getBinding(conversation, agentId);
    if (!binding || !binding.sessionId || binding.preparedOnly) return false;
    return Boolean(messageId && binding.syncedThroughMessageId === messageId);
  }

  canResume(conversation, agentId, previousMessageId, { permission = '', cwd = '', modelId = '' } = {}) {
    const binding = this.getBinding(conversation, agentId);
    if (!binding || !binding.sessionId) return { binding: null, canResume: false, preparedOnly: false };
    if (binding.state === 'crashed') return { binding, canResume: false, preparedOnly: false, crashed: true };
    const permissionMatches = !permission || !binding.permission || binding.permission === permission;
    const cwdMatches = !cwd || !binding.cwd || binding.cwd === cwd;
    const modelMatches = !modelId || binding.modelId === modelId;
    if (!permissionMatches || !cwdMatches || !modelMatches) {
      return { binding, canResume: false, preparedOnly: false, incompatibleRuntime: true };
    }
    if (binding.preparedOnly) return { binding, canResume: false, preparedOnly: true };
    return {
      binding,
      canResume: Boolean(previousMessageId && binding.syncedThroughMessageId === previousMessageId),
      preparedOnly: false,
    };
  }

  markSleeping(conversation, agentId) {
    const binding = this.getBinding(conversation, agentId);
    if (!binding) return null;
    return this.bind(conversation, agentId, { ...binding, state: 'sleeping' });
  }

  markAwake(conversation, agentId) {
    const binding = this.getBinding(conversation, agentId);
    if (!binding) return null;
    return this.bind(conversation, agentId, {
      ...binding,
      state: binding.preparedOnly ? 'prepared' : 'ready',
      lastError: '',
    });
  }

  markCrashed(conversation, agentId, error = '') {
    const binding = this.getBinding(conversation, agentId);
    if (!binding) return null;
    return this.bind(conversation, agentId, {
      ...binding,
      state: 'crashed',
      lastError: String(error || '').slice(0, 1000),
    });
  }
}

module.exports = { AgentSessionManager };
