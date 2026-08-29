const RUNTIME_EVENTS = {
  RUN_STARTED: 'run.started',
  PLAN_CREATED: 'plan.created',
  PLAN_UPDATED: 'plan.updated',
  TASK_STARTED: 'task.started',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  ARTIFACT_CREATED: 'artifact.created',
  ARTIFACT_MODIFIED: 'artifact.modified',
  HANDOFF_CREATED: 'handoff.created',
  THOUGHT_DELTA: 'thought.delta',
  MESSAGE_DELTA: 'message.delta',
  RUN_COMPLETED: 'run.completed',
};

function createRuntimeEvent(type, payload = {}) {
  return {
    id: `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    timestamp: Date.now(),
    payload,
  };
}

function compactText(value, max = 1200) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function extractOutputPreview(update = {}) {
  const raw = update.rawOutput && (update.rawOutput.output || update.rawOutput.text || update.rawOutput)
    || update.output
    || '';
  if (raw) return compactText(raw);
  const blocks = Array.isArray(update.content) ? update.content : [];
  const text = blocks
    .map((block) => block && block.content && block.content.text || block && block.text || '')
    .filter(Boolean)
    .join('\n');
  return compactText(text);
}

function estimateDiffStats(text = '') {
  let additions = 0;
  let deletions = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\+[^+]/.test(line)) additions += 1;
    if (/^-[^-]/.test(line)) deletions += 1;
  }
  return additions || deletions ? { additions, deletions } : null;
}

function runtimeEventsFromBackendResult(result = {}, context = {}) {
  const events = [];
  const base = {
    conversationId: context.conversationId || '',
    branchId: context.branchId || '',
    agentId: context.agentId || result.backend || '',
    sessionId: result.sessionId || '',
  };
  for (const update of result.acpUpdates || []) {
    events.push(...runtimeEventsFromAcpUpdate(update, base));
  }
  return events;
}

function runtimeEventsFromAcpUpdate(update = {}, context = {}) {
  const events = [];
  if (!update || !update.sessionUpdate) return events;
  const base = {
    conversationId: context.conversationId || '',
    branchId: context.branchId || '',
    agentId: context.agentId || '',
    sessionId: context.sessionId || '',
  };
    if (update.sessionUpdate === 'agent_thought_chunk' && update.content && update.content.type === 'text') {
      const text = String(update.content.text || '');
      if (text) events.push(createRuntimeEvent(RUNTIME_EVENTS.THOUGHT_DELTA, { ...base, text }));
      return events;
    }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content && update.content.type === 'text') {
      const text = String(update.content.text || '');
      if (text) events.push(createRuntimeEvent(RUNTIME_EVENTS.MESSAGE_DELTA, { ...base, text }));
      return events;
    }
    if (update.sessionUpdate === 'tool_call') {
      events.push(createRuntimeEvent(RUNTIME_EVENTS.TOOL_STARTED, {
        ...base,
        toolCallId: update.toolCallId || '',
        title: update.title || '',
        kind: update.kind || '',
        status: update.status || 'pending',
        locations: update.locations || [],
        inputPreview: compactText(update.rawInput || ''),
      }));
      return events;
    }
    if (update.sessionUpdate === 'tool_call_update') {
      if (['completed', 'failed'].includes(update.status)) {
        const outputPreview = extractOutputPreview(update);
        events.push(createRuntimeEvent(RUNTIME_EVENTS.TOOL_COMPLETED, {
          ...base,
          toolCallId: update.toolCallId || '',
          title: update.title || '',
          kind: update.kind || '',
          status: update.status,
          locations: update.locations || [],
          inputPreview: compactText(update.rawInput || ''),
          outputPreview,
          diffStats: update.kind === 'edit' ? estimateDiffStats(outputPreview) : null,
        }));
      }
      if (update.kind === 'edit' && update.status === 'completed') {
        const outputPreview = extractOutputPreview(update);
        const diffStats = estimateDiffStats(outputPreview);
        for (const location of update.locations || []) {
          if (!location || !location.path) continue;
          events.push(createRuntimeEvent(RUNTIME_EVENTS.ARTIFACT_MODIFIED, {
            ...base,
            path: location.path,
            toolCallId: update.toolCallId || '',
            diffStats,
          }));
        }
      }
      if (update.status === 'failed') {
        events.push(createRuntimeEvent(RUNTIME_EVENTS.TASK_FAILED, {
          ...base,
          toolCallId: update.toolCallId || '',
          title: update.title || '',
        }));
      }
      return events;
    }
    if (update.sessionUpdate === 'plan') {
      events.push(createRuntimeEvent(RUNTIME_EVENTS.PLAN_UPDATED, { ...base, plan: update }));
    }
  return events;
}

module.exports = { RUNTIME_EVENTS, createRuntimeEvent, runtimeEventsFromBackendResult, runtimeEventsFromAcpUpdate };
