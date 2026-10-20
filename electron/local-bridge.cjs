const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');

class LocalBridgeServer {
  constructor({ getMainWindow, getBrowserView, claudeMcpManager, sidecarPath }) {
    this.getMainWindow = getMainWindow;
    this.getBrowserView = getBrowserView;
    this.claudeMcpManager = claudeMcpManager;
    const candidatePath = sidecarPath || path.join(__dirname, '../openwork-core/sidecars/opencode.exe');
    const fallbackPath = path.join(os.homedir(), 'sameer workspace', 'projects', 'claude-enterprise-desktop-app', 'openwork-core', 'sidecars', 'opencode.exe');
    this.sidecarPath = fs.existsSync(candidatePath) ? candidatePath : fallbackPath;
    this.server = null;
    this.port = 48080;
    this.sidecarProcess = null;
  }

  start(port = 48080) {
    this.port = port;
    this.server = http.createServer(async (req, res) => {
      // Set CORS headers for Vercel app and localhost
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

      // 1. Health / Status
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const browserView = this.getBrowserView ? this.getBrowserView() : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          app: 'Sameer AI Workspace',
          version: '1.0.0',
          platform: process.platform,
          arch: process.arch,
          userHome: os.homedir(),
          browserActive: Boolean(browserView && !browserView.webContents.isDestroyed()),
          sidecarActive: Boolean(this.sidecarProcess && !this.sidecarProcess.killed),
          port: this.port
        }));
        return;
      }

      // 2. Get All Local Tools
      if (req.method === 'GET' && url.pathname === '/api/tools') {
        try {
          const claudeTools = this.claudeMcpManager ? await this.claudeMcpManager.listAllTools() : [];
          const nativeTools = [
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
                description: 'Type text into an input field on the embedded browser page.',
                parameters: { type: 'object', properties: { text: { type: 'string' }, ref: { type: 'string' } }, required: ['text'] }
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

      // 3. Execute Tool
      if (req.method === 'POST' && url.pathname === '/api/execute-tool') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const { name, args } = JSON.parse(body || '{}');
            const result = await this.executeTool(name, args || {});
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, result }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // 4. Eval Script in Desktop Window
      if (req.method === 'POST' && url.pathname === '/api/eval') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const { script } = JSON.parse(body || '{}');
            const mainWindow = this.getMainWindow ? this.getMainWindow() : null;
            if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is not available');
            const result = await mainWindow.webContents.executeJavaScript(script);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, result }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // 5. Dynamic Connector Registration (Connect ANY MCP Server on the fly)
      if (req.method === 'POST' && url.pathname === '/api/connectors/add') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const { name, command, args = [], env = {} } = JSON.parse(body || '{}');
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
        });
        return;
      }

      // 6. Type Message into Chat UI
      if (req.method === 'POST' && url.pathname === '/api/type-message') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const { text } = JSON.parse(body || '{}');
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
        });
        return;
      }

      // 7. Read Chat Messages from UI
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

      // 8. Sidecar Start/Stop
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
    const browserView = this.getBrowserView ? this.getBrowserView() : null;

    // A. Browser Navigation
    if (name === 'browser_navigate') {
      const targetUrl = String(args.url || '').trim();
      if (!targetUrl) throw new Error('No URL specified for navigation');
      const normalized = /^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`;
      
      // Auto-open browser panel in UI
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('openwork:browser:open-panel', { url: normalized });
      }

      if (browserView && !browserView.webContents.isDestroyed()) {
        browserView.webContents.loadURL(normalized);
        return `Successfully navigated embedded browser to ${normalized}`;
      }
      return `Requested navigation to ${normalized} (UI panel notified)`;
    }

    // B. Browser Observation
    if (name === 'browser_observe') {
      if (!browserView || browserView.webContents.isDestroyed()) {
        throw new Error('Browser view is not active. Use browser_navigate first.');
      }
      const contents = browserView.webContents;
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

    // C. Browser Click
    if (name === 'browser_click') {
      if (!browserView || browserView.webContents.isDestroyed()) {
        throw new Error('Browser view is not active');
      }
      const res = await browserView.webContents.executeJavaScript(`(() => {
        let el = null;
        if (${JSON.stringify(args.selector || null)}) {
          el = document.querySelector(${JSON.stringify(args.selector)});
        } else if (${JSON.stringify(args.ref || null)}) {
          const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"]'));
          const visible = candidates.filter(item => {
            const r = item.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          const idx = parseInt(String(${JSON.stringify(args.ref)}).replace(/^e/i, '')) - 1;
          el = visible[idx];
        }
        if (el) {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          el.focus();
          el.click();
          return { success: true, clicked: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 60) };
        }
        return { success: false, error: 'Element not found' };
      })()`);
      return res.success ? `Clicked ${res.clicked} ("${res.text}")` : `Click failed: ${res.error}`;
    }

    // D. Browser Type
    if (name === 'browser_type') {
      if (!browserView || browserView.webContents.isDestroyed()) {
        throw new Error('Browser view is not active');
      }
      const text = String(args.text || '');
      const res = await browserView.webContents.executeJavaScript(`(() => {
        let el = null;
        if (${JSON.stringify(args.selector || null)}) {
          el = document.querySelector(${JSON.stringify(args.selector)});
        } else if (${JSON.stringify(args.ref || null)}) {
          const candidates = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'));
          const idx = parseInt(String(${JSON.stringify(args.ref)}).replace(/^e/i, '')) - 1;
          el = candidates[idx] || document.querySelector('input, textarea');
        } else {
          el = document.activeElement || document.querySelector('input, textarea');
        }
        if (el) {
          el.focus();
          if (el.value !== undefined) el.value = ${JSON.stringify(text)};
          else if (el.isContentEditable) el.innerText = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, typed: ${JSON.stringify(text)} };
        }
        return { success: false, error: 'No input found' };
      })()`);
      return res.success ? `Typed "${text}" into input` : `Type failed: ${res.error}`;
    }

    // E. Browser Screenshot
    if (name === 'browser_screenshot') {
      if (!browserView || browserView.webContents.isDestroyed()) {
        throw new Error('Browser view is not active');
      }
      const img = await browserView.webContents.capturePage();
      return img.toDataURL();
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

    // H. Workspace File Read
    if (name === 'workspace_read_file') {
      const targetPath = path.resolve(args.path || '');
      if (!fs.existsSync(targetPath)) throw new Error(`File does not exist: ${targetPath}`);
      return fs.readFileSync(targetPath, 'utf8');
    }

    // I. Workspace File Write
    if (name === 'workspace_write_file') {
      const targetPath = path.resolve(args.path || '');
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
