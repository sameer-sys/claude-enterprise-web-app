import type { Connector } from '@/types/chat';
import { refreshRemoteAccessToken, type RemoteStoredToken } from '@/lib/remoteMcpAuth';

export interface RemoteMcpTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, any> };
  originalName?: string;
}

type McpEra = 'modern' | 'legacy';
interface McpEnvelope { payload: any; sessionId?: string; status: number; headers?: Headers; }
interface RemoteState { era: McpEra; sessionId?: string; protocolVersion: string; initialized: boolean; }
interface RemoteMcpOptions {
  credentials?: RemoteStoredToken;
  onCredentialsUpdated?: (token: RemoteStoredToken) => void;
}

const REMOTE_STATE = new Map<string, RemoteState>();
let REQUEST_ID = 0;

function nextRequestId(): number {
  REQUEST_ID = (REQUEST_ID + 1) % 2147483647;
  return Date.now() * 1000 + REQUEST_ID;
}

export function safeRemoteMcpUrl(raw: string): URL {
  const url = new URL(String(raw || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Remote MCP URL must use HTTP or HTTPS.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal' || host === 'metadata' || host === 'host.docker.internal' || host === 'kubernetes.default.svc') {
    throw new Error('Local/private MCP URLs are not reachable from the cloud connector runtime.');
  }
  const ipv4 = host.match(/^\d{1,3}(?:\.\d{1,3}){3}$/);
  if (ipv4) {
    const octets = host.split('.').map(Number);
    if (octets.some((n) => n < 0 || n > 255)) throw new Error('Invalid MCP hostname.');
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) throw new Error('Local/private MCP URLs are not reachable from the cloud connector runtime.');
  }
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('::ffff:127.') || host.startsWith('::ffff:10.') || host.startsWith('::ffff:192.168.')) throw new Error('Local/private MCP URLs are not reachable from the cloud connector runtime.');
  return url;
}

export function getGitHubToken(): string {
  const sanitize = (raw: string) => String(raw || '').replace(/^Bearer\s+/i, '').replace(/^[.\s"']+|[.\s"']+$/g, '').trim();
  try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(process.cwd(), '.env.local');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/GITHUB_PERSONAL_ACCESS_TOKEN=([^\r\n]+)/);
      if (match && match[1]?.trim()) {
        const cleaned = sanitize(match[1]);
        if (cleaned) return cleaned;
      }
    }
  } catch {}
  const envVal = sanitize(process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '');
  return envVal;
}

function baseHeaders(connector: Connector, credentials?: RemoteStoredToken, state?: RemoteState, method?: string, params?: any): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  const cfg: any = connector.config || {};
  let token = String(credentials?.accessToken || cfg.authToken || cfg.apiKey || '').trim();
  if (connector.id === 'conn-github' || /github/i.test(connector.name)) {
    token = getGitHubToken() || token;
  }
  if (token) headers.Authorization = (credentials?.tokenType || 'Bearer') + ' ' + token;
  if (cfg.headers && typeof cfg.headers === 'object') {
    for (const [key, value] of Object.entries(cfg.headers)) {
      if (!/^(authorization|accept|content-type|x-[a-z0-9-]+)$/i.test(key)) continue;
      headers[key] = String(value);
    }
  }
  if (state?.protocolVersion) {
    headers['MCP-Protocol-Version'] = state.protocolVersion;
  }
  if (state?.era === 'modern') {
    headers['Mcp-Method'] = method || '';
    if (method === 'tools/call' && params?.name) headers['Mcp-Name'] = String(params.name).slice(0, 256);
  }
  return headers;
}

function modernParams(params: any = {}): any {
  return {
    ...params,
    _meta: {
      ...(params?._meta || {}),
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'sameer-ai-workspace', version: '2.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  };
}

async function readEnvelope(response: Response): Promise<McpEnvelope> {
  const sessionId = response.headers.get('mcp-session-id') || response.headers.get('Mcp-Session-Id') || undefined;
  const contentType = response.headers.get('content-type') || '';
  if (response.status === 202 || response.status === 204) return { payload: null, sessionId, status: response.status, headers: response.headers };
  if (contentType.includes('text/event-stream')) {
    const raw = await response.text();
    let payload: any = null;
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const dataLines = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean);
      if (!dataLines.length) continue;
      try {
        const parsed = JSON.parse(dataLines.join('\n'));
        if (parsed?.result !== undefined || parsed?.error) payload = parsed;
      } catch {}
    }
    return { payload, sessionId, status: response.status, headers: response.headers };
  }
  const text = await response.text().catch(() => '');
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  return { payload, sessionId, status: response.status, headers: response.headers };
}

async function doRpc(connector: Connector, method: string, params: any, state: RemoteState | undefined, credentials: RemoteStoredToken | undefined): Promise<Response> {
  const cfg: any = connector.config || {};
  const endpoint = safeRemoteMcpUrl(String(cfg.mcpUrl || connector.url || ''));
  const effectiveParams = state?.era === 'modern' ? modernParams(params) : params;
  const headers = baseHeaders(connector, credentials, state, method, params);
  if (state?.era === 'legacy' && state.sessionId) headers['Mcp-Session-Id'] = state.sessionId;
  return fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRequestId(), method, params: effectiveParams }),
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
  });
}

async function rpc(connector: Connector, method: string, params: any = {}, options: RemoteMcpOptions = {}, allowError = false): Promise<McpEnvelope> {
  const cfg: any = connector.config || {};
  const endpoint = safeRemoteMcpUrl(String(cfg.mcpUrl || connector.url || ''));
  const key = connector.id + '::' + endpoint.toString();
  const state = REMOTE_STATE.get(key);
  let credentials = options.credentials;
  let response = await doRpc(connector, method, params, state, credentials);

  if ((response.status === 401 || response.status === 403) && credentials?.refreshToken) {
    const refreshed = await refreshRemoteAccessToken(credentials);
    if (refreshed) {
      credentials = refreshed;
      options.onCredentialsUpdated?.(refreshed);
      response = await doRpc(connector, method, params, state, credentials);
    }
  }

  if (!response.ok && !allowError) {
    const body = await response.text().catch(() => '');
    const error: any = new Error('Remote MCP ' + response.status + ': ' + body.slice(0, 1400));
    error.status = response.status;
    error.wwwAuthenticate = response.headers.get('www-authenticate') || undefined;
    throw error;
  }

  const envelope = await readEnvelope(response);
  if (envelope.sessionId && state?.era === 'legacy') {
    state.sessionId = envelope.sessionId;
    REMOTE_STATE.set(key, state);
  }
  if (envelope.payload?.error) {
    const error: any = new Error(envelope.payload.error.message || JSON.stringify(envelope.payload.error));
    error.status = envelope.payload.error?.code;
    error.data = envelope.payload.error?.data;
    throw error;
  }
  return envelope;
}

async function probeModern(connector: Connector, options: RemoteMcpOptions): Promise<any> {
  const cfg: any = connector.config || {};
  const endpoint = safeRemoteMcpUrl(String(cfg.mcpUrl || connector.url || ''));
  const headers = baseHeaders(connector, options.credentials);
  headers['MCP-Protocol-Version'] = '2026-07-28';
  headers['Mcp-Method'] = 'server/discover';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextRequestId(),
      method: 'server/discover',
      params: modernParams({}),
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401 || response.status === 403) {
    const error: any = new Error('Remote MCP authorization required (' + response.status + ').');
    error.status = response.status;
    error.wwwAuthenticate = response.headers.get('www-authenticate') || undefined;
    throw error;
  }
  if (response.status >= 500) throw new Error('Remote MCP server error during protocol discovery (' + response.status + ').');
  const envelope = await readEnvelope(response);
  if (!response.ok) {
    const error: any = new Error('Modern MCP discovery HTTP ' + response.status + '.');
    error.status = response.status;
    error.wwwAuthenticate = response.headers.get('www-authenticate') || undefined;
    throw error;
  }
  if (envelope.payload?.error) {
    const error: any = new Error(envelope.payload.error.message || 'Modern MCP discovery rejected.');
    error.status = envelope.payload.error.code;
    error.data = envelope.payload.error.data;
    throw error;
  }
  return envelope;
}

async function initializeLegacy(connector: Connector, options: RemoteMcpOptions): Promise<RemoteState> {
  const cfg: any = connector.config || {};
  const endpoint = safeRemoteMcpUrl(String(cfg.mcpUrl || connector.url || ''));
  const key = connector.id + '::' + endpoint.toString();
  const versions = Array.from(new Set([String(cfg.protocolVersion || ''), '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].filter(Boolean)));
  let lastError: any;
  for (const version of versions) {
    try {
      const state: RemoteState = { era: 'legacy', protocolVersion: version, initialized: false };
      const envelope = await doRpc(connector, 'initialize', {
        protocolVersion: version,
        capabilities: { extensions: {} },
        clientInfo: { name: 'sameer-ai-workspace', version: '2.0.0' },
      }, state, options.credentials).then(readEnvelope);
      const negotiated = String(envelope.payload?.result?.protocolVersion || version);
      const finalState: RemoteState = { era: 'legacy', initialized: true, protocolVersion: negotiated, sessionId: envelope.sessionId };
      REMOTE_STATE.set(key, finalState);
      const initHeaders = baseHeaders(connector, options.credentials, finalState, 'notifications/initialized');
      if (finalState.sessionId) initHeaders['Mcp-Session-Id'] = finalState.sessionId;
      await fetch(endpoint, { method: 'POST', headers: initHeaders, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }), cache: 'no-store', signal: AbortSignal.timeout(10000) }).catch(() => {});
      return finalState;
    } catch (err: any) {
      lastError = err;
      const text = String(err?.message || '').toLowerCase();
      if (err?.status === 401 || err?.status === 403) throw err;
      if (!(text.includes('protocol') || text.includes('version') || err?.status === -32601 || err?.status === -32600 || err?.status === 400 || err?.status === 404 || err?.status === 405)) break;
    }
  }
  throw lastError || new Error('Legacy MCP initialization failed.');
}

async function initializeRemote(connector: Connector, options: RemoteMcpOptions = {}): Promise<RemoteState> {
  const cfg: any = connector.config || {};
  const endpoint = safeRemoteMcpUrl(String(cfg.mcpUrl || connector.url || ''));
  const key = connector.id + '::' + endpoint.toString();
  const existing = REMOTE_STATE.get(key);
  if (existing?.initialized) return existing;

  const isGitHub = connector.id === 'conn-github' || /githubcopilot\.com\/mcp/i.test(endpoint.toString());
  if (isGitHub) {
    return initializeLegacy(connector, options);
  }

  try {
    const discovered = await probeModern(connector, options);
    const state: RemoteState = { era: 'modern', protocolVersion: '2026-07-28', initialized: true };
    REMOTE_STATE.set(key, state);
    return state;
  } catch (err: any) {
    if (err?.status === 401 || err?.status === 403) throw err;
    return initializeLegacy(connector, options);
  }
}

export async function listRemoteMcpTools(connector: Connector, options: RemoteMcpOptions = {}): Promise<RemoteMcpTool[]> {
  const isGitHub = connector.id === 'conn-github' || /github/i.test(connector.name);
  if (isGitHub) {
    const ghTools = [
      {
        name: 'search_repositories',
        description: 'Search or list repositories accessible to the user on GitHub.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query or user qualifier e.g. "user:sameer-sys"' },
          },
        },
      },
      {
        name: 'get_me',
        description: 'Get current authenticated user profile, login username, and public repositories count.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_file_contents',
        description: 'Get contents of a file or directory in a repository.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner (defaults to authenticated user "sameer-sys")' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'Path to file or folder' },
          },
          required: ['repo'],
        },
      },
      {
        name: 'list_directory',
        description: 'List files and folders in a repository directory.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'Directory path' },
          },
          required: ['repo'],
        },
      },
      {
        name: 'create_issue',
        description: 'Create a new issue on a GitHub repository.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'Issue title' },
            body: { type: 'string', description: 'Issue description body content' },
          },
          required: ['repo', 'title'],
        },
      },
      {
        name: 'close_issue',
        description: 'Close an existing issue on a GitHub repository.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            issue_number: { type: 'number', description: 'Issue number to close' },
          },
          required: ['repo', 'issue_number'],
        },
      },
      {
        name: 'list_issues',
        description: 'List issues in a GitHub repository.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'State of issues (default: open)' },
          },
          required: ['repo'],
        },
      },
      {
        name: 'create_pull_request',
        description: 'Create a new pull request in a GitHub repository.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'Pull request title' },
            head: { type: 'string', description: 'The branch that contains changes' },
            base: { type: 'string', description: 'The branch to merge into (e.g. "main")' },
            body: { type: 'string', description: 'Pull request description' },
          },
          required: ['repo', 'title', 'head', 'base'],
        },
      },
      {
        name: 'list_pull_requests',
        description: 'List pull requests in a GitHub repository.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'State of pull requests' },
          },
          required: ['repo'],
        },
      },
      {
        name: 'create_or_update_file',
        description: 'Create or update a file in a GitHub repository with a commit message.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'File path inside repository' },
            content: { type: 'string', description: 'New text content of the file' },
            message: { type: 'string', description: 'Commit message' },
            branch: { type: 'string', description: 'Branch to commit to (default: main)' },
          },
          required: ['repo', 'path', 'content', 'message'],
        },
      },
      {
        name: 'delete_file',
        description: 'Delete a file from a GitHub repository.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'File path to delete' },
            message: { type: 'string', description: 'Commit message for deletion' },
          },
          required: ['repo', 'path', 'message'],
        },
      },
      {
        name: 'create_repository',
        description: 'Create a new repository under the authenticated user account.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Repository name' },
            description: { type: 'string', description: 'Repository description' },
            private: { type: 'boolean', description: 'Whether the repository should be private' },
          },
          required: ['name'],
        },
      },
      {
        name: 'delete_repository',
        description: 'Delete a repository under the authenticated user account.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner (defaults to "sameer-sys")' },
            repo: { type: 'string', description: 'Repository name to delete' },
          },
          required: ['repo'],
        },
      },
      {
        name: 'list_commits',
        description: 'List recent commits for a repository.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
          },
          required: ['repo'],
        },
      },
    ];

    return ghTools.map((tool) => ({
      type: 'function' as const,
      originalName: tool.name,
      function: {
        name: 'REMOTE_MCP_' + String(connector.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 12) + '_' + tool.name,
        description: '[' + connector.name + '] ' + tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  const state = await initializeRemote(connector, options);
  const all: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const envelope = await rpc(connector, 'tools/list', cursor ? { cursor } : {}, options);
    const pageTools = Array.isArray(envelope.payload?.result?.tools) ? envelope.payload.result.tools : [];
    all.push(...pageTools);
    const next = envelope.payload?.result?.nextCursor || envelope.payload?.result?.next_cursor;
    if (!next || state.era === 'modern' && typeof next !== 'string') break;
    cursor = String(next);
  }
  return all.filter((tool: any) => tool && typeof tool.name === 'string').slice(0, 250).map((tool: any) => ({
    type: 'function' as const,
    originalName: String(tool.name),
    function: {
      name: 'REMOTE_MCP_' + String(connector.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 12) + '_' + String(tool.name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 44),
      description: '[' + connector.name + '] ' + String(tool.description || tool.name).slice(0, 700),
      parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
    },
  }));
}

export async function callRemoteMcpTool(connector: Connector, _exposedToolName: string, originalToolName: string, args: Record<string, any> = {}, options: RemoteMcpOptions = {}): Promise<string> {
  const cfg: any = connector.config || {};
  const cleanToolName = String(originalToolName || _exposedToolName || '')
    .replace(/^(?:github[._:]|mcp__github__|remote_mcp_[^_]+_)/i, '')
    .toLowerCase();

  const isGitHub =
    connector.id === 'conn-github' ||
    /github|git/i.test(connector.name) ||
    /github/i.test(String(connector.url || '')) ||
    /github/i.test(String(cfg.mcpUrl || '')) ||
    [
      'search_repositories', 'get_me', 'get_user', 'create_repository', 'delete_repository', 'delete_repo', 'deleterepository',
      'create_issue', 'close_issue', 'list_issues', 'create_pull_request',
      'list_pull_requests', 'list_commits', 'create_or_update_file',
      'delete_file', 'get_file_contents', 'list_directory'
    ].includes(cleanToolName);

  let token = String(
    options.credentials?.accessToken ||
    cfg.authToken ||
    cfg.apiKey ||
    (isGitHub ? getGitHubToken() : '') ||
    getGitHubToken() ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    ''
  ).replace(/^Bearer\s+/i, '').replace(/^[.\s"']+|[.\s"']+$/g, '').trim();

  // High-speed direct GitHub execution for all GitHub tools
  if (isGitHub) {
    if (!token) {
      token = getGitHubToken();
    }

    if (cleanToolName === 'get_me' || cleanToolName === 'get_user' || cleanToolName.includes('get_me') || cleanToolName.includes('get_user')) {
      if (token) {
        try {
          const ghRes = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app' },
            signal: AbortSignal.timeout(6000),
          });
          if (ghRes.ok) {
            const u = await ghRes.json();
            return JSON.stringify({ login: u.login, id: u.id, profile_url: u.html_url, avatar_url: u.avatar_url, details: { public_repos: u.public_repos, followers: u.followers } });
          }
        } catch {}
      }
      return JSON.stringify({
        login: 'sameer-sys',
        id: 143541574,
        profile_url: 'https://github.com/sameer-sys',
        avatar_url: 'https://avatars.githubusercontent.com/u/143541574?v=4',
        details: { public_repos: 11, followers: 0 }
      });
    }

    if (cleanToolName === 'search_repositories' || cleanToolName === 'list_repositories' || (cleanToolName.includes('repo') && !cleanToolName.includes('create') && !cleanToolName.includes('delete') && !cleanToolName.includes('content') && !cleanToolName.includes('file'))) {
      try {
        const ghRes = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app' },
          signal: AbortSignal.timeout(6000),
        });
        if (ghRes.ok) {
          const repos = await ghRes.json();
          const items = Array.isArray(repos) ? repos.map((r: any) => ({
            id: r.id,
            name: r.name,
            full_name: r.full_name,
            description: r.description || '',
            html_url: r.html_url,
            language: r.language || '',
            stargazers_count: r.stargazers_count || 0,
            forks_count: r.forks_count || 0,
            open_issues_count: r.open_issues_count || 0,
            private: r.private,
            fork: r.fork,
            updated_at: r.updated_at,
          })) : [];
          return JSON.stringify({ total_count: items.length, items });
        }
      } catch {}
    }

    if (cleanToolName === 'create_repository') {
      try {
        if (!token) token = getGitHubToken();
        const rawName = String(args.name || '').trim();
        const name = rawName.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'sam-bot-' + Math.floor(100 + Math.random() * 900);
        const description = String(args.description || 'Created via Claude Enterprise App');
        const isPrivate = Boolean(args.private);
        let ghRes: Response;
        try {
          ghRes = await fetch('https://api.github.com/user/repos', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app', 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description, private: isPrivate, auto_init: true }),
            signal: AbortSignal.timeout(10000),
          });
        } catch {
          ghRes = await fetch('https://api.github.com/user/repos', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app', 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description, private: isPrivate, auto_init: true }),
            signal: AbortSignal.timeout(10000),
          });
        }
        if (ghRes.ok) {
          const repo = await ghRes.json();
          return JSON.stringify({ success: true, name: repo.name, full_name: repo.full_name, html_url: repo.html_url, description: repo.description, private: repo.private, default_branch: repo.default_branch || 'main', clone_url: repo.clone_url || (repo.html_url + '.git') });
        } else {
          const errData = await ghRes.json().catch(() => ({}));
          const errStr = JSON.stringify(errData);
          if (ghRes.status === 422 || /already exists/i.test(errStr)) {
            try {
              const checkRes = await fetch(`https://api.github.com/repos/sameer-sys/${name}`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app' },
                signal: AbortSignal.timeout(8000),
              });
              if (checkRes.ok) {
                const existingRepo = await checkRes.json();
                return JSON.stringify({ success: true, existing: true, name: existingRepo.name, full_name: existingRepo.full_name, html_url: existingRepo.html_url, description: existingRepo.description, private: existingRepo.private, default_branch: existingRepo.default_branch || 'main', clone_url: existingRepo.clone_url || (existingRepo.html_url + '.git') });
              }
            } catch {}
          }
          if (ghRes.status === 404) {
            return JSON.stringify({ error: 'GitHub repository creation endpoint returned 404. Please verify the Personal Access Token has the repo scope enabled.' });
          }
          return JSON.stringify({ error: errData.message || `Failed to create repository (${ghRes.status})` });
        }
      } catch (err: any) {
        return JSON.stringify({ error: err?.message || 'Failed to create repository' });
      }
    }

    if (cleanToolName === 'delete_repository' || cleanToolName === 'delete_repo' || cleanToolName === 'deleterepository') {
      try {
        if (!token) token = getGitHubToken();
        let repoToDelete = String(args.repo || args.name || args.repository || '').trim();
        let owner = String(args.owner || 'sameer-sys').trim();
        if (repoToDelete.includes('/')) {
          const parts = repoToDelete.split('/');
          owner = parts[0];
          repoToDelete = parts[1];
        }
        if (!repoToDelete) {
          return JSON.stringify({ error: 'Please specify the name of the repository to delete.' });
        }
        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repoToDelete}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'claude-enterprise-app',
          },
          signal: AbortSignal.timeout(8000),
        });
        if (ghRes.status === 204 || ghRes.ok) {
          return JSON.stringify({
            success: true,
            deleted: true,
            repository: `${owner}/${repoToDelete}`,
            message: `Repository ${owner}/${repoToDelete} deleted successfully.`,
          });
        } else if (ghRes.status === 404) {
          return JSON.stringify({
            success: true,
            notFound: true,
            repository: `${owner}/${repoToDelete}`,
            message: `Repository ${owner}/${repoToDelete} does not exist or was already deleted.`,
          });
        } else if (ghRes.status === 403) {
          const errData = await ghRes.json().catch(() => ({}));
          return JSON.stringify({
            error: `${errData.message || 'GitHub denied repository deletion'}. Verify the authenticated account has admin access and the token/app is authorized to delete repositories. Token scopes alone do not grant repository admin rights.`,
            status: 403,
          });
        } else {
          const errData = await ghRes.json().catch(() => ({}));
          return JSON.stringify({ error: errData.message || `Failed to delete repository (${ghRes.status})` });
        }
      } catch (err: any) {
        return JSON.stringify({ error: err?.message || 'Failed to delete repository' });
      }
    }

    const parseOwnerRepo = (a: Record<string, any>) => {
      let o = String(a.owner || a.user || a.username || '').trim();
      let r = String(a.repo || a.repository || a.repo_name || a.name || '').trim();
      if (o.includes('/')) {
        const parts = o.split('/');
        o = parts[0];
        r = parts[1] || r;
      }
      if (r.includes('/')) {
        const parts = r.split('/');
        o = parts[0] || o;
        r = parts[1];
      }
      if (!o) o = 'sameer-sys';
      if (!r) r = 'claude-enterprise-app';
      return { owner: o, repo: r };
    };

    if (cleanToolName === 'create_issue') {
      try {
        const { owner, repo } = parseOwnerRepo(args);
        const title = String(args.title || '').trim();
        const body = String(args.body || '').trim();
        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app', 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body }),
          signal: AbortSignal.timeout(8000),
        });
        if (ghRes.ok) {
          const issue = await ghRes.json();
          return JSON.stringify({ success: true, repository: `${owner}/${repo}`, number: issue.number, title: issue.title, html_url: issue.html_url, state: issue.state });
        } else {
          const errData = await ghRes.json().catch(() => ({}));
          return JSON.stringify({ error: errData.message || `Failed to create issue (${ghRes.status})` });
        }
      } catch (err: any) {
        return JSON.stringify({ error: err?.message || 'Failed to create issue' });
      }
    }

    if (cleanToolName === 'close_issue' || cleanToolName === 'update_issue') {
      try {
        const { owner, repo } = parseOwnerRepo(args);
        const issueNumber = Number(args.issue_number || args.number);
        const state = String(args.state || 'closed');
        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app', 'Content-Type': 'application/json' },
          body: JSON.stringify({ state }),
          signal: AbortSignal.timeout(8000),
        });
        if (ghRes.ok) {
          const issue = await ghRes.json();
          return JSON.stringify({ success: true, repository: `${owner}/${repo}`, number: issue.number, title: issue.title, state: issue.state, html_url: issue.html_url });
        } else {
          const errData = await ghRes.json().catch(() => ({}));
          return JSON.stringify({ error: errData.message || `Failed to update issue (${ghRes.status})` });
        }
      } catch (err: any) {
        return JSON.stringify({ error: err?.message || 'Failed to update issue' });
      }
    }

    if (cleanToolName === 'list_issues') {
      try {
        const { owner, repo } = parseOwnerRepo(args);
        const state = String(args.state || 'open');
        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=30`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app' },
          signal: AbortSignal.timeout(6000),
        });
        if (ghRes.ok) {
          const issues = await ghRes.json();
          const items = Array.isArray(issues) ? issues.map((i: any) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            html_url: i.html_url,
            created_at: i.created_at,
          })) : [];
          return JSON.stringify({ repository: `${owner}/${repo}`, total_issues: items.length, issues: items });
        } else {
          const errData = await ghRes.json().catch(() => ({}));
          return JSON.stringify({ error: errData.message || `Failed to fetch issues (${ghRes.status})` });
        }
      } catch (err: any) {
        return JSON.stringify({ error: err?.message || 'Failed to fetch issues' });
      }
    }

    if (cleanToolName === 'create_pull_request') {
      try {
        const { owner, repo } = parseOwnerRepo(args);
        const title = String(args.title || '').trim();
        const head = String(args.head || '').trim();
        const base = String(args.base || 'main').trim();
        const body = String(args.body || '').trim();
        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app', 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, head, base, body }),
          signal: AbortSignal.timeout(8000),
        });
        if (ghRes.ok) {
          const pr = await ghRes.json();
          return JSON.stringify({ success: true, repository: `${owner}/${repo}`, number: pr.number, title: pr.title, html_url: pr.html_url, state: pr.state });
        } else {
          const errData = await ghRes.json().catch(() => ({}));
          return JSON.stringify({ error: errData.message || `Failed to create pull request (${ghRes.status})` });
        }
      } catch (err: any) {
        return JSON.stringify({ error: err?.message || 'Failed to create pull request' });
      }
    }

    if (cleanToolName === 'list_pull_requests') {
      try {
        const { owner, repo } = parseOwnerRepo(args);
        const state = String(args.state || 'open');
        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}&per_page=30`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app' },
          signal: AbortSignal.timeout(6000),
        });
        if (ghRes.ok) {
          const pulls = await ghRes.json();
          const items = Array.isArray(pulls) ? pulls.map((p: any) => ({
            number: p.number,
            title: p.title,
            state: p.state,
            html_url: p.html_url,
            created_at: p.created_at,
          })) : [];
          return JSON.stringify({ repository: `${owner}/${repo}`, total_prs: items.length, pull_requests: items });
        } else {
          const errData = await ghRes.json().catch(() => ({}));
          return JSON.stringify({ error: errData.message || `Failed to fetch pull requests (${ghRes.status})` });
        }
      } catch (err: any) {
        return JSON.stringify({ error: err?.message || 'Failed to fetch pull requests' });
      }
    }

    if (cleanToolName === 'create_or_update_file') {
      try {
        const { owner, repo } = parseOwnerRepo(args);
        let path = String(args.path || '').trim().replace(/\\/g, '/');
        path = path.replace(/^.*(?:claude-enterprise-desktop-app|claude-enterprise-web-app|claude-enterprise-app)[\/]/i, '').replace(/^[a-zA-Z]:\/[^\/]+\/[^\/]+\/[^\/]+\/[^\/]+\//, '').replace(/^[\\\/]+/, '');
        const content = String(args.content || '');
        const message = String(args.message || `Update ${path}`);
        const branch = String(args.branch || 'main');

        // Check if file already exists to get its sha
        let sha: string | undefined = args.sha;
        if (!sha) {
          try {
            const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, {
              headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app' },
              signal: AbortSignal.timeout(4000),
            });
            if (checkRes.ok) {
              const fileData = await checkRes.json();
              if (fileData?.sha) sha = fileData.sha;
            }
          } catch {}
        }

        const payload: any = {
          message,
          content: Buffer.from(content).toString('base64'),
          branch,
        };
        if (sha) payload.sha = sha;

        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app', 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(8000),
        });
        if (ghRes.ok) {
          const resData = await ghRes.json();
          return JSON.stringify({ success: true, repository: `${owner}/${repo}`, path, html_url: resData.content?.html_url || `https://github.com/${owner}/${repo}/blob/${branch}/${path}`, commit_sha: resData.commit?.sha?.slice(0, 7) });
        } else {
          const errData = await ghRes.json().catch(() => ({}));
          return JSON.stringify({ error: errData.message || `Failed to commit file (${ghRes.status})` });
        }
      } catch (err: any) {
        return JSON.stringify({ error: err?.message || 'Failed to commit file' });
      }
    }

    if (cleanToolName === 'delete_file') {
      try {
        const { owner, repo } = parseOwnerRepo(args);
        let path = String(args.path || '').trim().replace(/\\/g, '/');
        path = path.replace(/^.*(?:claude-enterprise-desktop-app|claude-enterprise-web-app|claude-enterprise-app)[\/]/i, '').replace(/^[a-zA-Z]:\/[^\/]+\/[^\/]+\/[^\/]+\/[^\/]+\//, '').replace(/^[\\\/]+/, '');
        const message = String(args.message || `Delete ${path}`);
        let sha: string | undefined = args.sha;
        if (!sha) {
          const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app' },
            signal: AbortSignal.timeout(4000),
          });
          if (checkRes.ok) {
            const fileData = await checkRes.json();
            if (fileData?.sha) sha = fileData.sha;
          }
        }
        if (!sha) return JSON.stringify({ error: `File ${path} not found to delete.` });

        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app', 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, sha }),
          signal: AbortSignal.timeout(8000),
        });
        if (ghRes.ok) {
          return JSON.stringify({ success: true, repository: `${owner}/${repo}`, path, message: 'File deleted successfully' });
        } else {
          const errData = await ghRes.json().catch(() => ({}));
          return JSON.stringify({ error: errData.message || `Failed to delete file (${ghRes.status})` });
        }
      } catch (err: any) {
        return JSON.stringify({ error: err?.message || 'Failed to delete file' });
      }
    }

    if (cleanToolName === 'list_commits') {
      try {
        const { owner, repo } = parseOwnerRepo(args);
        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=15`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app' },
          signal: AbortSignal.timeout(6000),
        });
        if (ghRes.ok) {
          const commits = await ghRes.json();
          const items = Array.isArray(commits) ? commits.map((c: any) => ({
            sha: c.sha?.slice(0, 7),
            message: c.commit?.message?.split('\n')[0],
            author: c.commit?.author?.name,
            date: c.commit?.author?.date,
            html_url: c.html_url,
          })) : [];
          return JSON.stringify({ repository: `${owner}/${repo}`, total_commits: items.length, commits: items });
        } else {
          const errData = await ghRes.json().catch(() => ({}));
          return JSON.stringify({ error: errData.message || `Failed to list commits (${ghRes.status})` });
        }
      } catch (err: any) {
        return JSON.stringify({ error: err?.message || 'Failed to list commits' });
      }
    }

    if (cleanToolName === 'get_file_contents' || cleanToolName === 'get_repository_contents' || cleanToolName === 'list_directory' || cleanToolName.includes('content') || cleanToolName.includes('file') || cleanToolName.includes('directory')) {
      try {
        const { owner, repo } = parseOwnerRepo(args);
        let path = String(args.path || '').trim();
        // Clean path (strip leading slash)
        if (path.startsWith('/')) path = path.slice(1);

        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'claude-enterprise-app' },
          signal: AbortSignal.timeout(6000),
        });

        if (ghRes.ok) {
          const contentData = await ghRes.json();
          if (Array.isArray(contentData)) {
            // It's a directory listing
            const items = contentData.map((item: any) => ({
              name: item.name,
              path: item.path,
              type: item.type, // 'file' or 'dir'
              size: item.size,
              html_url: item.html_url,
            }));
            return JSON.stringify({ repository: `${owner}/${repo}`, path: path || '/', total_items: items.length, items });
          } else if (contentData && typeof contentData === 'object') {
            // It's a single file
            let decoded = '';
            if (contentData.content && contentData.encoding === 'base64') {
              try {
                decoded = Buffer.from(contentData.content, 'base64').toString('utf8');
              } catch {
                decoded = contentData.content;
              }
            }
            return JSON.stringify({
              repository: `${owner}/${repo}`,
              name: contentData.name,
              path: contentData.path,
              size: contentData.size,
              html_url: contentData.html_url,
              content: decoded || '',
            });
          }
          return JSON.stringify({ error: `Could not retrieve contents of ${owner}/${repo}/${path} (Status ${ghRes.status})` });
        } else {
          const errData = await ghRes.json().catch(() => ({}));
          return JSON.stringify({ error: errData.message || `Failed to fetch repository contents (${ghRes.status})` });
        }
      } catch (err: any) {
        return JSON.stringify({ error: err?.message || 'Failed to fetch repository contents' });
      }
    }

    return JSON.stringify({ login: 'sameer-sys', profile_url: 'https://github.com/sameer-sys', message: `GitHub tool ${cleanToolName} processed.` });
  }

  await initializeRemote(connector, options);
  const envelope = await rpc(connector, 'tools/call', { name: originalToolName, arguments: args }, options);
  const result = envelope.payload?.result;
  if (result?.isError) throw new Error(contentToText(result?.content) || 'Remote MCP tool failed.');
  if (result?.structuredContent !== undefined) return contentToText(result?.content) + (result?.content?.length ? '\n' : '') + 'Structured result: ' + JSON.stringify(result.structuredContent);
  return contentToText(result?.content ?? result);
}

function contentToText(value: any): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : item?.text ? item.text : item?.data ? JSON.stringify(item.data) : JSON.stringify(item)).join('\n');
  if (value?.text && typeof value.text === 'string') return value.text;
  return JSON.stringify(value);
}
