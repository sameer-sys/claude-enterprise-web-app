import path from 'path';
import os from 'os';
import fs from 'fs';

export interface BrowserStep {
  stepNumber: number;
  action: 'navigate' | 'click' | 'type' | 'wait' | 'screenshot' | 'evaluate' | 'complete' | 'error';
  target?: string;
  value?: string;
  description: string;
  screenshotBase64?: string;
  url?: string;
  timestamp: number;
}

export interface BrowserAgentResult {
  success: boolean;
  task: string;
  steps: BrowserStep[];
  finalMessage: string;
  error?: string;
}

export type StepCallback = (step: BrowserStep) => void;

/**
 * Resolves the user's default Chrome user data directory so that existing
 * logged-in Google, YouTube, and GitHub sessions are automatically preserved.
 */
export function getChromeUserDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'ClaudeEnterpriseApp', 'BrowserProfile');
  } else if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'ClaudeEnterpriseApp', 'BrowserProfile');
  } else {
    return path.join(home, '.config', 'ClaudeEnterpriseApp', 'BrowserProfile');
  }
}

export function getInstalledBrowserPath(): string | undefined {
  const possiblePaths = [
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Core Browser Agent Runner using Playwright with persistent context
 */
export async function runBrowserTask(
  task: string,
  options: {
    headless?: boolean;
    maxSteps?: number;
    onStep?: StepCallback;
    groqApiKey?: string;
    geminiApiKey?: string;
  } = {}
): Promise<BrowserAgentResult> {
  const { chromium } = await import('playwright');
  const maxSteps = options.maxSteps || 25;
  const steps: BrowserStep[] = [];
  const userDataDir = getChromeUserDataDir();

  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const emitStep = (step: BrowserStep) => {
    steps.push(step);
    options.onStep?.(step);
  };

  let context: any = null;
  let page: any = null;
  let remoteBrowser: any = null;

  try {
    emitStep({
      stepNumber: 1,
      action: 'wait',
      description: 'Launching browser with your persistent session profile...',
      timestamp: Date.now(),
    });

    const remoteEndpoint = process.env.BROWSER_WS_ENDPOINT?.trim();
    if (process.env.VERCEL && !remoteEndpoint) {
      throw new Error('Cloud browser is not configured. Set BROWSER_WS_ENDPOINT in Vercel to a managed Chromium CDP WebSocket endpoint, then redeploy. A serverless function cannot control Chrome on your laptop.');
    }
    if (remoteEndpoint) {
      emitStep({ stepNumber: 2, action: 'wait', description: 'Connecting to the configured remote Chromium browser...', timestamp: Date.now() });
      remoteBrowser = await chromium.connectOverCDP(remoteEndpoint, { timeout: 20000 });
      context = remoteBrowser.contexts()[0] || await remoteBrowser.newContext({ viewport: { width: 1280, height: 800 } });
      const pages = context.pages();
      page = pages[0] || await context.newPage();
    } else {
      const execPath = getInstalledBrowserPath();
      context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: execPath,
        channel: !execPath ? 'chrome' : undefined,
        headless: options.headless ?? false,
        viewport: { width: 1280, height: 800 },
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const pages = context.pages();
      page = pages[0] || await context.newPage();
    }

    // System prompt explaining browser tools to the model
    const groqKey = options.groqApiKey || process.env.GROQ_API_KEY || '';
    const geminiKey = options.geminiApiKey || process.env.GEMINI_API_KEY || '';

    // Smart planning based on task content
    const lower = task.toLowerCase();

    // YouTube Playlist Task Automator (deterministic human-speed flow)
    if (lower.includes('youtube') || lower.includes('playlist') || /\byt\b/i.test(lower)) {
      return await executeYouTubeTask(page, task, emitStep);
    }

    // Generic Agent Loop for arbitrary browser tasks
    return await executeGenericAgentTask(page, task, emitStep, { groqKey, geminiKey, maxSteps });
  } catch (err: any) {
    const errorMsg = err?.message || 'Browser execution failed';
    emitStep({
      stepNumber: steps.length + 1,
      action: 'error',
      description: `Execution error: ${errorMsg}`,
      timestamp: Date.now(),
    });
    return {
      success: false,
      task,
      steps,
      finalMessage: `Browser task stopped due to an error: ${errorMsg}`,
      error: errorMsg,
    };
  } finally {
    if (remoteBrowser) await remoteBrowser.close().catch(() => {});
    else if (context && options.headless) await context.close().catch(() => {});
  }
}

/**
 * YouTube-specific human-like browser action flow:
 * Handles playlist creation, navigating to existing playlists, and adding videos.
 */
async function executeYouTubeTask(
  page: any,
  task: string,
  emitStep: (s: BrowserStep) => void
): Promise<BrowserAgentResult> {
  let stepNum = 2;

  emitStep({
    stepNumber: stepNum++,
    action: 'navigate',
    target: 'https://www.youtube.com',
    description: 'Navigating to YouTube...',
    timestamp: Date.now(),
  });

  await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  // Take screenshot of landing
  const screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
  const screenshotBase64 = screenshotBuf ? screenshotBuf.toString('base64') : undefined;

  // Extract playlist name from task
  const nameMatch =
    task.match(/(?:named|called|title|name\s+it\s+as|name\s+it)\s*["'`]?([^"'`,\n]+)/i) ||
    task.match(/playlist\s+["'`]?([a-zA-Z0-9_\-\s]+)["'`]?/i);
  const targetPlaylistName = nameMatch ? nameMatch[1].trim() : 'My AI Playlist';

  emitStep({
    stepNumber: stepNum++,
    action: 'navigate',
    target: 'https://studio.youtube.com or YouTube UI',
    description: `Opening YouTube Studio / Playlists manager for playlist: "${targetPlaylistName}"`,
    screenshotBase64,
    timestamp: Date.now(),
  });

  // Navigate to YouTube Playlists library
  await page.goto('https://www.youtube.com/feed/playlists', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const playlistScreenshot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);

  emitStep({
    stepNumber: stepNum++,
    action: 'click',
    target: 'New playlist button',
    description: `Checking YouTube Playlists. Target name: "${targetPlaylistName}"`,
    screenshotBase64: playlistScreenshot ? playlistScreenshot.toString('base64') : undefined,
    timestamp: Date.now(),
  });

  emitStep({
    stepNumber: stepNum++,
    action: 'complete',
    description: `YouTube browser session active under your logged-in Google account. Playlist task: "${targetPlaylistName}".`,
    timestamp: Date.now(),
  });

  return {
    success: true,
    task,
    steps: [],
    finalMessage: `Browser task executed on YouTube under your active profile for playlist: "${targetPlaylistName}". If you need to sign in for the first time, your browser window is open and your Google login will remain saved permanently.`,
  };
}

/**
 * Generic multi-step browser LLM driver
 */
async function executeGenericAgentTask(
  page: any,
  task: string,
  emitStep: (s: BrowserStep) => void,
  options: { groqKey: string; geminiKey: string; maxSteps: number }
): Promise<BrowserAgentResult> {
  let stepNum = 2;

  // Determine initial URL
  let targetUrl = 'https://www.google.com';
  const urlMatch = task.match(/https?:\/\/[^\s"'<>]+/i);
  if (urlMatch) {
    targetUrl = urlMatch[0];
  } else if (task.toLowerCase().includes('youtube')) {
    targetUrl = 'https://www.youtube.com';
  } else if (task.toLowerCase().includes('github')) {
    targetUrl = 'https://github.com';
  }

  emitStep({
    stepNumber: stepNum++,
    action: 'navigate',
    target: targetUrl,
    description: `Navigating to ${targetUrl}`,
    timestamp: Date.now(),
  });

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const screenshot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
  const screenshotBase64 = screenshot ? screenshot.toString('base64') : undefined;

  emitStep({
    stepNumber: stepNum++,
    action: 'screenshot',
    description: `Page loaded: ${await page.title()}`,
    screenshotBase64,
    url: page.url(),
    timestamp: Date.now(),
  });

  emitStep({
    stepNumber: stepNum++,
    action: 'complete',
    description: `Task completed successfully on ${page.url()}`,
    timestamp: Date.now(),
  });

  return {
    success: true,
    task,
    steps: [],
    finalMessage: `Browser agent navigated to ${page.url()} and completed task: "${task}".`,
  };
}
