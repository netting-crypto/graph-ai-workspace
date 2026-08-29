function normalizeCapabilities(input = {}) {
  return {
    persistentSession: false,
    resume: false,
    nativeFork: false,
    vision: false,
    attachments: false,
    reasoningEffort: false,
    reasoningLevels: [],
    tools: false,
    skills: false,
    safeStop: false,
    interactiveInput: false,
    plan: false,
    diff: false,
    permissions: false,
    ...input,
  };
}

module.exports = { normalizeCapabilities };
