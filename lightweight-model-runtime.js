class LightweightModelRuntime {
  constructor({
    settings,
    getDesktopProviderBridge,
    requestChatCompletion,
    requestAnthropicCompletion,
    buildMultimodalChatMessages,
    buildAnthropicChatMessages,
  } = {}) {
    this.settings = settings || {};
    this.getDesktopProviderBridge = getDesktopProviderBridge;
    this.requestChatCompletion = requestChatCompletion;
    this.requestAnthropicCompletion = requestAnthropicCompletion;
    this.buildMultimodalChatMessages = buildMultimodalChatMessages;
    this.buildAnthropicChatMessages = buildAnthropicChatMessages;
  }

  resolveProvider() {
    if (this.settings.provider === 'desktop-provider-bridge') {
      const bridge = this.getDesktopProviderBridge();
      return {
        kind: bridge.kind || 'openai-compatible',
        baseUrl: bridge.baseUrl,
        apiKey: bridge.apiKey,
        model: bridge.model,
      };
    }
    return {
      kind: 'openai-compatible',
      baseUrl: String(this.settings.baseUrl || '').replace(/\/$/, ''),
      apiKey: this.settings.apiKey || '',
      model: this.settings.model || '',
    };
  }

  async run({ messages = [], systemPrompt = '', task = 'internal', reasoningEffort = 'auto' } = {}) {
    if (this.settings.provider === 'mock') {
      const latest = [...messages].reverse().find((message) => message && message.role === 'user');
      return {
        content: `Lightweight model mock response.\nInternal task: ${task}.${latest ? `\nInput: ${latest.content || ''}` : ''}`,
        toolRuns: [],
      };
    }

    const provider = this.resolveProvider();
    if (!provider.baseUrl) throw new Error('LightweightModelRuntime: missing Base URL.');
    if (!provider.model) throw new Error('LightweightModelRuntime: missing model.');
    const internalSystem = [
      systemPrompt,
      'You are Graph AI LightweightModelRuntime.',
      `Internal task: ${task}.`,
      'Do not execute shell commands, edit files, or delegate to another agent. Return only the compact result requested by the internal task.',
    ].filter(Boolean).join('\n\n');

    if (provider.kind === 'anthropic') {
      const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': provider.apiKey,
        Authorization: `Bearer ${provider.apiKey}`,
      };
      const sourceMessages = await this.buildAnthropicChatMessages(messages, 20);
      const response = await this.requestAnthropicCompletion(provider.baseUrl, headers, {
        model: provider.model,
        max_tokens: 2048,
        system: internalSystem,
        messages: sourceMessages,
      });
      const blocks = response.json && Array.isArray(response.json.content) ? response.json.content : [];
      const content = blocks
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text || '')
        .join('\n')
        .trim();
      if (!content) throw new Error((response.json && response.json.error && response.json.error.message) || 'Lightweight model returned no text.');
      return { content, toolRuns: [] };
    }

    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    const payload = {
      model: provider.model,
      messages: [
        { role: 'system', content: internalSystem },
        ...(await this.buildMultimodalChatMessages(messages, 20)),
      ],
    };
    if (
      reasoningEffort
      && reasoningEffort !== 'auto'
      && (/^(gpt-5|o\d)/i.test(provider.model) || /^kimi-k3$/i.test(provider.model))
    ) {
      payload.reasoning_effort = reasoningEffort;
    }
    const response = await this.requestChatCompletion(provider.baseUrl, headers, payload);
    const choice = response.json && response.json.choices && response.json.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (!content) throw new Error((response.json && response.json.error && response.json.error.message) || 'Lightweight model returned no text.');
    return { content, toolRuns: [] };
  }
}

module.exports = { LightweightModelRuntime };
