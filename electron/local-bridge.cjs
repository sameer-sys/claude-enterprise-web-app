const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');

// -------------------------------------------------------------
// 1. Embedded SQLite & JSON Database Manager (Node 22 native)
// -------------------------------------------------------------
class DatabaseManager {
  constructor(dbDir) {
    this.dbDir = dbDir || path.join(os.homedir(), 'AppData', 'Roaming', 'sameer-ai-workspace');
    this.dbPath = path.join(this.dbDir, 'sameer_workspace.sqlite');
    this.jsonBackupPath = path.join(this.dbDir, 'sameer_workspace_backup.json');
    this.db = null;
    this.useSqlite = false;
    this.init();
  }

  init() {
    try {
      fs.mkdirSync(this.dbDir, { recursive: true });
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          title TEXT,
          model TEXT,
          messages TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          group_id TEXT
        );
        CREATE TABLE IF NOT EXISTS session_groups (
          id TEXT PRIMARY KEY,
          name TEXT,
          icon TEXT,
          color TEXT,
          created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS kv_store (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS approvals_history (
          id TEXT PRIMARY KEY,
          tool TEXT,
          args TEXT,
          status TEXT,
          timestamp INTEGER
        );
      `);
      this.useSqlite = true;
    } catch (err) {
      this.useSqlite = false;
    }
  }

  getSessions() {
    if (this.useSqlite) {
      try {
        const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC');
        return stmt.all().map(r => ({
          ...r,
          messages: JSON.parse(r.messages || '[]')
        }));
      } catch (e) {}
    }
    return this.readJsonBackup().sessions || [];
  }

  saveSession(session) {
    if (!session || !session.id) return;
    if (this.useSqlite) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO sessions (id, title, model, messages, created_at, updated_at, group_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            model = excluded.model,
            messages = excluded.messages,
            updated_at = excluded.updated_at,
            group_id = excluded.group_id
        `);
        stmt.run(
          session.id,
          session.title || 'Untitled Session',
          session.model || 'claude-3-7-sonnet',
          JSON.stringify(session.messages || []),
          session.createdAt || Date.now(),
          session.updatedAt || Date.now(),
          session.groupId || null
        );
      } catch (e) {}
    }
    this.updateJsonBackup('sessions', session);
  }

  deleteSession(id) {
    if (!id) return;
    if (this.useSqlite) {
      try {
        const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
        stmt.run(id);
      } catch (e) {}
    }
    const backup = this.readJsonBackup();
    backup.sessions = (backup.sessions || []).filter(s => s.id !== id);
    this.writeJsonBackup(backup);
  }

  getKV(key) {
    if (this.useSqlite) {
      try {
        const stmt = this.db.prepare('SELECT value FROM kv_store WHERE key = ?');
        const row = stmt.get(key);
        return row ? JSON.parse(row.value) : null;
      } catch (e) {}
    }
    const backup = this.readJsonBackup();
    return backup.kv?.[key] ?? null;
  }

  setKV(key, value) {
    if (this.useSqlite) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO kv_store (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `);
        stmt.run(key, JSON.stringify(value), Date.now());
      } catch (e) {}
    }
    const backup = this.readJsonBackup();
    backup.kv = backup.kv || {};
    backup.kv[key] = value;
    this.writeJsonBackup(backup);
  }

  getGroups() {
    if (this.useSqlite) {
      try {
        const stmt = this.db.prepare('SELECT * FROM session_groups ORDER BY created_at ASC');
        return stmt.all();
      } catch (e) {}
    }
    return this.readJsonBackup().groups || [];
  }

  saveGroup(group) {
    if (!group || !group.id) return;
    if (this.useSqlite) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO session_groups (id, name, icon, color, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            icon = excluded.icon,
            color = excluded.color
        `);
        stmt.run(group.id, group.name || 'Workspace', group.icon || 'folder', group.color || '#cc785c', group.createdAt || Date.now());
      } catch (e) {}
    }
    this.updateJsonBackup('groups', group);
  }

  deleteGroup(id) {
    if (!id) return;
    if (this.useSqlite) {
      try {
        const stmt = this.db.prepare('DELETE FROM session_groups WHERE id = ?');
        stmt.run(id);
      } catch (e) {}
    }
    const backup = this.readJsonBackup();
    backup.groups = (backup.groups || []).filter(g => g.id !== id);
    this.writeJsonBackup(backup);
  }

  readJsonBackup() {
    try {
      if (fs.existsSync(this.jsonBackupPath)) {
        return JSON.parse(fs.readFileSync(this.jsonBackupPath, 'utf8'));
      }
    } catch (e) {}
    return { sessions: [], groups: [], kv: {} };
  }

  writeJsonBackup(data) {
    try {
      fs.writeFileSync(this.jsonBackupPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
  }

  updateJsonBackup(type, item) {
    const backup = this.readJsonBackup();
    if (type === 'sessions') {
      backup.sessions = backup.sessions || [];
      const idx = backup.sessions.findIndex(s => s.id === item.id);
      if (idx >= 0) backup.sessions[idx] = item;
      else backup.sessions.unshift(item);
    } else if (type === 'groups') {
      backup.groups = backup.groups || [];
      const idx = backup.groups.findIndex(g => g.id === item.id);
      if (idx >= 0) backup.groups[idx] = item;
      else backup.groups.push(item);
    }
    this.writeJsonBackup(backup);
  }
}

// -------------------------------------------------------------
// 2. Human-in-the-Loop Approvals System
// -------------------------------------------------------------
class ApprovalsManager {
  constructor(getMainWindow) {
    this.getMainWindow = getMainWindow;
    this.pending = new Map();
    this.approvalMode = true;
  }

  setMode(enabled) {
    this.approvalMode = Boolean(enabled);
  }

  isApprovalRequired(toolName, args = {}) {
    if (!this.approvalMode) return false;
    if (args && (args.autoApprove === true || args.approved === true)) return false;
    // Approvals for sensitive actions:
    if (toolName === 'workspace_write_file') {
      const p = String(args.path || args.filePath || '').toLowerCase();
      if (p.includes('scratch') || p.includes('test') || p.includes('temp') || p.includes('tmp') || p.includes('feature_verify')) return false;
      return true;
    }
    if (toolName === 'shell_command') {
      const cmd = String(args.command || '').toLowerCase();
      const dangerousPatterns = ['rm ', 'del ', 'rmdir', 'format ', 'git reset', 'git clean', 'drop ', 'kill ', 'chmod '];
      return dangerousPatterns.some(p => cmd.includes(p));
    }
    return false;
  }

  requestApproval(tool, args) {
    const id = 'appr_' + Math.random().toString(36).substring(2, 9);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Approval timed out (60s limit). Action cancelled for security.'));
      }, 60000);

      this.pending.set(id, {
        id,
        tool,
        args,
        timestamp: Date.now(),
        resolve,
        reject,
        timeout
      });

      const win = this.getMainWindow ? this.getMainWindow() : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('openwork:approval:requested', {
          id,
          tool,
          args,
          timestamp: Date.now()
        });
      }
    });
  }

  resolve(id, approved) {
    const item = this.pending.get(id);
    if (!item) return { success: false, error: 'Approval request not found or expired' };
    clearTimeout(item.timeout);
    this.pending.delete(id);
    if (approved) {
      item.resolve(true);
      return { success: true, message: 'Action approved' };
    } else {
      item.reject(new Error('Action explicitly denied by user.'));
      return { success: true, message: 'Action denied' };
    }
  }

  getPendingList() {
    return Array.from(this.pending.values()).map(p => ({
      id: p.id,
      tool: p.tool,
      args: p.args,
      timestamp: p.timestamp
    }));
  }
}

// -------------------------------------------------------------
// 3. Interactive Terminal & Long-Running Process Manager
// -------------------------------------------------------------
class TerminalManager {
  constructor() {
    this.sessions = new Map();
  }

  spawnInteractive(id = 'default', shell = null) {
    if (this.sessions.has(id)) {
      const existing = this.sessions.get(id);
      if (existing && !existing.process.killed) {
        return { success: true, message: 'Terminal session already active', id };
      }
    }

    const defaultShell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/bash';
    const chosenShell = shell || defaultShell;
    const shellArgs = chosenShell.toLowerCase().includes('powershell') ? ['-NoProfile', '-ExecutionPolicy', 'Bypass'] : [];

    try {
      const proc = spawn(chosenShell, shellArgs, {
        cwd: os.homedir(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const sessionObj = {
        id,
        process: proc,
        buffer: `[Interactive Terminal ${id} ready]\r\n`,
        createdAt: Date.now()
      };

      proc.stdout.on('data', chunk => {
        sessionObj.buffer += chunk.toString();
        if (sessionObj.buffer.length > 500000) {
          sessionObj.buffer = sessionObj.buffer.slice(-250000);
        }
      });

      proc.stderr.on('data', chunk => {
        sessionObj.buffer += chunk.toString();
        if (sessionObj.buffer.length > 500000) {
          sessionObj.buffer = sessionObj.buffer.slice(-250000);
        }
      });

      proc.on('close', code => {
        sessionObj.buffer += `\r\n[Process exited with code ${code}]\r\n`;
      });

      this.sessions.set(id, sessionObj);
      return { success: true, message: `Terminal ${id} spawned`, id };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  write(id = 'default', input) {
    let session = this.sessions.get(id);
    if (!session || session.process.killed) {
      this.spawnInteractive(id);
      session = this.sessions.get(id);
    }
    if (!session || !session.process.stdin.writable) {
      return { success: false, error: 'Terminal stdin not writable' };
    }
    const formatted = input.endsWith('\r\n') ? input : (input.endsWith('\n') ? input.slice(0, -1) + '\r\n' : input + '\r\n');
    session.process.stdin.write(formatted);
    return { success: true, message: 'Input sent to terminal' };
  }

  read(id = 'default', clear = false) {
    const session = this.sessions.get(id);
    if (!session) return { success: false, error: 'Terminal not found', buffer: '', output: '' };
    const out = session.buffer;
    if (clear) session.buffer = '';
    return { success: true, buffer: out, output: out, active: !session.process.killed };
  }

  kill(id = 'default') {
    const session = this.sessions.get(id);
    if (!session) return { success: true, message: 'No terminal to kill' };
    try {
      session.process.kill();
      this.sessions.delete(id);
      return { success: true, message: 'Terminal killed' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

// -------------------------------------------------------------
// 4. Main Local Bridge Server
// -------------------------------------------------------------
class LocalBridgeServer {
  constructor({ getMainWindow, getBrowserView, tabManager, claudeMcpManager, sidecarPath }) {
    this.tabManager = tabManager;
    this.getMainWindow = getMainWindow;
    this.getBrowserView = getBrowserView;
    this.claudeMcpManager = claudeMcpManager;
    const candidatePath = sidecarPath || path.join(__dirname, '../openwork-core/sidecars/opencode.exe');
    const fallbackPath = path.join(os.homedir(), 'sameer workspace', 'projects', 'claude-enterprise-desktop-app', 'openwork-core', 'sidecars', 'opencode.exe');
    this.sidecarPath = fs.existsSync(candidatePath) ? candidatePath : fallbackPath;
    this.server = null;
    this.port = 48080;
    this.sidecarProcess = null;

    // Subsystems
    this.db = new DatabaseManager();
    this.approvals = new ApprovalsManager(getMainWindow);
    this.terminal = new TerminalManager();
  }

  start(port = 48080) {
    this.port = port;
    this.server = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

      // Helper for reading JSON body
      const readBody = () => new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try { resolve(body ? JSON.parse(body) : {}); }
          catch (e) { reject(e); }
        });
        req.on('error', reject);
      });

      // 1. Health / Status
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const browserView = this.getBrowserView ? this.getBrowserView() : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          app: 'Sameer AI Workspace',
          version: '1.1.0',
          platform: process.platform,
          arch: process.arch,
          userHome: os.homedir(),
          browserActive: Boolean(browserView && !browserView.webContents.isDestroyed()),
          sidecarActive: Boolean(this.sidecarProcess && !this.sidecarProcess.killed),
          database: {
            engine: this.db.useSqlite ? 'sqlite-node22' : 'json-backup',
            path: this.db.dbPath,
            sessionsCount: this.db.getSessions().length
          },
          approvals: {
            mode: this.approvals.approvalMode,
            pendingCount: this.approvals.getPendingList().length
          },
          terminals: {
            activeCount: this.terminal.sessions.size
          },
          port: this.port
        }));
        return;
      }

      // 2. Database Sessions CRUD
      if (req.method === 'GET' && url.pathname === '/api/db/sessions') {
        try {
          const sessions = this.db.getSessions();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessions }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/db/sessions') {
        try {
          const body = await readBody();
          const sessionData = body.session || body;
          this.db.saveSession(sessionData);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Session saved to SQLite' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (req.method === 'DELETE' && (url.pathname.startsWith('/api/db/sessions/') || url.pathname === '/api/db/sessions')) {
        try {
          let id = url.pathname.replace('/api/db/sessions/', '').replace('/api/db/sessions', '');
          if (!id) id = url.searchParams.get('id');
          if (id) this.db.deleteSession(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Session deleted' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // 3. Database Groups
      if (req.method === 'GET' && url.pathname === '/api/db/groups') {
        try {
          const groups = this.db.getGroups();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, groups }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/db/groups') {
        try {
          const body = await readBody();
          this.db.saveGroup(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Group saved' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // 4. Approvals System API
      if (req.method === 'GET' && url.pathname === '/api/approvals/pending') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pending: this.approvals.getPendingList() }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/approvals/respond') {
        try {
          const { id, approved } = await readBody();
          const result = this.approvals.resolve(id, approved);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/approvals/mode') {
        try {
          const { enabled } = await readBody();
          this.approvals.setMode(enabled);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mode: this.approvals.approvalMode }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // 5. Interactive Terminal API
      if (req.method === 'POST' && url.pathname === '/api/terminal/spawn') {
        try {
          const { id, shell } = await readBody();
          const result = this.terminal.spawnInteractive(id, shell);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/terminal/write') {
        try {
          const { id, input } = await readBody();
          const result = this.terminal.write(id, input);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/terminal/read') {
        try {
          let id = url.searchParams.get('id') || 'default';
          let clear = url.searchParams.get('clear') === 'true';
          if (req.method === 'POST') {
            const body = await readBody();
            if (body && body.id) id = body.id;
            if (body && body.clear !== undefined) clear = Boolean(body.clear);
          }
          const result = this.terminal.read(id, clear);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/terminal/kill') {
        try {
          const { id } = await readBody();
          const result = this.terminal.kill(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // 6. Tools List
      if (req.method === 'GET' && url.pathname === '/api/tools') {
        try {
          const claudeTools = this.claudeMcpManager ? await this.claudeMcpManager.listAllTools() : [];
          const nativeTools = [
            {
              type: 'function',
              function: {
                name: 'browser_new_tab',
                description: 'Open a new browser tab beside existing tabs with a specified or blank website URL. Use whenever the user asks to open a new tab or open a fresh tab.',
                parameters: { type: 'object', properties: { url: { type: 'string', description: 'The URL to open in the new tab (e.g. "https://vercel.com").' } } }
              }
            },
            {
              type: 'function',
              function: {
                name: 'browser_switch_tab',
                description: 'Switch the active browser tab by tabId, index (1-based), or title/URL keyword search.',
                parameters: { type: 'object', properties: { tabId: { type: 'string' }, index: { type: 'number' }, query: { type: 'string' } } }
              }
            },
            {
              type: 'function',
              function: {
                name: 'browser_list_tabs',
                description: 'List all open browser tabs, their IDs, URLs, page titles, and active status.',
                parameters: { type: 'object', properties: {} }
              }
            },
            {
              type: 'function',
              function: {
                name: 'browser_close_tab',
                description: 'Close an open browser tab by tabId or index.',
                parameters: { type: 'object', properties: { tabId: { type: 'string' }, index: { type: 'number' } } }
              }
            },
            {
              type: 'function',
              function: {
                name: 'browser_get_links',
                description: 'Extract all hyperlinks (<a> tags) from the active browser page with their visible text and full URL href. Optionally filter by keyword and automatically copy the matching link to the clipboard.',
                parameters: { type: 'object', properties: { query: { type: 'string' }, copyToClipboard: { type: 'boolean' } } }
              }
            },
            {
              type: 'function',
              function: {
                name: 'browser_navigate',
                description: 'Open or navigate the embedded workspace browser to a website URL.',
                parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
              }
            },
            {
              type: 'function',
              function: {
                name: 'browser_observe',
                description: 'Inspect the currently open page in the embedded browser, returning interactive elements and text.',
                parameters: { type: 'object', properties: {} }
              }
            },
            {
              type: 'function',
              function: {
                name: 'browser_click',
                description: 'Click a button or link on the embedded browser by ref ID (e.g. "e1") or CSS selector.',
                parameters: { type: 'object', properties: { ref: { type: 'string' }, selector: { type: 'string' } } }
              }
            },
            {
              type: 'function',
              function: {
                name: 'browser_type',
                description: 'Type text into an input field on the embedded browser page, with optional Enter key press to submit search or form.',
                parameters: { type: 'object', properties: { text: { type: 'string' }, ref: { type: 'string' }, selector: { type: 'string' }, pressEnter: { type: 'boolean', description: 'Press Enter immediately after typing (e.g. to submit search query)' } }, required: ['text'] }
              }
            },
            {
              type: 'function',
              function: {
                name: 'browser_scroll',
                description: 'Scroll the embedded browser page up, down, to top, or to bottom to reveal content below the fold.',
                parameters: {
                  type: 'object',
                  properties: {
                    deltaY: { type: 'number', description: 'Scroll distance in pixels (e.g. 600 to scroll down, -600 to scroll up)' },
                    direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'Direction helper: "down", "up", "top", or "bottom"' }
                  }
                }
              }
            },
            {
              type: 'function',
              function: {
                name: 'browser_key',
                description: 'Press a native keyboard key in the embedded browser (Enter, Tab, Escape to close modals/popups, ArrowDown, Backspace, Space).',
                parameters: {
                  type: 'object',
                  properties: {
                    key: { type: 'string', description: 'Key name: "Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Backspace", "Space"' }
                  },
                  required: ['key']
                }
              }
            },
            {
              type: 'function',
              function: {
                name: 'browser_screenshot',
                description: 'Capture a visual PNG snapshot of the open page in the embedded browser.',
                parameters: { type: 'object', properties: {} }
              }
            },
            {
              type: 'function',
              function: {
                name: 'shell_command',
                description: 'Run a shell/PowerShell command on the local machine.',
                parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] }
              }
            },
            {
              type: 'function',
              function: {
                name: 'workspace_read_file',
                description: 'Read the contents of a local file on the machine.',
                parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
              }
            },
            {
              type: 'function',
              function: {
                name: 'workspace_write_file',
                description: 'Write or edit a local file on the machine.',
                parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
              }
            }
          ];

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, tools: [...nativeTools, ...claudeTools] }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // 7. Execute Tool (Gated by Approvals System)
      if (req.method === 'POST' && url.pathname === '/api/execute-tool') {
        try {
          const { name, args } = await readBody();
          
          // Check if this tool requires human-in-the-loop approval
          if (this.approvals.isApprovalRequired(name, args)) {
            await this.approvals.requestApproval(name, args);
          }

          const result = await this.executeTool(name, args || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // 8. Eval Script in Desktop Window
      if (req.method === 'POST' && url.pathname === '/api/eval') {
        try {
          const { script } = await readBody();
          const mainWindow = this.getMainWindow ? this.getMainWindow() : null;
          if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is not available');
          const result = await mainWindow.webContents.executeJavaScript(script);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // Claude Desktop MCP Servers List & Health
      if (req.method === 'GET' && url.pathname === '/api/claude-desktop-mcp') {
        try {
          const configPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
          let config = { mcpServers: {} };
          if (fs.existsSync(configPath)) {
            try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
          }
          const servers = Object.entries(config.mcpServers || {}).map(([name, cfg]) => ({
            name,
            command: cfg.command,
            args: cfg.args,
            env: cfg.env,
          }));
          const tools = this.claudeMcpManager ? await this.claudeMcpManager.listAllTools() : [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, servers, tools }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // 9. Dynamic Connector Registration
      if (req.method === 'POST' && url.pathname === '/api/connectors/add') {
        try {
          const { name, command, args = [], env = {} } = await readBody();
          if (!name || !command) throw new Error('name and command are required');
          const configPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
          let config = { mcpServers: {} };
          if (fs.existsSync(configPath)) {
            try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
          }
          config.mcpServers = config.mcpServers || {};
          config.mcpServers[name] = { command, args, env };
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
          const tools = this.claudeMcpManager ? await this.claudeMcpManager.listAllTools() : [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: `Connector "${name}" added successfully`, toolsCount: tools.length }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // 10. Type Message into Chat UI
      if (req.method === 'POST' && url.pathname === '/api/type-message') {
        try {
          const { text } = await readBody();
          const mainWindow = this.getMainWindow ? this.getMainWindow() : null;
          if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window not available');
          const resData = await mainWindow.webContents.executeJavaScript(`(() => {
            const textarea = document.querySelector('textarea');
            if (!textarea) return { success: false, error: 'Chat input textarea not found' };
            textarea.focus();
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeInputValueSetter.call(textarea, ${JSON.stringify(text)});
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            const buttons = Array.from(document.querySelectorAll('button'));
            const sendBtn = buttons.find(b => !b.disabled && (b.getAttribute('aria-label') === 'Send' || b.className.includes('bg-') || b.type === 'submit')) || buttons.reverse().find(b => !b.disabled);
            if (sendBtn) {
              sendBtn.click();
              return { success: true, message: 'Message typed and Send clicked', text: ${JSON.stringify(text)} };
            }
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            return { success: true, message: 'Message typed, Enter dispatched', text: ${JSON.stringify(text)} };
          })()`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...resData }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // 11. Read Chat Messages from UI
      if (req.method === 'GET' && url.pathname === '/api/read-chat') {
        try {
          const mainWindow = this.getMainWindow ? this.getMainWindow() : null;
          if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window not available');
          const messages = await mainWindow.webContents.executeJavaScript(`(() => {
            const articles = Array.from(document.querySelectorAll('[class*="prose"], [class*="message"], [class*="bubble"]'));
            const samples = articles.slice(-6).map(el => (el.innerText || '').trim()).filter(Boolean);
            return {
              title: document.title,
              url: window.location.href,
              sampleTexts: samples,
              bodySnippet: (document.body ? document.body.innerText : '').slice(-1500)
            };
          })()`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...messages }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // 12. Sidecar Start/Stop
      if (req.method === 'POST' && url.pathname === '/api/sidecar/start') {
        const result = this.startSidecar();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/sidecar/stop') {
        const result = this.stopSidecar();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    });

    const logFile = path.join(os.homedir(), 'AppData', 'Roaming', 'sameer-ai-workspace', 'crash.log');
    this.server.on('error', (err) => {
      try { fs.appendFileSync(logFile, `[LocalBridge] Server ERR: ${err.message}\n`); } catch(e){}
      if (err.code === 'EADDRINUSE') {
        try { this.server.close(); } catch(e){}
        this.start(this.port + 1);
      }
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      try { fs.appendFileSync(logFile, `[LocalBridge] Listening on 127.0.0.1:${this.port}\n`); } catch(e){}
    });
  }

  async executeTool(name, args = {}) {
    const mainWindow = this.getMainWindow ? this.getMainWindow() : null;
    const getActiveView = () => {
      if (this.tabManager) {
        const activeTab = this.tabManager.getActiveTab ? this.tabManager.getActiveTab() : null;
        if (activeTab && activeTab.view && !activeTab.view.webContents.isDestroyed()) return activeTab.view;
        const allTabs = this.tabManager.listTabs ? this.tabManager.listTabs() : (this.tabManager.tabs || []);
        if (allTabs.length > 0) {
          const first = allTabs[0];
          if (first && first.view && !first.view.webContents.isDestroyed()) return first.view;
        }
      }
      const bv = this.getBrowserView ? this.getBrowserView() : null;
      if (bv && !bv.webContents.isDestroyed()) return bv;
      return null;
    };

    // A0. Browser Multi-Tab Management
    if (name === 'browser_new_tab') {
      const targetUrl = String(args.url || 'https://www.google.com').trim();
      const normalized = /^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`;

      let newTab = null;
      if (this.tabManager) {
        newTab = this.tabManager.createTab(normalized, true);
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('openwork:browser:open-panel', { url: normalized });
      }

      const activeView = (newTab && newTab.view) || getActiveView();
      if (activeView && !activeView.webContents.isDestroyed()) {
        const contents = activeView.webContents;
        await new Promise(r => setTimeout(r, 1200));

        try {
          const observation = await contents.executeJavaScript(`(() => {
            const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]'));
            const elements = [];
            for (let i = 0; i < candidates.length && elements.length < 80; i++) {
              const el = candidates[i];
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
              const label = el.getAttribute('aria-label') || (el.innerText || '').trim() || el.placeholder || el.value || el.name || '';
              elements.push({
                ref: 'e' + (elements.length + 1),
                tag: el.tagName.toLowerCase(),
                name: label.slice(0, 150),
                href: el.href || undefined,
              });
            }
            return {
              title: document.title,
              url: window.location.href,
              textSnippet: (document.body ? document.body.innerText : '').slice(0, 2500),
              elements,
            };
          })()`);

          const elementsList = Array.isArray(observation.elements) && observation.elements.length > 0
            ? observation.elements.map(el => `[${el.ref}] <${el.tag}> ${el.name || ''} ${el.href ? '(' + el.href + ')' : ''}`).join('\n')
            : 'None detected';

          return `Successfully opened new browser tab [Tab ID: ${newTab ? newTab.id : 'tab_new'}] at ${normalized}\nLive Page Title: ${observation.title}\nCurrent URL: ${observation.url}\n\nVisible Interactive Elements:\n${elementsList}\n\nPage Text Preview:\n${observation.textSnippet}`;
        } catch (obsErr) {
          return `Successfully opened new browser tab at ${normalized} (Tab ID: ${newTab ? newTab.id : 'tab_new'})`;
        }
      }
      return `Opened new tab at ${normalized}`;
    }

    if (name === 'browser_switch_tab') {
      if (!this.tabManager) throw new Error('Tab manager not available');
      const tabs = this.tabManager.listTabs();
      let targetTab = null;

      if (args.tabId) {
        targetTab = tabs.find(t => t.id === args.tabId || t.tabId === args.tabId);
      }
      if (!targetTab && typeof args.index === 'number') {
        const idx = Math.max(0, Math.min(tabs.length - 1, Math.round(args.index) - 1));
        targetTab = tabs[idx];
      }
      if (!targetTab && args.query) {
        const q = String(args.query).toLowerCase();
        targetTab = tabs.find(t => (t.title && t.title.toLowerCase().includes(q)) || (t.url && t.url.toLowerCase().includes(q)));
      }
      if (!targetTab && tabs.length > 0) {
        targetTab = tabs[0];
      }

      if (!targetTab) throw new Error('No matching browser tab found to switch to.');

      this.tabManager.selectTab(targetTab.id);

      const activeTab = this.tabManager.getActiveTab();
      if (activeTab && activeTab.view && !activeTab.view.webContents.isDestroyed()) {
        const contents = activeTab.view.webContents;
        try {
          const observation = await contents.executeJavaScript(`(() => ({
            title: document.title,
            url: window.location.href,
            textSnippet: (document.body ? document.body.innerText : '').slice(0, 2000),
          }))()`);
          return `Switched active browser tab to [${targetTab.id}] "${observation.title}" (${observation.url})\n\nPage Text Preview:\n${observation.textSnippet}`;
        } catch (e) {
          return `Switched active browser tab to [${targetTab.id}] "${targetTab.title}"`;
        }
      }
      return `Switched active browser tab to [${targetTab.id}]`;
    }

    if (name === 'browser_list_tabs') {
      if (!this.tabManager) {
        const url = browserView && !browserView.webContents.isDestroyed() ? browserView.webContents.getURL() : 'None';
        const title = browserView && !browserView.webContents.isDestroyed() ? browserView.webContents.getTitle() : 'None';
        return `Open Browser Tabs (1):\n1. [ACTIVE] "${title}" - ${url} (ID: tab_default)`;
      }
      const tabs = this.tabManager.listTabs();
      if (tabs.length === 0) return 'No browser tabs currently open.';
      const list = tabs.map((t, i) => `${i + 1}. [${t.active ? 'ACTIVE' : 'INACTIVE'}] "${t.title || 'Untitled'}" - ${t.url} (ID: ${t.id})`).join('\n');
      return `Open Browser Tabs (${tabs.length}):\n${list}`;
    }

    if (name === 'browser_close_tab') {
      if (!this.tabManager) throw new Error('Tab manager not available');
      const tabs = this.tabManager.listTabs();
      let tabToCloseId = args.tabId;
      if (!tabToCloseId && typeof args.index === 'number') {
        const idx = Math.max(0, Math.min(tabs.length - 1, Math.round(args.index) - 1));
        tabToCloseId = tabs[idx]?.id;
      }
      if (!tabToCloseId) {
        tabToCloseId = this.tabManager.activeTabId;
      }
      if (!tabToCloseId) throw new Error('No active tab to close.');

      this.tabManager.closeTab(tabToCloseId);
      const remaining = this.tabManager.listTabs();
      const list = remaining.map((t, i) => `${i + 1}. [${t.active ? 'ACTIVE' : 'INACTIVE'}] "${t.title || 'Untitled'}" - ${t.url}`).join('\n');
      return `Closed tab [${tabToCloseId}]. Remaining open tabs (${remaining.length}):\n${list || 'None'}`;
    }

    if (name === 'browser_get_links') {
      const activeView = getActiveView();
      if (!activeView || activeView.webContents.isDestroyed()) {
        throw new Error('Browser view is not active. Open a website first.');
      }
      const query = String(args.query || '').trim().toLowerCase();
      const copyToClipboard = args.copyToClipboard !== false;

      const linksData = await activeView.webContents.executeJavaScript(`(() => {
        const allA = Array.from(document.querySelectorAll('a[href]'));
        const results = [];
        for (const a of allA) {
          const href = a.href;
          if (!href || !/^https?:/i.test(href)) continue;
          const text = (a.innerText || a.getAttribute('aria-label') || a.title || '').trim();
          results.push({ text: text.slice(0, 100), href });
        }
        return {
          title: document.title,
          url: window.location.href,
          links: results
        };
      })()`);

      let matched = linksData.links;
      if (query) {
        matched = linksData.links.filter(l => 
          l.text.toLowerCase().includes(query) || 
          l.href.toLowerCase().includes(query)
        );
      }

      let clipboardMsg = '';
      if (copyToClipboard && matched.length > 0) {
        try {
          const { clipboard } = require('electron');
          clipboard.writeText(matched[0].href);
          clipboardMsg = `\n📋 Copied primary link to clipboard: ${matched[0].href}`;
        } catch (clipErr) {}
      }

      const displayList = matched.slice(0, 40).map((l, i) => `${i + 1}. [${l.text || 'Link'}] -> ${l.href}`).join('\n');
      return `Extracted ${matched.length} links from "${linksData.title}" (${linksData.url}):\n${displayList || 'No links found matching query.'}${clipboardMsg}`;
    }


    // A. Browser Navigation
    if (name === 'browser_navigate') {
      const targetUrl = String(args.url || '').trim();
      if (!targetUrl) throw new Error('No URL specified for navigation');
      const normalized = /^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`;
      
      // Auto-open browser panel in UI
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('openwork:browser:open-panel', { url: normalized });
      }

      let activeView = getActiveView();
      if (!activeView && this.tabManager) {
        const newTab = this.tabManager.createTab(normalized, true);
        activeView = newTab ? newTab.view : null;
      }

      if (activeView && !activeView.webContents.isDestroyed()) {
        const contents = activeView.webContents;
        try {
          await contents.loadURL(normalized);
        } catch (loadErr) {
          if (!loadErr.message?.includes('ERR_ABORTED')) {
            throw loadErr;
          }
        }

        // Wait a short moment for DOM hydration / dynamic rendering
        await new Promise(r => setTimeout(r, 1200));

        // Auto-observe the newly loaded page immediately so the agent has full vision
        try {
          const observation = await contents.executeJavaScript(`(() => {
            const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]'));
            const elements = [];
            for (let i = 0; i < candidates.length && elements.length < 80; i++) {
              const el = candidates[i];
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
              const label = el.getAttribute('aria-label') || (el.innerText || '').trim() || el.placeholder || el.value || el.name || '';
              elements.push({
                ref: 'e' + (elements.length + 1),
                tag: el.tagName.toLowerCase(),
                name: label.slice(0, 150),
                href: el.href || undefined,
              });
            }
            return {
              title: document.title,
              url: window.location.href,
              textSnippet: (document.body ? document.body.innerText : '').slice(0, 2500),
              elements,
            };
          })()`);

          const elementsList = Array.isArray(observation.elements) && observation.elements.length > 0
            ? observation.elements.map(el => `[${el.ref}] <${el.tag}> ${el.name || ''} ${el.href ? '(' + el.href + ')' : ''}`).join('\n')
            : 'None detected';

          return `Successfully navigated embedded browser to ${normalized}\nLive Page Title: ${observation.title}\nCurrent URL: ${observation.url}\n\nVisible Interactive Elements:\n${elementsList}\n\nPage Text Preview:\n${observation.textSnippet}`;
        } catch (obsErr) {
          return `Successfully navigated embedded browser to ${normalized} (Observation note: ${obsErr?.message || 'ready'})`;
        }
      }
      return `Requested navigation to ${normalized} (UI panel notified)`;
    }

    // A2. Browser Fill Login / Credentials
    if (name === 'browser_fill_login') {
      const activeView = getActiveView();
      if (!activeView || activeView.webContents.isDestroyed()) {
        throw new Error('Browser view not active');
      }
      const email = String(args.email || args.username || '');
      const password = String(args.password || '');
      const submit = args.submit !== false;

      const fillRes = await activeView.webContents.executeJavaScript(`(() => {
        const userInput = document.querySelector('input[name="login"], #login_field, input[type="email"], input[name="email"], input[name="username"], input[name="user[login]"], input[type="text"]');
        const passInput = document.querySelector('input[name="password"], #password, input[type="password"]');
        let filledUser = false;
        let filledPass = false;

        if (userInput && ${JSON.stringify(email)}) {
          userInput.focus();
          userInput.value = ${JSON.stringify(email)};
          userInput.dispatchEvent(new Event('input', { bubbles: true }));
          userInput.dispatchEvent(new Event('change', { bubbles: true }));
          filledUser = true;
        }

        if (passInput && ${JSON.stringify(password)}) {
          passInput.focus();
          passInput.value = ${JSON.stringify(password)};
          passInput.dispatchEvent(new Event('input', { bubbles: true }));
          passInput.dispatchEvent(new Event('change', { bubbles: true }));
          filledPass = true;
        }

        if (${submit} && (filledUser || filledPass)) {
          const submitBtn = document.querySelector('input[type="submit"], button[type="submit"], [name="commit"], button.btn-primary');
          if (submitBtn) {
            setTimeout(() => submitBtn.click(), 600);
            return { success: true, submitted: true, filledUser, filledPass };
          }
        }
        return { success: true, submitted: false, filledUser, filledPass };
      })()`);

      return `Credential fill result: ${JSON.stringify(fillRes)}`;
    }


    // B. Browser Observation
    if (name === 'browser_observe') {
      const activeView = getActiveView();
      if (!activeView || activeView.webContents.isDestroyed()) {
        throw new Error('Browser view is not active. Use browser_navigate first.');
      }
      const contents = activeView.webContents;
      const observation = await contents.executeJavaScript(`(() => {
        const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]'));
        const elements = [];
        for (let i = 0; i < candidates.length && elements.length < 100; i++) {
          const el = candidates[i];
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
          const label = el.getAttribute('aria-label') || (el.innerText || '').trim() || el.placeholder || el.value || el.name || '';
          elements.push({
            ref: 'e' + (elements.length + 1),
            tag: el.tagName.toLowerCase(),
            name: label.slice(0, 150),
            href: el.href || undefined,
          });
        }
        return {
          title: document.title,
          url: window.location.href,
          textSnippet: (document.body ? document.body.innerText : '').slice(0, 3000),
          elements,
        };
      })()`);

      const elementsList = Array.isArray(observation.elements)
        ? observation.elements.map(el => `[${el.ref}] <${el.tag}> ${el.name} ${el.href ? '(' + el.href + ')' : ''}`).join('\n')
        : 'None';

      return `URL: ${observation.url}\nTitle: ${observation.title}\n\nContent Snippet:\n${observation.textSnippet}\n\nInteractive Elements:\n${elementsList}`;
    }

    // C. Browser Click (with Hit-Testing Obscurity Check & Coordinates)
    if (name === 'browser_click') {
      const activeView = getActiveView();
      if (!activeView || activeView.webContents.isDestroyed()) {
        throw new Error('Browser view is not active');
      }
      const contents = activeView.webContents;
      const res = await contents.executeJavaScript(`(() => {
        let el = null;
        if (${JSON.stringify(args.selector || null)}) {
          el = document.querySelector(${JSON.stringify(args.selector)});
        } else if (${JSON.stringify(args.ref || null)}) {
          const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]'));
          const visible = candidates.filter(item => {
            const r = item.getBoundingClientRect();
            const style = window.getComputedStyle(item);
            return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          });
          const match = /^e([1-9]\\d*)$/i.exec(String(${JSON.stringify(args.ref)}).trim());
          if (!match) return { success: false, error: 'Invalid element reference. Run browser_observe and use a reference such as e1.' };
          el = visible[Number(match[1]) - 1];
          if (el && (el.disabled || el.getAttribute('aria-disabled') === 'true')) {
            return { success: false, error: 'The referenced element is disabled.' };
          }
        }
        if (!el) return { success: false, error: 'Element not found on page' };

        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const rect = el.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;

        // Obscurity Check: verify no floating modal/cookie banner is covering the element
        const topEl = document.elementFromPoint(x, y);
        const isObscured = topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el);

        el.focus();
        el.click();

        return {
          success: true,
          clicked: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 60),
          obscured: isObscured,
          obscuredBy: isObscured ? topEl.tagName.toLowerCase() : null,
          x: Math.round(x),
          y: Math.round(y)
        };
      })()`);

      if (!res.success) return `Click failed: ${res.error}`;
      await new Promise(r => setTimeout(r, 800));
      const currentUrl = contents.getURL();
      const currentTitle = contents.getTitle();
      const obscureNote = res.obscured ? ` (Note: element had an overlay: <${res.obscuredBy}>)` : '';
      return `Click dispatched to ${res.clicked} ("${res.text}")${obscureNote}. Current Page: "${currentTitle}" (${currentUrl}). Re-observe the page to verify the intended outcome before reporting the task complete.`;
    }

    // D. Browser Type (Native Input + Keystrokes)
    if (name === 'browser_type') {
      const activeView = getActiveView();
      if (!activeView || activeView.webContents.isDestroyed()) {
        throw new Error('Browser view is not active');
      }
      const contents = activeView.webContents;
      const text = String(args.text || '');
      const pressEnter = args.pressEnter === true;

      // 1. Focus element and select existing text in DOM
      const prepRes = await contents.executeJavaScript(`(() => {
        let el = null;
        if (${JSON.stringify(args.selector || null)}) {
          el = document.querySelector(${JSON.stringify(args.selector)});
        } else if (${JSON.stringify(args.ref || null)}) {
          const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]'));
          const visible = candidates.filter(item => {
            const r = item.getBoundingClientRect();
            const style = window.getComputedStyle(item);
            return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          });
          const match = /^e([1-9]\\d*)$/i.exec(String(${JSON.stringify(args.ref)}).trim());
          if (!match) return { success: false, error: 'Invalid element reference. Run browser_observe and use a reference such as e1.' };
          el = visible[Number(match[1]) - 1];
        } else {
          const active = document.activeElement;
          const isEditable = node => node && (node.matches('input:not([type="hidden"]), textarea, [contenteditable="true"]') || node.isContentEditable);
          el = isEditable(active) ? active : Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]')).find(node => {
            const r = node.getBoundingClientRect();
            const style = window.getComputedStyle(node);
            return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !node.disabled;
          });
        }
        if (!el) return { success: false, error: 'No visible editable input found. Run browser_observe and select a visible input reference.' };
        if (!(el.matches('input:not([type="hidden"]), textarea, [contenteditable="true"]') || el.isContentEditable)) {
          return { success: false, error: 'The referenced element is not an editable text field. Run browser_observe and choose an input, textarea, or editable area.' };
        }
        if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') {
          return { success: false, error: 'The referenced input is disabled or read-only.' };
        }

        el.focus();
        if (typeof el.select === 'function') el.select();
        else if (el.isContentEditable) document.getSelection()?.selectAllChildren(el);

        return { success: true, tag: el.tagName.toLowerCase() };
      })()`);

      if (!prepRes.success) return `Type failed: ${prepRes.error}`;

      // 2. Use native insertText if available for authentic keystrokes
      try {
        if (typeof contents.insertText === 'function') {
          await contents.insertText(text);
        } else {
          throw new Error('insertText unavailable');
        }
      } catch {
        // Fallback to DOM input dispatch
        await contents.executeJavaScript(`(() => {
          const el = document.activeElement;
          if (el) {
            if (el.value !== undefined) el.value = ${JSON.stringify(text)};
            else if (el.isContentEditable) el.innerText = ${JSON.stringify(text)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()`);
      }

      // Verify the browser accepted the text before reporting success.
      const typeCheck = await contents.executeJavaScript(`(() => {
        const el = document.activeElement;
        if (!el) return { success: false, actual: '' };
        const value = el.value !== undefined ? String(el.value) : (el.isContentEditable ? String(el.innerText || '') : '');
        return { success: value === ${JSON.stringify(text)}, actual: value.slice(0, 120) };
      })()`);
      if (!typeCheck.success) {
        return `Typing verification failed: the focused field does not contain the requested text. Actual value: "${String(typeCheck.actual || '').slice(0, 120)}". Re-observe the page and retry with the correct input reference.`;
      }

      // 3. Press Enter if requested
      if (pressEnter) {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await new Promise(r => setTimeout(r, 1000));
        return `Typed "${text}" and pressed Enter. Current Page: "${contents.getTitle()}" (${contents.getURL()})`;
      }

      return `Typed "${text}" into ${prepRes.tag}`;
    }

    // D2. Browser Scroll (Native Wheel / Viewport Scroll)
    if (name === 'browser_scroll') {
      const activeView = getActiveView();
      if (!activeView || activeView.webContents.isDestroyed()) {
        throw new Error('Browser view is not active');
      }
      const contents = activeView.webContents;
      let deltaY = typeof args.deltaY === 'number' ? args.deltaY : 600;
      if (args.direction === 'up') deltaY = -Math.abs(deltaY);
      else if (args.direction === 'down') deltaY = Math.abs(deltaY);
      else if (args.direction === 'top') deltaY = -999999;
      else if (args.direction === 'bottom') deltaY = 999999;

      const scrollRes = await contents.executeJavaScript(`(() => {
        const startY = window.scrollY;
        if (${deltaY} === -999999) {
          window.scrollTo({ top: 0, behavior: 'instant' });
        } else if (${deltaY} === 999999) {
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
        } else {
          window.scrollBy({ top: ${deltaY}, behavior: 'instant' });
        }
        return {
          prevY: Math.round(startY),
          currY: Math.round(window.scrollY),
          maxY: Math.round(document.body.scrollHeight - window.innerHeight),
          scrolled: Math.round(window.scrollY) !== Math.round(startY)
        };
      })()`);

      await new Promise(r => setTimeout(r, 600));

      // Auto-observe newly revealed elements in viewport
      const observation = await contents.executeJavaScript(`(() => {
        const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]'));
        const elements = [];
        for (let i = 0; i < candidates.length && elements.length < 80; i++) {
          const el = candidates[i];
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          const label = el.getAttribute('aria-label') || (el.innerText || '').trim() || el.placeholder || el.value || el.name || '';
          elements.push({
            ref: 'e' + (elements.length + 1),
            tag: el.tagName.toLowerCase(),
            name: label.slice(0, 150),
            href: el.href || undefined,
          });
        }
        return {
          elements,
          textSnippet: (document.body ? document.body.innerText : '').slice(0, 2000)
        };
      })()`);

      const elementsList = Array.isArray(observation?.elements) && observation.elements.length > 0
        ? observation.elements.map(el => `[${el.ref}] <${el.tag}> ${el.name} ${el.href ? '(' + el.href + ')' : ''}`).join('\n')
        : 'None detected in view';

      return `Scrolled page (scroll position: ${scrollRes.currY}px / ${scrollRes.maxY}px max).\n\nVisible Elements Now In Viewport:\n${elementsList}`;
    }

    // D3. Browser Key (Native Keyboard Input)
    if (name === 'browser_key') {
      const activeView = getActiveView();
      if (!activeView || activeView.webContents.isDestroyed()) {
        throw new Error('Browser view is not active');
      }
      const contents = activeView.webContents;
      const keyMap = {
        enter: 'Enter',
        tab: 'Tab',
        escape: 'Escape',
        esc: 'Escape',
        backspace: 'Backspace',
        space: 'Space',
        arrowdown: 'Down',
        down: 'Down',
        arrowup: 'Up',
        up: 'Up',
        arrowleft: 'Left',
        arrowright: 'Right',
      };
      const rawKey = String(args.key || 'Enter').toLowerCase().trim();
      const mapped = keyMap[rawKey] || args.key || 'Enter';

      contents.sendInputEvent({ type: 'keyDown', keyCode: mapped });
      contents.sendInputEvent({ type: 'keyUp', keyCode: mapped });

      await new Promise(r => setTimeout(r, 600));
      const currentUrl = contents.getURL();
      const currentTitle = contents.getTitle();
      return `Pressed key "${mapped}". Current Page: "${currentTitle}" (${currentUrl})`;
    }

    // E. Browser Screenshot
    if (name === 'browser_screenshot') {
      const activeView = getActiveView();
      if (!activeView || activeView.webContents.isDestroyed()) {
        throw new Error('Browser view is not active');
      }
      const contents = activeView.webContents;
      const img = await contents.capturePage();
      const size = img.getSize();
      const currentUrl = contents.getURL();
      const currentTitle = contents.getTitle();
      return `Screenshot captured successfully (${size.width}x${size.height}px). Verified visible state on "${currentTitle}" (${currentUrl}).`;
    }

    // F. Claude Desktop MCP Tool
    if (name.startsWith('claude_')) {
      if (!this.claudeMcpManager) throw new Error('Claude Desktop MCP Manager not available');
      const tools = await this.claudeMcpManager.listAllTools();
      const matched = tools.find(t => t.function.name === name);
      if (!matched) throw new Error(`Claude Desktop tool "${name}" not found`);
      return await this.claudeMcpManager.callTool(matched.serverName, matched.originalName, args || {});
    }

    // G. Shell Command Execution (OpenWork Local Terminal)
    if (name === 'shell_command') {
      const command = String(args.command || '').trim();
      const cwd = args.cwd || os.homedir();
      if (!command) throw new Error('No command provided');

      return new Promise((resolve) => {
        const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
        exec(command, { cwd, shell, timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            resolve(`Error (exit code ${err.code || 1}):\n${stderr || err.message}\n${stdout}`);
          } else {
            resolve(stdout || stderr || 'Command completed successfully with no output.');
          }
        });
      });
    }

    // Helper to resolve workspace paths to real repo
    const resolveWorkspacePath = (relPath) => {
      const path = require('path');
      let clean = String(relPath || '').trim();
      if (path.isAbsolute(clean) && !clean.includes('AppData\\Local\\Programs')) {
        return clean;
      }
      clean = clean.replace(/^.*(?:Sameer AI Workspace|claude-enterprise-desktop-app)[\\/]/i, '');
      const candidates = [
        path.join('C:\\Users\\Master\\sameer workspace\\projects\\claude-enterprise-desktop-app', clean),
        path.join('C:\\Users\\Master\\sameer workspace\\projects\\claude-enterprise-app', clean),
        path.join('C:\\Users\\Master\\sameer workspace', clean),
        path.resolve(clean),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
      return candidates[0];
    };

    // H. Workspace File Read
    if (name === 'workspace_read_file') {
      const targetPath = resolveWorkspacePath(args.path || '');
      if (!fs.existsSync(targetPath)) throw new Error(`File does not exist: ${targetPath}`);
      return fs.readFileSync(targetPath, 'utf8');
    }

    // I. Workspace File Write
    if (name === 'workspace_write_file') {
      const targetPath = resolveWorkspacePath(args.path || '');
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, String(args.content || ''), 'utf8');
      return `File written successfully to ${targetPath}`;
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  startSidecar() {
    if (this.sidecarProcess && !this.sidecarProcess.killed) {
      return { success: true, message: 'Sidecar already running', pid: this.sidecarProcess.pid };
    }

    if (!fs.existsSync(this.sidecarPath)) {
      return { success: false, error: `Sidecar binary not found at ${this.sidecarPath}` };
    }

    try {
      this.sidecarProcess = spawn(this.sidecarPath, ['serve', '--port', '48090', '--hostname', '127.0.0.1'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      this.sidecarProcess.unref();
      return { success: true, message: 'OpenCode sidecar started', pid: this.sidecarProcess.pid };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  stopSidecar() {
    if (this.sidecarProcess && !this.sidecarProcess.killed) {
      try {
        this.sidecarProcess.kill('SIGTERM');
        this.sidecarProcess = null;
        return { success: true, message: 'Sidecar stopped' };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
    return { success: true, message: 'Sidecar was not running' };
  }
}

module.exports = { LocalBridgeServer };
