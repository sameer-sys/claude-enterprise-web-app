'use client';

import React, { useState, useEffect, useRef } from 'react';
import Sidebar from '@/components/Sidebar';
import ChatArea from '@/components/ChatArea';
import ArtifactPanel from '@/components/ArtifactPanel';
import BrowserPanel from '@/components/BrowserPanel';
import ConnectorsModal, { DEFAULT_CONNECTORS, createDefaultConnectors } from '@/components/ConnectorsModal';
import SettingsModal, { SettingsTab } from '@/components/SettingsModal';
import ProjectModal from '@/components/ProjectModal';
import DownloadModal from '@/components/DownloadModal';
import AgentsModal from '@/components/AgentsModal';
import FeaturesModal from '@/components/FeaturesModal';
import { parseAutonomousIntent } from '@/lib/autonomousIntent';
import ApprovalModal, { PendingApproval } from '@/components/ApprovalModal';
import { Session, Message, ModelId, Artifact, Project, Attachment, ThinkingBudget, CustomButton, OpenWorkAgent, ConnectorConfig, Connector } from '@/types/chat';

const DEFAULT_CUSTOM_BUTTONS: CustomButton[] = [
  { id: 'btn_1', label: '🚀 Deploy Guide', prompt: 'Provide a production deployment guide with Docker and CI/CD workflow.' },
  { id: 'btn_2', label: '⚡ Optimize Code', prompt: 'Analyze this code for performance bottlenecks and provide optimized code.' },
  { id: 'btn_3', label: '🔍 Security Audit', prompt: 'Audit this implementation for OWASP security vulnerabilities.' },
];

const DEFAULT_SESSION: Session = {
  id: 'ses_default',
  title: 'New Conversation',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  activeModel: 'boss',
  connectors: createDefaultConnectors(),
};


function createWorkspaceSyncCode(): string {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeConnectors(raw: any[]): Connector[] {
  // Composio is the sole built-in connector runtime. Preserve only
  // connectors explicitly created by the user; legacy native app cards
  // must never re-enter from localStorage or cloud state.
  const defaults = createDefaultConnectors();
  const byId = new Map<string, Connector>(defaults.map((connector) => [connector.id, connector]));
  const input = Array.isArray(raw)
    ? raw.filter((connector: any) => {
        if (!connector || typeof connector !== 'object') return false;
        const cfg = connector.config || {};
        const type = String(cfg.connectionType || connector.provider || '').toLowerCase();
        const url = String(cfg.mcpUrl || connector.url || '').trim();
        const isDirectMcp = type === 'mcp' && /^https?:\/\//i.test(url) && !/connect\.composio\.dev\/mcp/i.test(url);
        return connector.isCustom === true || isDirectMcp;
      })
    : [];

  for (const connector of input) {
    const url = String(connector?.config?.mcpUrl || connector?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;

    const safeConfig = { ...(connector.config || {}) };
    delete safeConfig.authToken;
    delete safeConfig.apiKey;
    delete safeConfig.clientSecret;

    const safe = {
      ...connector,
      config: { ...safeConfig, connectionType: 'mcp', mcpUrl: url },
      url,
    } as Connector;

    const base = byId.get(safe.id);
    byId.set(
      safe.id,
      base
        ? { ...base, ...safe, config: { ...(base.config || {}), ...(safe.config || {}) } }
        : safe
    );
  }

  return Array.from(byId.values());
}

function extractArtifact(content: string): Artifact | undefined {
  const codeBlockRegex = /```([a-zA-Z0-9_\-]+)?\n([\s\S]*?)```/;
  const match = content.match(codeBlockRegex);
  if (!match) return undefined;

  const lang = (match[1] || 'text').toLowerCase();
  const code = match[2];

  if (code.length < 40) return undefined;

  const isHtml = lang === 'html' || lang === 'svg';

  return {
    id: `art_${Date.now()}`,
    title: isHtml ? 'Interactive Component Preview' : `${lang.toUpperCase()} Implementation`,
    type: isHtml ? 'html' : 'code',
    language: lang,
    content: code,
  };
}

export default function Home() {
  const [sessions, setSessions] = useState<Session[]>([DEFAULT_SESSION]);
  const [activeSessionId, setActiveSessionId] = useState<string>(DEFAULT_SESSION.id);
  const [activeModel, setActiveModel] = useState<ModelId>('boss');
  const [thinkingBudget, setThinkingBudget] = useState<ThinkingBudget>(16000);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);

  // Two-Way Autonomous Proactive Mode (Disabled by default)
  const [isProactiveMode, setIsProactiveMode] = useState<boolean>(true);

  // Modals & Enterprise Features State
  const [isConnectorsOpen, setIsConnectorsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [isDownloadOpen, setIsDownloadOpen] = useState(false);
  const [isAgentsModalOpen, setIsAgentsModalOpen] = useState(false);
  const [isFeaturesOpen, setIsFeaturesOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>(DEFAULT_CONNECTORS);
  const [geminiKey, setGeminiKey] = useState<string>('');
  const [openRouterKey, setOpenRouterKey] = useState<string>('');

  // Built-in Browser Panel State (OpenWork style)
  const [isBrowserPanelOpen, setIsBrowserPanelOpen] = useState<boolean>(false);
  const [browserUrl, setBrowserUrl] = useState<string>('https://www.google.com');
  const [browserStepText, setBrowserStepText] = useState<string | undefined>(undefined);

  // Cross-device sync uses a high-entropy workspace code; Supabase credentials stay server-side.
  const [syncRoomId, setSyncRoomId] = useState<string>('');
  const [syncStatus, setSyncStatus] = useState<string>('Connecting to cloud storage...');
  const [syncReady, setSyncReady] = useState<boolean>(false);

  // Self-Customization Buttons State (Cross-Device Sync)
  const [customButtons, setCustomButtons] = useState<CustomButton[]>(DEFAULT_CUSTOM_BUTTONS);

  const abortControllerRef = useRef<AbortController | null>(null);
  const composioReconnectOpenedRef = useRef(false);

  // Service Worker Registration & Cache Invalidation for instant live updates
  useEffect(() => {
    if (typeof window !== 'undefined' && 'caches' in window) {
      caches.keys().then((keys) => {
        keys.forEach((key) => {
          if (key !== 'claude-live-v3') caches.delete(key).catch(() => {});
        });
      }).catch(() => {});
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        reg.update().catch(() => {});
      }).catch(() => {});
    }
  }, []);

  // Load from localStorage & Cloud Sync
  useEffect(() => {
    try {
      // Restore persisted custom MCP/CLI connectors. OAuth credentials never
      // live here; Composio auth remains in HttpOnly cookies on the server.

      const saved = localStorage.getItem('claude_cloud_sessions');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const initialized = parsed.map((s: any) => {
            const rawConns = Array.isArray(s.connectors) && s.connectors.length > 0
              ? s.connectors
              : createDefaultConnectors();

            // Clean any legacy emails or headoffice references
            const sanitizedConns = rawConns.map((c: any) => {
              if (c.config?.email && (
                c.config.email.includes('samesuf') ||
                c.config.email.includes('samesuf786') ||
                c.config.email.includes('samesuf629') ||
                c.config.email.includes('headoffice') ||
                c.config.email.includes('apexspherexports')
              )) {
                const { email, ...restConfig } = c.config;
                return { ...c, config: restConfig, enabled: false, status: 'ready' };
              }
              return c;
            });

            const mergedConns = normalizeConnectors(sanitizedConns);

            return {
              ...s,
              messages: Array.isArray(s.messages)
                ? s.messages
                    .filter((m: any) =>
                      !m.isProactive &&
                      !m.content?.includes('Quick update from the background') &&
                      !m.content?.includes('Standing by. If you want me to stage') &&
                      !m.content?.includes('Background check-in: Verified') &&
                      !m.content?.includes('Audited active connectors') &&
                      !m.content?.includes('just following up in the background') &&
                      !m.content?.includes('Welcome back, Sameer!')
                    )
                    .map((m: any) => ({
                      ...m,
                      content: typeof m.content === 'string'
                        ? m.content.replace(/headoffice@apexspherexports\.com/gi, 'connected-user@gmail.com').replace(/admin@apexspherexports\.com/gi, 'admin@gmail.com').replace(/apexspherexports\.com/gi, 'gmail.com')
                        : m.content,
                    }))
                : [],
              connectors: mergedConns,
            };
          });
          setSessions(initialized);
          setActiveSessionId(initialized[0].id);
        }
      }
      const savedProjects = localStorage.getItem('claude_projects');
      if (savedProjects) setProjects(JSON.parse(savedProjects));
      const savedGKey = localStorage.getItem('claude_gemini_key');
      if (savedGKey) setGeminiKey(savedGKey);
      const savedOrKey = localStorage.getItem('claude_openrouter_key');
      if (savedOrKey) setOpenRouterKey(savedOrKey);
      const savedProactive = localStorage.getItem('claude_proactive_mode');
      if (savedProactive !== null) setIsProactiveMode(savedProactive === 'true');

      // Load Self-Customization Buttons
      const savedBtns = localStorage.getItem('claude_custom_buttons');
      if (savedBtns) {
        try {
          setCustomButtons(JSON.parse(savedBtns));
        } catch (e) {}
      }

      // Sync code is a private, high-entropy workspace credential shared only with trusted devices.
      const storedRoom = localStorage.getItem('claude_sync_room') || '';
      const activeRoom = /^[A-Za-z0-9_-]{32,128}$/.test(storedRoom)
        ? storedRoom
        : createWorkspaceSyncCode();
      localStorage.setItem('claude_sync_room', activeRoom);
      // Remove legacy browser-stored Supabase credentials from the old unsafe sync implementation.
      localStorage.removeItem('claude_supabase_url');
      localStorage.removeItem('claude_supabase_key');
      setSyncRoomId(activeRoom);

      fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'load', roomId: activeRoom }),
      })
        .then(async (response) => {
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result?.success !== true) {
            throw new Error(result?.error || 'Cloud sync could not be loaded.');
          }
          if (result?.data && typeof result.data === 'object') {
            if (Array.isArray(result.data.sessions) && result.data.sessions.length > 0) {
              const cloudSessions = result.data.sessions.map((session: any) => ({
                ...session,
                connectors: normalizeConnectors(session.connectors),
              }));
              setSessions(cloudSessions);
            }
            if (Array.isArray(result.data.projects)) setProjects(result.data.projects);
            setSyncStatus('Cloud Synced');
          } else {
            setSyncStatus('Cloud Ready');
          }
          setSyncReady(true);
        })
        .catch((error) => {
          console.error('[workspace-sync] Initial cloud load failed:', error);
          setSyncStatus('Sync unavailable');
        });
    } catch (e) {
      // pass
    }
  }, []);

  // Listen for native OpenWork browser panel open events from Electron
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const api = (window as any).electronAPI?.browser;
      if (api?.onOpenPanel) {
        const cleanup = api.onOpenPanel((data: any) => {
          if (data?.url) setBrowserUrl(data.url);
          setIsBrowserPanelOpen(true);
        });
        return cleanup;
      }
    }
  }, []);

  // Remove any legacy built-in connector cards that may still be held in an open session.
  useEffect(() => {
    setSessions((prev) => {
      let changed = false;
      const cleaned = prev.map((session) => {
        const existing = Array.isArray(session.connectors) ? session.connectors : [];
        const connectors = existing.filter((connector) => {
          const cfg = connector?.config || {};
          const type = String(cfg.connectionType || connector?.provider || '').toLowerCase();
          const url = String(cfg.mcpUrl || connector?.url || '').trim();
          return type === 'mcp' && /^https?:\/\//i.test(url) && !/connect\.composio\.dev\/mcp/i.test(url);
        });
        if (connectors.length !== existing.length) changed = true;
        return connectors.length === existing.length ? session : { ...session, connectors };
      });
      return changed ? cleaned : prev;
    });
  }, []);

  // Detect OpenWork local bridge (Electron or localhost:48080)
  const [hasLocalBridge, setHasLocalBridge] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    const probe = async () => {
      try {
        if (typeof window !== 'undefined' && (window as any).electronAPI?.isElectron) {
          if (active) setHasLocalBridge(true);
          return;
        }
        const res = await fetch('http://127.0.0.1:48080/api/status', { signal: AbortSignal.timeout(1200) });
        if (res.ok && active) setHasLocalBridge(true);
      } catch {}
    };
    probe();
    return () => { active = false; };
  }, []);

  const handleSaveSyncRoomId = async (input: string) => {
    const code = input.trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(code)) {
      setSyncStatus('Invalid sync code');
      return;
    }
    setSyncReady(false);
    setSyncRoomId(code);
    localStorage.setItem('claude_sync_room', code);
    setSyncStatus('Loading workspace...');
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'load', roomId: code }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.success !== true) throw new Error(result?.error || 'Cloud load failed.');
      if (result?.data && typeof result.data === 'object') {
        if (Array.isArray(result.data.sessions) && result.data.sessions.length > 0) {
          setSessions(result.data.sessions.map((session: any) => ({
            ...session,
            connectors: normalizeConnectors(session.connectors),
          })));
        }
        if (Array.isArray(result.data.projects)) setProjects(result.data.projects);
        setSyncStatus('Cloud Synced');
      } else {
        setSyncStatus('Cloud Ready');
      }
      setSyncReady(true);
    } catch (error) {
      console.error('[workspace-sync] Workspace change failed:', error);
      setSyncStatus('Sync unavailable');
    }
  };

  const handleTriggerSyncNow = async () => {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(syncRoomId)) {
      setSyncStatus('Invalid sync code');
      return;
    }
    setSyncStatus('Syncing...');
    try {
      const resp = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          roomId: syncRoomId,
          data: { sessions, projects },
        }),
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok || result?.success !== true) {
        throw new Error(result?.error || 'Supabase did not confirm the save.');
      }
      setSyncStatus('Cloud Synced');
      setSyncReady(true);
    } catch (error) {
      console.error('[workspace-sync] Manual sync failed:', error);
      setSyncStatus('Sync Failed');
    }
  };

  // Save sessions to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('claude_cloud_sessions', JSON.stringify(sessions));
    } catch (e) {
      // pass
    }
  }, [sessions]);

  // Save projects to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('claude_projects', JSON.stringify(projects));
    } catch (e) {
      // pass
    }
  }, [projects]);

  // Debounced server-side cloud persistence; success is reported only after Supabase confirms the write.
  useEffect(() => {
    if (!syncReady || !/^[A-Za-z0-9_-]{32,128}$/.test(syncRoomId)) return;
    const timer = window.setTimeout(async () => {
      setSyncStatus('Syncing...');
      try {
        const response = await fetch('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'save',
            roomId: syncRoomId,
            data: { sessions, projects },
          }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result?.success !== true) {
          throw new Error(result?.error || 'Supabase did not confirm the save.');
        }
        setSyncStatus('Cloud Synced');
      } catch (error) {
        console.error('[workspace-sync] Automatic save failed:', error);
        setSyncStatus('Sync Failed');
      }
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [sessions, projects, syncRoomId, syncReady]);

  const handleToggleProactiveMode = () => {
    const next = !isProactiveMode;
    setIsProactiveMode(next);
    localStorage.setItem('claude_proactive_mode', String(next));
  };

  const handleSaveGeminiKey = (key: string) => {
    setGeminiKey(key);
    localStorage.setItem('claude_gemini_key', key);
  };

  const handleSaveOpenRouterKey = (key: string) => {
    setOpenRouterKey(key);
    localStorage.setItem('claude_openrouter_key', key);
  };

  // Notification permission for user-requested background alerts
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  const activeSession =
    sessions.find((s) => s.id === activeSessionId) || sessions[0] || DEFAULT_SESSION;

  // Chat must receive every enabled direct MCP connector, regardless of
  // whether it was created by the plugin creator or restored from an older
  // connector record. Only Composio-managed entries are excluded.
  const currentSessionConnectors =
    (activeSession.connectors || []).filter((connector) => {
      const cfg = connector?.config || {};
      const type = String(cfg.connectionType || connector?.provider || '').toLowerCase();
      const url = String(cfg.mcpUrl || connector?.url || '').trim();
      return type === 'mcp' && /^https?:\/\//i.test(url) && !/connect\.composio\.dev\/mcp/i.test(url);
    });

  const activeConnectorsCount = currentSessionConnectors.filter((connector) => connector.enabled).length;

  const handleToggleConnector = (id: string) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSession.id) return s;
        const curConns = s.connectors || createDefaultConnectors();
        const updatedConns = curConns.map((c) =>
          c.id === id ? { ...c, enabled: !c.enabled } : c
        );
        return { ...s, connectors: updatedConns };
      })
    );
  };

  const handleUpdateConnectorConfig = (id: string, config: ConnectorConfig) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSession.id) return s;
        const curConns = s.connectors || createDefaultConnectors();
        const updatedConns = curConns.map((c) =>
          c.id === id
            ? {
                ...c,
                config: { ...c.config, ...config },
              }
            : c
        );
        return { ...s, connectors: updatedConns };
      })
    );
  };

  const handleResetConnectorsForChat = () => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSession.id) return s;
        return { ...s, connectors: createDefaultConnectors() };
      })
    );
  };

  const handleAddCustomConnector = (newConn: Connector) => {
    try {
      const existingStr = localStorage.getItem('claude_custom_connectors');
      const existing: Connector[] = existingStr ? JSON.parse(existingStr) : [];
      const updatedCustom = [newConn, ...existing.filter((c) => c.id !== newConn.id)];
      localStorage.setItem('claude_custom_connectors', JSON.stringify(updatedCustom));
    } catch (e) {}

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSession.id) return s;
        const curConns = s.connectors || createDefaultConnectors();
        const filtered = curConns.filter((c) => c.id !== newConn.id);
        return { ...s, connectors: [newConn, ...filtered] };
      })
    );
  };

  const handleRemoveCustomConnector = (connectorId: string) => {
    setSessions((prev) => prev.map((s) => s.id === activeSession.id ? { ...s, connectors: (s.connectors || createDefaultConnectors()).filter((c) => c.id !== connectorId) } : s));
    try {
      const raw = localStorage.getItem('claude_custom_connectors');
      const saved: Connector[] = raw ? JSON.parse(raw) : [];
      localStorage.setItem('claude_custom_connectors', JSON.stringify(saved.filter((c) => c.id !== connectorId)));
    } catch {}
  };

  const handleCreateProject = (project: Project) => {
    setProjects([project, ...projects]);
    // Auto-open a first session for this PM
    const pmPrompt = `You are ${project.name}${project.email ? `, managing the account ${project.email}` : ''}. Your assigned task: ${project.task || 'General project management'}. Report your progress, flag any issues, and ask the Manager (Sameer) for approvals when needed. Be concise and professional in your updates.`;
    const firstMsg: Message = {
      id: `msg_pm_intro_${Date.now()}`,
      role: 'assistant',
      content: `👋 **${project.name} reporting for duty!**\n\n**Assigned Account:** ${project.email || 'Not specified'}\n**Task:** ${project.task || 'Awaiting assignment'}\n\nI'm ready to handle this project. I'll keep you (Manager) updated on progress, flag any blockers, and report issues as they come up.\n\n*What should I start with first?*`,
      timestamp: Date.now(),
      modelId: 'boss',
    };
    const pmSession: Session = {
      id: `ses_pm_${Date.now()}`,
      title: `${project.name} — Workspace`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [firstMsg],
      activeModel: 'boss',
      projectId: project.id,
      agentName: project.name,
      agentPrompt: pmPrompt,
      connectors: createDefaultConnectors(),
    };
    setSessions((prev) => [pmSession, ...prev]);
    setActiveSessionId(pmSession.id);
    setActiveArtifact(null);
  };

  // Open a new chat inside a PM's workspace (called when clicking a PM in sidebar)
  const handleNewPMSession = (project: Project) => {
    const pmPrompt = `You are ${project.name}${project.email ? `, managing the account ${project.email}` : ''}. Your assigned task: ${project.task || 'General project management'}. Report your progress, flag any issues, and ask the Manager (Sameer) for approvals when needed. Be concise and professional in your updates.`;
    const newSession: Session = {
      id: `ses_pm_${Date.now()}`,
      title: `${project.name} — Chat`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      activeModel: activeModel,
      projectId: project.id,
      agentName: project.name,
      agentPrompt: pmPrompt,
      connectors: createDefaultConnectors(),
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
    setActiveArtifact(null);
  };

  // Update a PM's lastReport and hasIssue from their latest message
  const handleUpdatePMReport = (projectId: string, report: string, hasIssue: boolean) => {
    setProjects((prev) =>
      prev.map((p) => p.id === projectId ? { ...p, lastReport: report, hasIssue } : p)
    );
  };


  const handleToggleStar = (id: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, starred: !s.starred } : s))
    );
  };

  const handleAddCustomButton = (btn: CustomButton) => {
    const updated = [...customButtons, btn];
    setCustomButtons(updated);
    localStorage.setItem('claude_custom_buttons', JSON.stringify(updated));
  };

  const handleDeleteCustomButton = (id: string) => {
    const updated = customButtons.filter((b) => b.id !== id);
    setCustomButtons(updated);
    localStorage.setItem('claude_custom_buttons', JSON.stringify(updated));
  };

  const handleSelectAgent = (agent: OpenWorkAgent) => {
    const targetModel: ModelId = 'boss';
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSession.id) return s;
        const welcomeMsg: Message = {
          id: `msg_agent_${Date.now()}`,
          role: 'assistant',
          content: `🤖 **${agent.name} (${agent.role}) activated!**\n\n${agent.description}\n\n*Specialized prompt injected into session context.* How can I assist you on this task, Sameer?`,
          timestamp: Date.now(),
          modelId: targetModel,
        };
        return {
          ...s,
          agentName: agent.name,
          agentPrompt: agent.systemPrompt,
          activeModel: targetModel,
          messages: [...s.messages, welcomeMsg],
        };
      })
    );
    setActiveModel(targetModel);
    setIsAgentsModalOpen(false);
  };

  const handleNewSession = () => {
    let customConns: Connector[] = [];
    try {
      const savedCustom = localStorage.getItem('claude_custom_connectors');
      if (savedCustom) customConns = JSON.parse(savedCustom);
    } catch (e) {}
    const defaultConns = createDefaultConnectors();
    const mergedConns = [...customConns, ...defaultConns.filter((dc) => !customConns.some((cc) => cc.id === dc.id))];

    const newSession: Session = {
      id: `ses_${Date.now()}`,
      title: 'New Conversation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastVisitedAt: Date.now(),
      messages: [],
      activeModel: activeModel,
      connectors: mergedConns,
    };
    setSessions([newSession, ...sessions]);
    setActiveSessionId(newSession.id);
    setActiveArtifact(null);
  };

  const handleDeleteSession = (id: string) => {
    const updated = sessions.filter((s) => s.id !== id);
    if (updated.length === 0) {
      setSessions([DEFAULT_SESSION]);
      setActiveSessionId(DEFAULT_SESSION.id);
    } else {
      setSessions(updated);
      if (activeSessionId === id) {
        setActiveSessionId(updated[0].id);
      }
    }
  };

  const handleStopStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
  };

  
  // Listen for OpenWork Human-in-the-Loop Approval requests
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).electronAPI?.approvals) {
      const unsub = (window as any).electronAPI.approvals.onRequested((appr: PendingApproval) => {
        setPendingApprovals((prev) => {
          if (prev.some((p) => p.id === appr.id)) return prev;
          return [...prev, appr];
        });
      });
      return unsub;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch('http://127.0.0.1:48080/api/approvals/pending');
        if (res.ok) {
          const data = await res.json();
          if (data.ok && Array.isArray(data.pending)) {
            setPendingApprovals(data.pending);
          }
        }
      } catch (e) {}
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleRespondApproval = async (id: string, approved: boolean) => {
    setPendingApprovals((prev) => prev.filter((p) => p.id !== id));
    try {
      if ((window as any).electronAPI?.approvals) {
        await (window as any).electronAPI.approvals.respond(id, approved);
      } else {
        await fetch('http://127.0.0.1:48080/api/approvals/respond', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, approved }),
        });
      }
    } catch (e) {}
  };

  // Auto-sync active session to SQLite persistent storage
  useEffect(() => {
    if (!activeSession || !activeSession.id) return;
    fetch('http://127.0.0.1:48080/api/db/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(activeSession),
    }).catch(() => {});
  }, [activeSession?.messages?.length, activeSession?.title]);

  const handleSendMessage = async (text: string, attachments?: Attachment[], isBrowserMode?: boolean) => {
    if (isStreaming) {
      handleStopStreaming();
    }

    const userMessage: Message = {
      id: `msg_u_${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      attachments,
    };

    const assistantMessageId = `msg_a_${Date.now()}`;
    const initialAssistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      modelId: activeModel,
      thinking: isBrowserMode
        ? 'Launching browser and preparing automated actions...'
        : 'Analyzing query intent, evaluating constraints, synthesizing optimal architectural path...',
      thinkingDuration: 2,
      thinkingBudget,
    };

    const isFirstMsg = activeSession.messages.length === 0;
    const newTitle = isFirstMsg
      ? text.slice(0, 32) + (text.length > 32 ? '...' : '')
      : activeSession.title;

    const updatedMessages = [...activeSession.messages, userMessage, initialAssistantMessage];

    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSession.id
          ? {
              ...s,
              title: newTitle,
              updatedAt: Date.now(),
              lastVisitedAt: Date.now(),
              messages: updatedMessages,
            }
          : s
      )
    );

    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // World-Class Autonomous Intent & Entity Understanding Engine
    const intent = parseAutonomousIntent(text, activeSession.messages);

    if (intent.isActionable && intent.category === 'BROWSER' && intent.browser) {
      const plan = intent.browser;
      setBrowserUrl(plan.url);
      setIsBrowserPanelOpen(true);
      setBrowserStepText(plan.description);

      // 1. Notify Electron embedded browser to navigate
      try {
        (window as any).electronAPI?.browser?.navigate?.(plan.url);
      } catch (e) {}

      // 2. Notify local bridge to navigate
      fetch('http://127.0.0.1:48080/api/execute-tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'browser_navigate', args: { url: plan.url } }),
      }).catch(() => {});

      // 3. Automated credential login execution
      if (plan.subGoal === 'LOGIN' && plan.credentials && (plan.credentials.username || plan.credentials.password)) {
        setTimeout(() => {
          fetch('http://127.0.0.1:48080/api/execute-tool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'browser_fill_login',
              args: {
                email: plan.credentials?.username,
                password: plan.credentials?.password,
                submit: true,
              },
            }),
          }).catch(() => {});
        }, 2200);
      }
    }

    // Browser Agent Mode Execution
    if (isBrowserMode || text.toLowerCase().startsWith('/browser')) {
      setIsBrowserPanelOpen(true);
      const cleanTask = text.replace(/^\/browser\s*/i, '').trim();
      try {
        const browserResp = await fetch('/api/browser', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task: cleanTask || text, headless: false }),
          signal: controller.signal,
        });

        if (!browserResp.ok) {
          throw new Error(`Browser service returned HTTP ${browserResp.status}`);
        }

        const reader = browserResp.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let browserLogs = `🌐 **Browser Agent Initialized**\nTask: *${cleanTask || text}*\n\n`;

        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const dataStr = line.replace(/^data:\s*/, '').trim();
            if (!dataStr || dataStr === '[DONE]') continue;
            try {
              const event = JSON.parse(dataStr);
              if (event.type === 'step' && event.step) {
                const s = event.step;
                setBrowserStepText(s.description);
                if (s.url) {
                  setBrowserUrl(s.url);
                  try {
                    (window as any).electronAPI?.browser?.navigate?.(s.url);
                  } catch {}
                }
                const icon = s.action === 'complete' ? '✅' : s.action === 'error' ? '❌' : '⚡';
                browserLogs += `${icon} **Step ${s.stepNumber} [${s.action.toUpperCase()}]:** ${s.description}\n`;
                setSessions((prev) =>
                  prev.map((sItem) =>
                    sItem.id === activeSession.id
                      ? {
                          ...sItem,
                          messages: sItem.messages.map((m) =>
                            m.id === assistantMessageId
                              ? { ...m, content: browserLogs, thinking: undefined }
                              : m
                          ),
                        }
                      : sItem
                  )
                );
              } else if (event.type === 'error') {
                browserLogs += `\n\n❌ **Notice:** ${event.error || 'Browser action could not be completed.'}`;
                setSessions((prev) =>
                  prev.map((sItem) =>
                    sItem.id === activeSession.id
                      ? {
                          ...sItem,
                          messages: sItem.messages.map((m) =>
                            m.id === assistantMessageId
                              ? { ...m, content: browserLogs, thinking: undefined }
                              : m
                          ),
                        }
                      : sItem
                  )
                );
              } else if (event.type === 'done') {
                browserLogs += `\n\n${event.finalMessage || 'Task finished successfully.'}`;
                setSessions((prev) =>
                  prev.map((sItem) =>
                    sItem.id === activeSession.id
                      ? {
                          ...sItem,
                          messages: sItem.messages.map((m) =>
                            m.id === assistantMessageId
                              ? { ...m, content: browserLogs, thinking: undefined }
                              : m
                          ),
                        }
                      : sItem
                  )
                );
              }
            } catch {}
          }
        }
        // Ensure assistant message content is always filled if stream ended
        setSessions((prev) =>
          prev.map((sItem) =>
            sItem.id === activeSession.id
              ? {
                  ...sItem,
                  messages: sItem.messages.map((m) =>
                    m.id === assistantMessageId && !m.content
                      ? { ...m, content: browserLogs, thinking: undefined }
                      : m
                  ),
                }
              : sItem
          )
        );
        setIsStreaming(false);
        return;
      } catch (browserErr: any) {
        const errMsg = browserErr?.message || 'Browser action failed';
        setSessions((prev) =>
          prev.map((sItem) =>
            sItem.id === activeSession.id
              ? {
                  ...sItem,
                  messages: sItem.messages.map((m) =>
                    m.id === assistantMessageId
                      ? { ...m, content: `❌ **Browser Agent Error:** ${errMsg}`, thinking: undefined }
                      : m
                  ),
                }
              : sItem
          )
        );
        setIsStreaming(false);
        return;
      }
    }

    try {
      let savedWorkspaceMemory: Record<string, string> = {};
      try {
        const rawMem = localStorage.getItem('claude_workspace_memory');
        if (rawMem) savedWorkspaceMemory = JSON.parse(rawMem);
      } catch {}

      const chatBody = {
        messages: [...activeSession.messages, userMessage],
        modelId: activeModel,
        geminiKey: geminiKey || undefined,
        openRouterKey: openRouterKey || undefined,
        thinkingBudget,
        agentPrompt: activeSession.agentPrompt,
        connectors: currentSessionConnectors,
        workspaceMemory: savedWorkspaceMemory,
        hasLocalBridge,
        isElectron: typeof window !== 'undefined' && Boolean((window as any).electronAPI?.isElectron),
      };

      // Composio access/refresh tokens are kept in server-side HttpOnly cookies.
      // Same-origin requests automatically include those cookies.
      const requestHeaders: Record<string, string> = { 'Content-Type': 'application/json' };

      let response = await fetch('/api/chat', {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(chatBody),
        signal: controller.signal,
      });

      if (!response.ok && (response.status === 504 || response.status === 502 || response.status === 503)) {
        await new Promise((r) => setTimeout(r, 600));
        response = await fetch('/api/chat', {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(chatBody),
          signal: controller.signal,
        });
      }

      if (!response.ok) {
        const errJson = await response.json().catch(() => null);
        const errMsg = errJson?.error || `Connecting to server (HTTP ${response.status})`;
        throw new Error(errMsg);
      }

      const activeSkill = response.headers.get('X-Claude-Skill') || undefined;
      const activeAgent = response.headers.get('X-Claude-Agent') || activeSession.agentName || undefined;

      // Composio session expired: auto-open the one-click reconnect popup so
      // the user only has to click "Authorize" on the Composio page. Opened at
      // most once per page load to avoid popup spam.
      if (response.headers.get('X-Composio-Needs-Reconnect') === 'true' && !composioReconnectOpenedRef.current) {
        composioReconnectOpenedRef.current = true;
        try {
          const authRes = await fetch('/api/composio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'get_mcp_oauth_url' }),
            signal: AbortSignal.timeout(20000),
          });
          const authData = await authRes.json().catch(() => ({}));
          if (authRes.ok && authData?.authUrl) {
            const popup = window.open(authData.authUrl, 'composio_login', 'popup,width=620,height=780,resizable=yes,scrollbars=yes');
            if (!popup) window.open(authData.authUrl, '_blank');
          }
        } catch (e) {
          // Reconnect popup is best-effort; the inline link still works.
        }
      }

      let reader = response.body?.getReader();
      if (!reader) throw new Error('No readable stream');

      const decoder = new TextDecoder();
      let accumulatedContent = '';
      let accumulatedThinking = '';
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        let switchedReader = false;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.replace('data: ', '');
          if (dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr);

            // Client-side local execution delegation (Desktop Bridge / Electron IPC)
            if (data.type === 'client_tool_call') {
              const toolNotice = `⚡ *Executing local action: ${data.name}...*`;
              setSessions((prev) =>
                prev.map((s) => {
                  if (s.id !== activeSession.id) return s;
                  return {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.id === assistantMessageId
                        ? { ...m, content: (accumulatedContent ? accumulatedContent + '\n\n' : '') + toolNotice }
                        : m
                    ),
                  };
                })
              );

              let execResult = '';
              try {
                if (typeof window !== 'undefined' && (window as any).electronAPI?.executeLocalTool) {
                  const ipcRes = await (window as any).electronAPI.executeLocalTool(data.name, data.args);
                  execResult = ipcRes?.success
                    ? (typeof ipcRes.result === 'string' ? ipcRes.result : JSON.stringify(ipcRes.result))
                    : (ipcRes?.error || 'Local tool execution failed');
                } else {
                  const bRes = await fetch('http://127.0.0.1:48080/api/execute-tool', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: data.name, args: data.args }),
                  });
                  const bJson = await bRes.json();
                  execResult = bJson.ok
                    ? (typeof bJson.result === 'string' ? bJson.result : JSON.stringify(bJson.result))
                    : (bJson.error || 'Bridge returned an error');
                }
              } catch (err: any) {
                execResult = `Execution error: ${err?.message || err}`;
              }

              if (data.name === 'browser_navigate' && data.args?.url) {
                setIsBrowserPanelOpen(true);
                setBrowserUrl(data.args.url);
                if (typeof window !== 'undefined' && (window as any).electronAPI?.browser?.navigate) {
                  (window as any).electronAPI.browser.navigate(data.args.url);
                }
              }

              const followUpBody = {
                ...chatBody,
                clientToolResult: {
                  toolCallId: data.id,
                  toolName: data.name,
                  result: execResult,
                  args: data.args,
                },
              };

              const followUpRes = await fetch('/api/chat', {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(followUpBody),
                signal: controller.signal,
              });

              if (followUpRes.ok && followUpRes.body) {
                reader = followUpRes.body.getReader();
                sseBuffer = '';
                accumulatedContent = '';
                switchedReader = true;
                break;
              }
            }

            let hasUpdate = false;
            // Provider reasoning is intentionally ignored here. Only the
            // assistant's final user-facing content belongs in the transcript.
            if (data.content) {
              accumulatedContent += data.content;
              hasUpdate = true;
            }

            if (hasUpdate) {
              const artifact = extractArtifact(accumulatedContent);

              setSessions((prev) =>
                prev.map((s) => {
                  if (s.id !== activeSession.id) return s;
                  return {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.id === assistantMessageId
                        ? {
                            ...m,
                            content: accumulatedContent,
                            thinking: accumulatedThinking || m.thinking,
                            artifact,
                            skillActivated: activeSkill,
                            agentAssigned: activeAgent,
                          }
                        : m
                    ),
                  };
                })
              );
            }
          } catch (e) {
            // pass
          }
        }
        if (switchedReader) continue;
      }

      // Safeguard: Ensure assistant response is never left blank
      if (!accumulatedContent.trim()) {
        const fallbackText = 'No response was returned. Please try again.';
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== activeSession.id) return s;
            return {
              ...s,
              messages: s.messages.map((m) =>
                m.id === assistantMessageId
                  ? {
                      ...m,
                      content: fallbackText,
                    }
                  : m
              ),
            };
          })
        );
      }

      // Continuous 2-Way Notification: Alert user if they stepped away or minimized app
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
        new Notification('Sameer AI Workspace', {
          body: 'Your response and artifacts are ready.',
          icon: '/favicon.ico',
        });
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // aborted
      } else {
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== activeSession.id) return s;
            return {
              ...s,
              messages: s.messages.map((m) =>
                m.id === assistantMessageId
                  ? {
                      ...m,
                      content: err.message
                        ? `⚠️ **Connection notice:** ${err.message}. Please try sending again.`
                        : '⚠️ **Connection notice:** Unable to reach model endpoint. Please try again.',
                    }
                  : m
              ),
            };
          })
        );
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  const handleRegenerateLast = () => {
    const msgs = activeSession.messages;
    if (msgs.length < 2) return;
    const lastUserMsg = [...msgs].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;

    const trimmed = msgs.slice(0, msgs.length - 1);
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSession.id ? { ...s, messages: trimmed } : s
      )
    );
    handleSendMessage(lastUserMsg.content, lastUserMsg.attachments);
  };

  const handleEditAndResendMessage = (msgId: string, newText: string) => {
    const msgs = activeSession.messages;
    const msgIdx = msgs.findIndex((m) => m.id === msgId);
    if (msgIdx === -1) return;
    const oldMsg = msgs[msgIdx];
    const truncated = msgs.slice(0, msgIdx);
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSession.id ? { ...s, messages: truncated } : s
      )
    );
    handleSendMessage(newText, oldMsg.attachments);
  };


  // Omnibox Direct Chrome Search (?q=... or ?prompt=...)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const searchParam = params.get('q') || params.get('prompt') || params.get('search');
    if (searchParam && searchParam.trim()) {
      const query = searchParam.trim();
      window.history.replaceState({}, '', window.location.pathname);
      const timer = setTimeout(() => {
        handleSendMessage(query);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#1c1b18]">
      {/* Claude Sidebar with Toggle */}
      {isSidebarOpen && (
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSession.id}
          onSelectSession={(id) => {
            setActiveSessionId(id);
            const target = sessions.find((s) => s.id === id);
            if (target?.activeModel) {
              setActiveModel(target.activeModel);
            }
          }}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
          onToggleStar={handleToggleStar}
          isOpenMobile={isMobileSidebarOpen}
          onCloseMobile={() => setIsMobileSidebarOpen(false)}
          onOpenConnectors={() => setIsConnectorsOpen(true)}
          onOpenSettings={() => {
            setSettingsTab('general');
            setIsSettingsOpen(true);
          }}
          onOpenNewProject={() => setIsProjectModalOpen(true)}
          onNewPMSession={handleNewPMSession}
          onOpenAgents={() => setIsAgentsModalOpen(true)}
          projects={projects}
          activeConnectorsCount={activeConnectorsCount}
          activeConnectors={currentSessionConnectors}
          onToggleConnector={handleToggleConnector}
          activeSessionTitle={activeSession.title}
          hasGeminiKey={Boolean(geminiKey)}
          onOpenFeatures={() => setIsFeaturesOpen(true)}
        />
      )}

      {/* Main Viewport */}
      <main className="flex-1 flex h-full overflow-hidden relative">
        {/* Toggle Sidebar Button on Left Side */}
        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          aria-label={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          className="absolute left-3 top-3 z-30 p-1.5 rounded-lg bg-[#282620]/80 hover:bg-[#38352d] text-[#8a8579] hover:text-[#ece9e2] border border-[#38352d] transition-all shadow-sm"
          title={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M9 3v18" />
            {isSidebarOpen ? <path d="m16 15-3-3 3-3" /> : <path d="m14 9 3 3-3 3" />}
          </svg>
        </button>
        <ChatArea
          messages={activeSession.messages}
          activeModel={activeModel}
          onSelectModel={(model) => setActiveModel(model)}
          onSendMessage={handleSendMessage}
          onEditMessage={handleEditAndResendMessage}
          onStopStreaming={handleStopStreaming}
          onRegenerateLast={handleRegenerateLast}
          isStreaming={isStreaming}
          onOpenMobileSidebar={() => setIsMobileSidebarOpen(true)}
          onSelectArtifact={(art) => setActiveArtifact(art)}
          activeArtifactId={activeArtifact?.id}
          onOpenConnectors={() => setIsConnectorsOpen(true)}
          onOpenDownload={() => setIsDownloadOpen(true)}
          activeConnectorsCount={activeConnectorsCount}
          activeConnectors={currentSessionConnectors}
          onToggleConnector={handleToggleConnector}
          onUpdateConnectorConfig={handleUpdateConnectorConfig}
          thinkingBudget={thinkingBudget}
          onSelectThinkingBudget={setThinkingBudget}
          isProactiveMode={isProactiveMode}
          onToggleProactiveMode={handleToggleProactiveMode}
          customButtons={customButtons}
          onAddCustomButton={handleAddCustomButton}
          onDeleteCustomButton={handleDeleteCustomButton}
          sessionTitle={activeSession.title}
          onOpenSettings={() => {
            setSettingsTab('models');
            setIsSettingsOpen(true);
          }}
          onOpenFeatures={() => setIsFeaturesOpen(true)}
          hasGeminiKey={Boolean(geminiKey)}
          onToggleBrowserPanel={() => setIsBrowserPanelOpen((prev) => !prev)}
          isBrowserPanelOpen={isBrowserPanelOpen}
        />

        {/* Built-in Browser Panel (OpenWork Style) */}
        <BrowserPanel
          isOpen={isBrowserPanelOpen}
          onClose={() => setIsBrowserPanelOpen(false)}
          initialUrl={browserUrl}
          isAgentRunning={isStreaming && isBrowserPanelOpen}
          agentStepText={browserStepText}
          onUrlChange={(url) => setBrowserUrl(url)}
        />

        {/* Claude Artifact Panel */}
        {activeArtifact && (
          <ArtifactPanel
            artifact={activeArtifact}
            onClose={() => setActiveArtifact(null)}
          />
        )}
      </main>

      {/* Modals */}
      <ConnectorsModal
        key={`conn_${activeSession.id}`}
        isOpen={isConnectorsOpen}
        onClose={() => setIsConnectorsOpen(false)}
        activeConnectors={currentSessionConnectors}
        onToggleConnector={handleToggleConnector}
        onUpdateConnectorConfig={handleUpdateConnectorConfig}
        onAddCustomConnector={handleAddCustomConnector}
        onRemoveCustomConnector={handleRemoveCustomConnector}
        onResetConnectors={handleResetConnectorsForChat}
        sessionTitle={activeSession.title}
        sessionId={activeSession.id}
      />

      <SettingsModal
        key={`settings_${activeSession.id}`}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        initialTab={settingsTab}
        geminiKey={geminiKey}
        onSaveGeminiKey={handleSaveGeminiKey}
        openRouterKey={openRouterKey}
        onSaveOpenRouterKey={handleSaveOpenRouterKey}
        syncRoomId={syncRoomId}
        onSaveSyncRoomId={handleSaveSyncRoomId}
        onTriggerSyncNow={handleTriggerSyncNow}
        syncStatus={syncStatus}
        activeConnectors={currentSessionConnectors}
        onToggleConnector={handleToggleConnector}
        onUpdateConnectorConfig={handleUpdateConnectorConfig}
        sessionTitle={activeSession.title}
        onOpenConnectors={() => setIsConnectorsOpen(true)}
        thinkingBudget={thinkingBudget}
        onSelectThinkingBudget={setThinkingBudget}
        isProactiveMode={isProactiveMode}
        onToggleProactiveMode={handleToggleProactiveMode}
      />

      <ProjectModal
        isOpen={isProjectModalOpen}
        onClose={() => setIsProjectModalOpen(false)}
        onCreateProject={handleCreateProject}
      />

      <DownloadModal
        isOpen={isDownloadOpen}
        onClose={() => setIsDownloadOpen(false)}
      />

      <AgentsModal
        isOpen={isAgentsModalOpen}
        onClose={() => setIsAgentsModalOpen(false)}
        onSelectAgent={handleSelectAgent}
      />

      <ApprovalModal pendingApprovals={pendingApprovals} onRespond={handleRespondApproval} />

      <FeaturesModal
        isOpen={isFeaturesOpen}
        onClose={() => setIsFeaturesOpen(false)}
        onSelectPrompt={(prompt) => {
          handleSendMessage(prompt);
        }}
        onOpenSettings={() => {
          setSettingsTab('advanced');
          setIsSettingsOpen(true);
        }}
        onOpenDownload={() => setIsDownloadOpen(true)}
        onSelectThinkingBudget={(budget) => setThinkingBudget(budget as ThinkingBudget)}
      />
    </div>
  );
}
