export type ModelId = 'boss';

export type ResponseStyle = 'normal' | 'concise' | 'explanatory' | 'technical';

export type ThinkingBudget = 1000 | 4000 | 16000 | 32000;

export interface ModelOption {
  id: ModelId;
  name: string;
  tag: string;
  description: string;
  speed: string;
  badge?: string;
  contextWindow: string;
}

export interface Attachment {
  id: string;
  name: string;
  size: string;
  type: string;
  dataUrl?: string;     // Base64 data URL for images
  isImage?: boolean;    // Flag if attachment is an image
  contentSnippet?: string; // Text content for code or text documents
}

export interface ConnectorConfig {
  repo?: string;
  token?: string;
  driveFolder?: string;
  slackChannel?: string;
  notionDatabase?: string;
  serverUrl?: string;
  command?: string;
  email?: string;
  apiKey?: string;
  channelName?: string;
  handle?: string;
  platform?: string;
  subreddit?: string;
  webhookUrl?: string;
  /** Provider-neutral connector settings. */
  connectionType?: 'direct' | 'mcp' | 'webhook' | 'zapier' | 'composio' | 'custom-api' | 'cli';
  authUrl?: string;
  mcpUrl?: string;
  providerName?: string;
  endpoint?: string;
  notes?: string;
  accountName?: string;
  /** Optional OAuth client id supplied for a custom remote MCP server. */
  oauthClientId?: string;
  /** Server protocol version selected during MCP negotiation. */
  protocolVersion?: string;
  /** Per-connector HTTP tool access preferences. */
  toolAccess?: 'auto' | 'always' | 'on_demand';
  /** Remote MCP tool names disabled for this conversation. */
  disabledTools?: string[];
  /** Toolkit slug for a Composio-served connector. */
  composioApp?: string;
  connectedAccountId?: string;
  [key: string]: any;
}

export interface Connector {
  id: string;
  name: string;
  description: string;
  icon: string;
  enabled: boolean;
  status: 'connected' | 'ready' | 'idle';
  category: string;
  provider?: 'anthropic' | 'mcp' | 'community' | 'direct' | 'zapier' | 'composio' | 'custom-api' | 'cli';
  capabilities?: string[];
  config?: ConnectorConfig;
  isVerified?: boolean;
  isTrending?: boolean;
  isBeta?: boolean;
  isCustom?: boolean;
  url?: string;
  section?: 'custom' | 'top' | 'trending';
  /** Toolkit slug this preset maps to when served through Composio "For You". */
  composioApp?: string;
}

export interface CustomButton {
  id: string;
  label: string;
  prompt: string;
  color?: string;
}

export type ClaudeSkill =
  | 'code_runner'
  | 'generative_ui'
  | 'web_search'
  | 'deep_reasoning'
  | 'vision_analysis'
  | 'connector_sync';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  modelId?: ModelId;
  thinking?: string;
  thinkingDuration?: number;
  thinkingBudget?: ThinkingBudget;
  artifact?: Artifact;
  attachments?: Attachment[];
  isProactive?: boolean; // Sent autonomously by AI while user was away/offline
  skillActivated?: string; // Auto-skill triggered by Claude
  agentAssigned?: string; // Auto-agent persona assigned dynamically
}

export interface Artifact {
  id: string;
  title: string;
  type: 'code' | 'html' | 'markdown' | 'text' | 'svg';
  language?: string;
  content: string;
  version?: number;
}

export interface Project {
  id: string;
  name: string;           // e.g. "PM1", "PM2 — YouTube Manager"
  email: string;          // Assigned email account (e.g. client@domain.com)
  task: string;           // Assigned continuous task/project brief
  description: string;
  customInstructions: string;
  filesCount: number;
  createdAt: number;
  lastReport?: string;    // Latest progress/issue report snippet
  hasIssue?: boolean;     // Red flag if PM has reported a problem
  isActive?: boolean;     // Is PM currently working
}


export interface OpenWorkAgent {
  id: string;
  name: string;
  role: string;
  category: 'executive' | 'engineering' | 'design' | 'devops' | 'ai' | 'security';
  description: string;
  systemPrompt: string;
  avatarIcon: string;
  color?: string;
  skills: string[];
  modelId?: ModelId;
}

export interface ManagedSubAgent {
  id: string;
  name: string;
  role: string;
  alias: string;
  email?: string;
  status: 'idle' | 'working' | 'inspecting' | 'completed' | 'blocked';
  currentTask?: string;
  lastProgress?: string;
  modelId: ModelId;
  assignedBy?: string;
  outputLog?: string[];
}

export interface ExecutiveSquad {
  managerName: string;
  subAgents: ManagedSubAgent[];
  isMonitoring: boolean;
  activeDirective?: string;
  lastInspectionAt?: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  activeModel: ModelId;
  starred?: boolean;
  projectId?: string;
  lastVisitedAt?: number;
  connectors?: Connector[]; // Per-session connectors configuration
  agentId?: string; // Active OpenWork Agent
  agentName?: string;
  agentPrompt?: string; // Custom agent prompt
  isSquadSession?: boolean; // True if this session is the Executive Manager Squad
}
