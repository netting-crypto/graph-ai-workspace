const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

function truncate(value, max = 50000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function macSystemProxyEnv() {
  if (process.platform !== 'darwin') return {};
  try {
    const result = require('child_process').execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const read = (key) => {
      const match = String(result || '').match(new RegExp(`\\b${key}\\s*:\\s*([^\\n]+)`));
      return match ? match[1].trim() : '';
    };
    const enabled = (key) => read(key) === '1';
    const env = {};
    if (enabled('HTTPEnable') && read('HTTPProxy') && read('HTTPPort')) {
      const url = `http://${read('HTTPProxy')}:${read('HTTPPort')}`;
      env.HTTP_PROXY = url;
      env.http_proxy = url;
    }
    if (enabled('HTTPSEnable') && read('HTTPSProxy') && read('HTTPSPort')) {
      const url = `http://${read('HTTPSProxy')}:${read('HTTPSPort')}`;
      env.HTTPS_PROXY = url;
      env.https_proxy = url;
    }
    if (enabled('SOCKSEnable') && read('SOCKSProxy') && read('SOCKSPort')) {
      const url = `socks5://${read('SOCKSProxy')}:${read('SOCKSPort')}`;
      env.ALL_PROXY = url;
      env.all_proxy = url;
    }
    return env;
  } catch (_) {
    return {};
  }
}

function inheritedAgentEnv(extra = {}) {
  return { ...process.env, ...macSystemProxyEnv(), ...(extra || {}) };
}

function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function resolveExecutable(name, explicitPath = '', extraCandidates = []) {
  const home = os.homedir();
  const candidates = [];
  if (explicitPath) candidates.push(path.resolve(String(explicitPath).replace(/^~(?=$|\/)/, home)));
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, name));
  }
  candidates.push(
    path.join(home, '.local', 'bin', name),
    path.join(home, '.npm-global', 'bin', name),
    path.join(home, '.bun', 'bin', name),
    path.join(home, '.cargo', 'bin', name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    ...extraCandidates,
  );
  return candidates.find(isExecutable) || '';
}

function resolveInside(rootPath, inputPath = '.') {
  const root = fs.realpathSync(path.resolve(rootPath || process.cwd()));
  const target = fs.realpathSync(path.resolve(root, inputPath || '.'));
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Working directory escapes allowed workspace: ${inputPath}`);
  return target;
}

function execFileCapture(executable, args, { cwd, timeoutMs = 15 * 60 * 1000, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(executable, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: inheritedAgentEnv(env),
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        signal: error && error.signal ? error.signal : null,
        error: error ? error.message || String(error) : '',
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
    if (child && child.stdin) child.stdin.end();
  });
}

function parseJsonLines(text) {
  const events = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || (!line.startsWith('{') && !line.startsWith('['))) continue;
    try { events.push(JSON.parse(line)); } catch (_) {}
  }
  return events;
}

function findDeepString(value, keys) {
  if (!value || typeof value !== 'object') return '';
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findDeepString(child, keys);
      if (found) return found;
    }
  }
  return '';
}

function extractLikelyFinalText(events, fallback = '') {
  const preferred = [];
  for (const event of events || []) {
    const item = event && event.item && typeof event.item === 'object' ? event.item : null;
    const type = String(item && (item.type || item.kind) || event && (event.type || event.kind) || '').toLowerCase();
    if (item && (type.includes('agent_message') || type === 'message')) {
      const text = findDeepString(item, ['text', 'content', 'message', 'output', 'response']);
      if (text) preferred.push(text);
      continue;
    }
    if (type.includes('agent_message') || type.includes('message') || type.includes('text')) {
      const text = findDeepString(event, ['text', 'content', 'message', 'output', 'response']);
      if (text) preferred.push(text);
    }
  }
  if (preferred.length) return preferred[preferred.length - 1];
  const fallbackText = String(fallback || '').trim();
  if (fallbackText) {
    try {
      const doc = JSON.parse(fallbackText);
      const response = findDeepString(doc, ['response', 'text', 'content', 'message', 'output']);
      if (response) return response;
    } catch (_) {}
  }
  return fallbackText || 'Agent finished without a text summary.';
}

module.exports = {
  truncate,
  macSystemProxyEnv,
  inheritedAgentEnv,
  isExecutable,
  resolveExecutable,
  resolveInside,
  execFileCapture,
  parseJsonLines,
  findDeepString,
  extractLikelyFinalText,
};
