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
      if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
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

    // Route all requests through the same observe -> act -> verify agent loop.
    // Every request uses the same observe -> act -> verify agent loop.
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
  const key = options.geminiKey || options.groqKey;
  if (!key) throw new Error('Browser agent AI is not configured. Set GEMINI_API_KEY or GROQ_API_KEY.');
  const useGemini = Boolean(options.geminiKey);
  const endpoint = useGemini
    ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    : 'https://api.groq.com/openai/v1/chat/completions';
  const model = useGemini ? 'gemini-2.0-flash' : 'llama-3.3-70b-versatile';
  const maxSteps = Math.max(1, Math.min(options.maxSteps || 12, 20));
  const emitState = async (action: BrowserStep['action'], description: string, target?: string, value?: string) => {
    const shot = await page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
    emitStep({ stepNumber: stepNum++, action, target, value, description, url: page.url(), screenshotBase64: shot ? shot.toString('base64') : undefined, timestamp: Date.now() });
  };
  const observe = async () => page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[contenteditable="true"]'));
    const elements: any[] = [];
    for (const el of nodes) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden') continue;
      if (elements.length >= 60) break;
      const node = el as HTMLInputElement;
      const ref = 'e' + (elements.length + 1);
      el.setAttribute('data-agent-ref', ref);
      elements.push({ ref, tag: el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || (el as HTMLElement).innerText || node.placeholder || node.value || el.getAttribute('name') || '').trim().slice(0, 100), type: node.type || '', href: (el as HTMLAnchorElement).href || '', disabled: Boolean(node.disabled) || el.getAttribute('aria-disabled') === 'true' });
    }
    return { title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, 4500), elements };
  });
  const urlToken = task.split(/\s+/).find((part) => part.startsWith('https://') || part.startsWith('http://'));
  const initialUrl = urlToken || (/youtube/i.test(task) ? 'https://www.youtube.com' : /github/i.test(task) ? 'https://github.com' : 'https://www.google.com');
  await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await emitState('navigate', 'Opened initial page; observing the live page.', initialUrl);

  for (let i = 0; i < maxSteps; i++) {
    const state = await observe();
    const system = 'You are an autonomous browser agent. Respond ONLY with JSON keys action, ref, url, text, key, reason. Actions: navigate, click, fill, press, wait, complete, error. Use only current observed refs. Re-observe after each action. Opening a page is not task completion. Complete only when the current page provides evidence the goal is achieved. Never perform purchases, send messages, delete records, or publish content unless the user explicitly asked for that exact action. If blocked by login, CAPTCHA, permissions or missing setup, return error honestly.';
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, temperature: 0.1, max_tokens: 450, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ task, step: i + 1, page: state }) }] }),
      signal: AbortSignal.timeout(30000)
    });
    if (!resp.ok) throw new Error('Browser AI request failed (' + resp.status + '): ' + (await resp.text()).slice(0, 300));
    const body: any = await resp.json();
    let raw = String(body?.choices?.[0]?.message?.content || '').trim();
    if (raw.startsWith('```')) raw = raw.replace('```json', '').replace('```', '').trim();
    if (raw.endsWith('```')) raw = raw.slice(0, -3).trim();
    let decision: any;
    try { decision = JSON.parse(raw); } catch { throw new Error('Browser AI returned an invalid action plan. Retry the task.'); }
    const action = String(decision.action || '').toLowerCase();
    const reason = String(decision.reason || '').slice(0, 300);
    if (action === 'complete') {
      const finalState = await observe();
      await emitState('complete', 'Task completed after checking ' + finalState.title + ' at ' + finalState.url + '. ' + reason);
      return { success: true, task, steps: [], finalMessage: 'Task completed on ' + finalState.url + '. Evidence: ' + (reason || finalState.text.slice(0, 250)) };
    }
    if (action === 'error') {
      const message = reason || 'The browser agent could not complete this task.';
      emitStep({ stepNumber: stepNum++, action: 'error', description: message, url: page.url(), timestamp: Date.now() });
      return { success: false, task, steps: [], finalMessage: message, error: message };
    }
    if (action === 'navigate') {
      const url = String(decision.url || '');
      if (!(url.startsWith('https://') || url.startsWith('http://'))) throw new Error('Browser agent requested an invalid URL.');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await emitState('navigate', reason || 'Navigated; checking the new page.', url);
      continue;
    }
    if (action === 'wait') {
      await page.waitForTimeout(1200);
      await emitState('wait', reason || 'Waited for the page to update.');
      continue;
    }
    const ref = String(decision.ref || '');
    if (ref[0]?.toLowerCase() !== 'e' || !Number.isInteger(Number(ref.slice(1))) || Number(ref.slice(1)) < 1) throw new Error('Browser agent returned an invalid element reference.');
    const locator = page.locator('[data-agent-ref="' + ref + '"]').first();
    if (!(await locator.count())) { await emitState('wait', 'The element reference changed; refreshing page observation.'); continue; }
    if (action === 'click') {
      await locator.click({ timeout: 10000 });
      await page.waitForTimeout(700);
      await emitState('click', reason || 'Clicked ' + ref + '; verifying page state.', ref);
    } else if (action === 'fill') {
      const text = String(decision.text || '');
      await locator.fill(text, { timeout: 10000 });
      const actual = await locator.inputValue().catch(async () => locator.innerText().catch(() => ''));
      if (actual !== text) throw new Error('Typing verification failed: the field does not contain the requested text.');
      await emitState('type', reason || 'Filled and verified ' + ref + '.', ref, text);
    } else if (action === 'press') {
      const keyName = String(decision.key || 'Enter');
      await locator.press(keyName, { timeout: 10000 });
      await page.waitForTimeout(700);
      await emitState('click', reason || 'Pressed ' + keyName + '; verifying page state.', ref, keyName);
    } else {
      throw new Error('Unsupported browser action: ' + action);
    }
  }
  const finalState = await observe();
  const message = 'Reached the browser step limit without verifying completion. Current page: ' + finalState.title + ' (' + finalState.url + ').';
  emitStep({ stepNumber: stepNum++, action: 'error', description: message, url: page.url(), timestamp: Date.now() });
  return { success: false, task, steps: [], finalMessage: message, error: message };
}
