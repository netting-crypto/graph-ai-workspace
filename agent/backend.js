const { normalizeCapabilities } = require('./capabilities');

class AgentBackend {
  constructor({ id, name, protocol, rootPath, capabilities = {} } = {}) {
    if (!id) throw new Error('AgentBackend requires id.');
    this.id = id;
    this.name = name || id;
    this.protocol = protocol || 'unknown';
    this.rootPath = rootPath || process.cwd();
    this.capabilities = normalizeCapabilities(capabilities);
  }

  async detect() {
    return {
      id: this.id,
      name: this.name,
      protocol: this.protocol,
      available: true,
      runnable: true,
      capabilities: this.getCapabilities(),
    };
  }

  getCapabilities() {
    return normalizeCapabilities(this.capabilities);
  }

  async getModelOptions() {
    return [];
  }

  async start() {
    throw new Error(`${this.name} has not implemented start().`);
  }

  async send() {
    throw new Error(`${this.name} has not implemented send().`);
  }

  async resume(options = {}) {
    return this.start({ ...options, resume: true });
  }

  async stop() {
    return false;
  }

  async close() {
    return false;
  }
}

module.exports = { AgentBackend };
