function compactList(items = [], mapper = (item) => String(item || '')) {
  return items.map(mapper).map((item) => String(item || '').trim()).filter(Boolean);
}

function createAgentHandoff({
  kind = 'migration_handoff',
  conversation = null,
  compiled = null,
  sourceAgentId = '',
  targetAgentId = '',
} = {}) {
  const latest = compiled && compiled.latestUser || null;
  const contextItems = latest && Array.isArray(latest.contextItems) ? latest.contextItems : [];
  const attachments = latest && Array.isArray(latest.attachments) ? latest.attachments : [];
  const lineage = compiled && Array.isArray(compiled.lineage) ? compiled.lineage : [];
  return {
    kind,
    conversationId: conversation && conversation.id || '',
    branchId: conversation && conversation.branchId || '',
    sourceAgentId,
    targetAgentId,
    objective: latest && latest.content || '',
    scope: {
      conversationTitle: conversation && conversation.title || '',
      lineage: compactList(lineage, (item) => item.branchId || item.id || ''),
    },
    confirmedConclusions: [],
    evidenceArtifacts: [
      ...compactList(contextItems, (item) => item.label || item.source || item.path || ''),
      ...compactList(attachments, (item) => item.label || item.path || ''),
    ],
    unresolvedQuestions: latest && latest.content ? [latest.content] : [],
    risksAssumptions: [
      'This handoff is a runtime projection. Graph AI Canonical Branch remains the complete source of truth.',
      'Do not assume private state from a previous Agent session unless it is explicitly present in this handoff/context.',
    ],
    recommendedNextAction: latest && latest.content
      ? 'Continue the current user request from the supplied canonical branch context.'
      : 'Inspect the supplied canonical branch context before acting.',
    createdAt: Date.now(),
  };
}

function renderAgentHandoff(handoff = {}) {
  const list = (items) => Array.isArray(items) && items.length
    ? items.map((item) => `- ${item}`).join('\n')
    : '- None explicitly extracted.';
  return [
    'AGENT HANDOFF',
    `Kind: ${handoff.kind || 'migration_handoff'}`,
    `Source Agent: ${handoff.sourceAgentId || 'none / fresh session'}`,
    `Target Agent: ${handoff.targetAgentId || 'unknown'}`,
    `Conversation: ${handoff.scope && handoff.scope.conversationTitle || handoff.conversationId || 'unknown'}`,
    `Branch: ${handoff.branchId || 'unknown'}`,
    '',
    'Objective / scope:',
    handoff.objective || 'No explicit objective.',
    '',
    'Confirmed conclusions:',
    list(handoff.confirmedConclusions),
    '',
    'Evidence / artifacts:',
    list(handoff.evidenceArtifacts),
    '',
    'Unresolved questions:',
    list(handoff.unresolvedQuestions),
    '',
    'Risks / assumptions:',
    list(handoff.risksAssumptions),
    '',
    'Recommended next action:',
    handoff.recommendedNextAction || 'Continue from canonical context.',
  ].join('\n');
}

module.exports = { createAgentHandoff, renderAgentHandoff };
