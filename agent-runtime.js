const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.scss', '.html', '.htm', '.py', '.sh', '.zsh', '.toml', '.ini', '.csv', '.xml',
  '.canvas', '.sql', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.swift', '.kt', '.kts',
]);

const SKIP_DIRS = new Set(['.git', 'node_modules', '.Trash', '__pycache__']);
const HIGH_RISK_PROGRAMS = new Set(['sudo', 'rm', 'dd', 'mkfs', 'diskutil', 'shutdown', 'reboot', 'kill', 'killall', 'launchctl', 'chmod', 'chown']);

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function truncate(value, max = 30000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

class LocalAgentRuntime {
  constructor(rootPath) {
    this.rootPath = path.resolve(rootPath || process.cwd());
  }

  getToolDefinitions() {
    return [
      {
        type: 'function',
        function: {
          name: 'list_directory',
          description: 'List files and folders inside the allowed Obsidian workspace root. Paths are relative to the workspace root unless absolute.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Directory path. Use . for the workspace root.' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a text file inside the allowed workspace root.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              max_chars: { type: 'integer', minimum: 1000, maximum: 100000 },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search_files',
          description: 'Search text across files inside the allowed workspace root. Returns matching files and snippets.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              path: { type: 'string', description: 'Optional directory scope, default .' },
              max_results: { type: 'integer', minimum: 1, maximum: 100 },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Create or overwrite a UTF-8 text file inside the allowed workspace root. This is a modifying action.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'run_command',
          description: 'Run a program without a shell inside an allowed working directory. Prefer this for tests, builds, git inspection, and project commands. This can modify local state.',
          parameters: {
            type: 'object',
            properties: {
              program: { type: 'string', description: 'Executable name, e.g. git, node, python3.' },
              args: { type: 'array', items: { type: 'string' }, description: 'Argument array. No shell syntax.' },
              cwd: { type: 'string', description: 'Working directory inside workspace root, default .' },
              timeout_seconds: { type: 'integer', minimum: 1, maximum: 120 },
            },
            required: ['program'],
            additionalProperties: false,
          },
        },
      },
    ];
  }

  async canonicalExisting(inputPath = '.') {
    const resolved = path.resolve(this.rootPath, inputPath || '.');
    let real;
    try {
      real = await fsp.realpath(resolved);
    } catch (error) {
      throw new Error(`Path does not exist: ${inputPath}`);
    }
    if (!isInside(this.rootPath, real)) throw new Error(`Path escapes allowed root: ${inputPath}`);
    return real;
  }

  async canonicalForWrite(inputPath) {
    const resolved = path.resolve(this.rootPath, inputPath || '.');
    if (!isInside(this.rootPath, resolved)) throw new Error(`Path escapes allowed root: ${inputPath}`);
    const parent = path.dirname(resolved);
    await fsp.mkdir(parent, { recursive: true });
    const parentReal = await fsp.realpath(parent);
    if (!isInside(this.rootPath, parentReal)) throw new Error(`Parent escapes allowed root: ${inputPath}`);
    return resolved;
  }

  relative(absPath) {
    const rel = path.relative(this.rootPath, absPath);
    return rel || '.';
  }

  async needsApproval(name, args, permission) {
    if (name === 'write_file') {
      if (permission === 'read-only') return 'deny';
      return permission !== 'allow-edits';
    }
    if (name === 'run_command') {
      if (permission === 'read-only') return 'deny';
      const program = path.basename(String(args.program || '')).toLowerCase();
      if (permission === 'ask' || HIGH_RISK_PROGRAMS.has(program)) return true;
      return false;
    }
    return false;
  }

  describeToolCall(name, args) {
    if (name === 'write_file') return `Write file\n${args.path}\n\n${truncate(args.content, 1200)}`;
    if (name === 'run_command') return `Run command\n${args.program} ${(args.args || []).join(' ')}\n\ncwd: ${args.cwd || '.'}`;
    return `${name}\n${JSON.stringify(args, null, 2)}`;
  }

  async executeTool(name, args = {}, { permission = 'ask', approve } = {}) {
    const approval = await this.needsApproval(name, args, permission);
    if (approval === 'deny') {
      return { ok: false, denied: true, error: `${name} is blocked in Read only mode.` };
    }
    if (approval === true) {
      if (typeof approve !== 'function') return { ok: false, denied: true, error: 'Approval required.' };
      const allowed = await approve({ name, args, description: this.describeToolCall(name, args) });
      if (!allowed) return { ok: false, denied: true, error: 'User denied this tool call.' };
    }

    try {
      if (name === 'list_directory') return await this.listDirectory(args);
      if (name === 'read_file') return await this.readFile(args);
      if (name === 'search_files') return await this.searchFiles(args);
      if (name === 'write_file') return await this.writeFile(args);
      if (name === 'run_command') return await this.runCommand(args);
      return { ok: false, error: `Unknown tool: ${name}` };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  }

  async listDirectory({ path: inputPath = '.' } = {}) {
    const dir = await this.canonicalExisting(inputPath);
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${inputPath}`);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const items = entries
      .map((entry) => ({
        name: entry.name,
        path: this.relative(path.join(dir, entry.name)),
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    return { ok: true, path: this.relative(dir), items: items.slice(0, 300) };
  }

  async readFile({ path: inputPath, max_chars = 30000 } = {}) {
    if (!inputPath) throw new Error('path is required');
    const file = await this.canonicalExisting(inputPath);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error(`Not a file: ${inputPath}`);
    const content = await fsp.readFile(file, 'utf8');
    return { ok: true, path: this.relative(file), content: truncate(content, max_chars), truncated: content.length > max_chars };
  }

  async searchFiles({ query, path: inputPath = '.', max_results = 40 } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) throw new Error('query is required');
    const start = await this.canonicalExisting(inputPath);
    const results = [];
    const queue = [start];
    let visited = 0;

    while (queue.length && results.length < max_results && visited < 5000) {
      const current = queue.shift();
      const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= max_results || visited >= 5000) break;
        visited += 1;
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) queue.push(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const stat = await fsp.stat(abs).catch(() => null);
        if (!stat || stat.size > 2_000_000) continue;
        const content = await fsp.readFile(abs, 'utf8').catch(() => '');
        const lower = content.toLowerCase();
        const idx = lower.indexOf(needle);
        const nameHit = entry.name.toLowerCase().includes(needle);
        if (idx < 0 && !nameHit) continue;
        const center = idx >= 0 ? idx : 0;
        results.push({
          path: this.relative(abs),
          snippet: truncate(content.slice(Math.max(0, center - 260), center + 900), 1400),
        });
      }
    }
    return { ok: true, query, scope: this.relative(start), results, visited };
  }

  async writeFile({ path: inputPath, content } = {}) {
    if (!inputPath) throw new Error('path is required');
    const file = await this.canonicalForWrite(inputPath);
    await fsp.writeFile(file, String(content ?? ''), 'utf8');
    return { ok: true, path: this.relative(file), bytes: Buffer.byteLength(String(content ?? ''), 'utf8') };
  }

  async runCommand({ program, args = [], cwd = '.', timeout_seconds = 30 } = {}) {
    const exe = String(program || '').trim();
    if (!exe) throw new Error('program is required');
    if (/[;&|><`\n\r]/.test(exe)) throw new Error('Shell syntax is not allowed in program.');
    if (!Array.isArray(args)) throw new Error('args must be an array');
    const workingDir = await this.canonicalExisting(cwd || '.');
    const stat = await fsp.stat(workingDir);
    if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);

    return new Promise((resolve) => {
      execFile(exe, args.map(String), {
        cwd: workingDir,
        timeout: Math.min(Math.max(Number(timeout_seconds) || 30, 1), 120) * 1000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PWD: workingDir },
      }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          program: exe,
          args,
          cwd: this.relative(workingDir),
          exitCode: error && typeof error.code === 'number' ? error.code : error ? null : 0,
          signal: error && error.signal ? error.signal : null,
          stdout: truncate(stdout, 30000),
          stderr: truncate(stderr, 12000),
          error: error ? error.message : null,
        });
      });
    });
  }
}

module.exports = { LocalAgentRuntime };
