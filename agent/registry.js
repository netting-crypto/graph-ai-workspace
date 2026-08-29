const { normalizeCapabilities } = require('./capabilities');

class AgentRegistry {
  constructor() {
    this.backends = new Map();
  }

  register(backendOrId, maybeBackend = null) {
    const backend = maybeBackend || backendOrId;
    const id = maybeBackend ? backendOrId : backend && backend.id;
    if (!id || !backend) throw new Error('AgentRegistry.register requires an AgentBackend with id.');
    backend.id = id;
    backend.capabilities = normalizeCapabilities(backend.capabilities || {});
    this.backends.set(id, backend);
    return backend;
  }

  unregister(id) {
    const backend = this.backends.get(id);
    if (backend && typeof backend.close === 'function') backend.close();
    return this.backends.delete(id);
  }

  get(id) {
    return this.backends.get(id) || null;
  }

  list() {
    return Array.from(this.backends.values());
  }

  async statuses() {
    return Promise.all(this.list().map(async (backend) => {
      try {
        const status = await backend.detect();
        return { ...status, id: backend.id, name: backend.name, protocol: backend.protocol };
      } catch (error) {
        return {
          id: backend.id,
          name: backend.name,
          protocol: backend.protocol,
          available: false,
          runnable: false,
          detail: error.message || String(error),
        };
      }
    }));
  }

  async capabilities(id) {
    const backend = this.get(id);
    if (!backend) return normalizeCapabilities();
    if (typeof backend.getCapabilities === 'function') {
      return normalizeCapabilities(await backend.getCapabilities());
    }
    return normalizeCapabilities(backend.capabilities || {});
  }

  close() {
    for (const backend of this.backends.values()) {
      if (!backend) continue;
      if (typeof backend.dispose === 'function') backend.dispose();
      else if (typeof backend.close === 'function') backend.close();
    }
  }
}

module.exports = { AgentRegistry };
