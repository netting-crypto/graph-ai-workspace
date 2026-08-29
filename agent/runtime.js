const {
  RUNTIME_EVENTS,
  createRuntimeEvent,
  runtimeEventsFromBackendResult,
  runtimeEventsFromAcpUpdate,
} = require('./runtime-events');

class AgentRuntimeController {
  constructor({ registry, sessionManager, onEvent = null } = {}) {
    this.registry = registry;
    this.sessionManager = sessionManager;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
  }

  emit(type, payload = {}) {
    const event = createRuntimeEvent(type, payload);
    if (this.onEvent) {
      try { this.onEvent(event); } catch (_) {}
    }
    return event;
  }

  getAgent(agentId) {
    return this.registry && this.registry.get(agentId);
  }

  async status(agentId) {
    const backend = this.getAgent(agentId);
    if (!backend) return { id: agentId, available: false, runnable: false, detail: 'Agent is not registered.' };
    return backend.detect();
  }

  async capabilities(agentId) {
    return this.registry.capabilities(agentId);
  }

  async prepare({ conversation, agentId, cwd = '.', permission = 'ask', branchHeadMessageId = '', modelId = '' } = {}) {
    const backend = this.getAgent(agentId);
    if (!backend || typeof backend.start !== 'function') return null;
    const current = this.sessionManager.getBinding(conversation, agentId);
    const currentMatchesBranch = Boolean(
      current
      && current.sessionId
      && (!current.permission || current.permission === permission)
      && (!current.cwd || current.cwd === cwd)
      && (!modelId || !current.modelId || current.modelId === modelId)
      && (
        current.preparedOnly === true
        || (branchHeadMessageId && current.syncedThroughMessageId === branchHeadMessageId)
      ),
    );
    const binding = currentMatchesBranch ? current : null;
    const result = await backend.start({ cwd, permission, binding, modelId });
    if (result && result.ok && result.sessionId) {
      this.sessionManager.bind(conversation, agentId, {
        ...(binding || {}),
        ...result,
        agentId,
        protocol: backend.protocol,
        bindingRole: 'conversation-agent',
        preparedOnly: binding ? Boolean(binding.preparedOnly) : true,
        state: binding ? (binding.preparedOnly ? 'prepared' : 'ready') : 'prepared',
        lastError: '',
        modelId: result.modelId || modelId || binding && binding.modelId || '',
        syncedThroughMessageId: binding && !binding.preparedOnly ? binding.syncedThroughMessageId || '' : '',
      });
    }
    return result;
  }

  async send({
    conversation,
    agentId,
    prompt,
    handoff = null,
    cwd = '.',
    permission = 'ask',
    approve,
    attachments = [],
    reasoningEffort = 'auto',
    modelId = '',
    previousMessageId = '',
  } = {}) {
    const backend = this.getAgent(agentId);
    if (!backend) throw new Error(`Agent is not registered: ${agentId}`);

    const resumeState = this.sessionManager.canResume(conversation, agentId, previousMessageId, { permission, cwd, modelId });
    const bindingForSend = resumeState.canResume || resumeState.preparedOnly ? resumeState.binding : null;
    const events = [this.emit(RUNTIME_EVENTS.RUN_STARTED, {
      conversationId: conversation && conversation.id || '',
      branchId: conversation && conversation.branchId || '',
      agentId,
      sessionId: bindingForSend && bindingForSend.sessionId || '',
      resumed: resumeState.canResume,
    })];
    if (handoff) {
      events.push(this.emit(RUNTIME_EVENTS.HANDOFF_CREATED, {
        conversationId: conversation && conversation.id || '',
        branchId: conversation && conversation.branchId || '',
        agentId,
        handoff,
      }));
    }

    let result;
    const streamedBackendEvents = [];
    try {
      result = await backend.send({
        prompt,
        cwd,
        permission,
        approve,
        binding: bindingForSend,
        attachments,
        reasoningEffort,
        modelId,
        onRuntimeUpdate: (update, runtimeMeta = {}) => {
          const updateEvents = runtimeEventsFromAcpUpdate(update, {
            conversationId: conversation && conversation.id || '',
            branchId: conversation && conversation.branchId || '',
            agentId,
            sessionId: runtimeMeta.sessionId || bindingForSend && bindingForSend.sessionId || '',
          });
          for (const event of updateEvents) {
            streamedBackendEvents.push(event);
            events.push(event);
            if (this.onEvent) {
              try { this.onEvent(event); } catch (_) {}
            }
          }
        },
      });
    } catch (error) {
      this.sessionManager.markCrashed(conversation, agentId, error.message || String(error));
      events.push(this.emit(RUNTIME_EVENTS.TASK_FAILED, {
        agentId,
        error: error.message || String(error),
      }));
      throw error;
    }

    const backendEvents = streamedBackendEvents.length ? [] : runtimeEventsFromBackendResult(result || {}, {
      conversationId: conversation && conversation.id || '',
      branchId: conversation && conversation.branchId || '',
      agentId,
    });
    for (const event of backendEvents) {
      events.push(event);
      if (this.onEvent) {
        try { this.onEvent(event); } catch (_) {}
      }
    }

    if (result && result.sessionId) {
      this.sessionManager.bind(conversation, agentId, {
        ...(bindingForSend || {}),
        ...result,
        agentId,
        protocol: backend.protocol,
        bindingRole: 'conversation-agent',
        preparedOnly: false,
        state: result.ok === false ? 'crashed' : 'ready',
        lastError: result.ok === false ? String(result.error || '').slice(0, 1000) : '',
        modelId: result.modelId || modelId || bindingForSend && bindingForSend.modelId || '',
        // The caller marks the exact Graph AI assistant message id after it is persisted.
        syncedThroughMessageId: bindingForSend && bindingForSend.syncedThroughMessageId || '',
      });
    }

    events.push(this.emit(RUNTIME_EVENTS.RUN_COMPLETED, {
      conversationId: conversation && conversation.id || '',
      branchId: conversation && conversation.branchId || '',
      agentId,
      sessionId: result && result.sessionId || '',
      ok: Boolean(result && result.ok),
      resumed: Boolean(result && result.resumed),
    }));

    return { ...result, runtimeEvents: events };
  }

  markSynced(conversation, agentId, messageId) {
    const binding = this.sessionManager.getBinding(conversation, agentId);
    if (!binding || !binding.sessionId) return null;
    return this.sessionManager.bind(conversation, agentId, {
      ...binding,
      preparedOnly: false,
      state: 'ready',
      lastError: '',
      syncedThroughMessageId: messageId,
      bindingRole: 'conversation-agent',
    });
  }

  async stop(conversation, agentId) {
    const backend = this.getAgent(agentId);
    if (!backend) return false;
    const binding = this.sessionManager.getBinding(conversation, agentId);
    if (typeof backend.stop === 'function') {
      const stopped = await backend.stop({ binding });
      if (stopped) this.sessionManager.markSleeping(conversation, agentId);
      return stopped;
    }
    return false;
  }

  close() {
    if (this.registry && typeof this.registry.close === 'function') this.registry.close();
  }
}

module.exports = { AgentRuntimeController };
