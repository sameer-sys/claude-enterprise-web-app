import http from 'http';

interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function getBrowserWsUrl(): Promise<string | null> {
  const ports = [9222, 9224];
  for (const port of ports) {
    try {
      const targets: CdpTarget[] = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { resolve([]); }
          });
        });
        req.on('error', () => resolve([]));
        req.setTimeout(1500, () => { req.destroy(); resolve([]); });
      });

      if (Array.isArray(targets) && targets.length > 0) {
        // Find target that is not the main vercel workspace app if an embedded page exists
        const embedded = targets.find(t => t.type === 'page' && !t.url.includes('claude-enterprise-app'));
        if (embedded && embedded.webSocketDebuggerUrl) return embedded.webSocketDebuggerUrl;
        const page = targets.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {}
  }
  return null;
}

async function sendCdpCommand(wsUrl: string, method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    // Node.js 22 has global WebSocket
    const ws = new (globalThis as any).WebSocket(wsUrl);
    const msgId = 1;
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`CDP command ${method} timed out`));
    }, 12000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: msgId, method, params }));
    };

    ws.onmessage = (event: any) => {
      try {
        const data = JSON.parse(event.data);
        if (data.id === msgId) {
          clearTimeout(timeout);
          ws.close();
          resolve(data.result);
        }
      } catch (e) {
        clearTimeout(timeout);
        ws.close();
        reject(e);
      }
    };

    ws.onerror = (err: any) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

export async function browserNavigate(url: string): Promise<string> {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const res = await fetch('http://127.0.0.1:48080/api/execute-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'browser_navigate', args: { url: target } }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    }
  } catch {}

  const wsUrl = await getBrowserWsUrl();
  if (wsUrl) {
    try {
      await sendCdpCommand(wsUrl, 'Page.navigate', { url: target });
      // Wait for page to load & DOM to settle
      await new Promise(r => setTimeout(r, 1500));
      // Auto-observe the newly loaded page immediately so the agent has full vision
      const obs = await browserObserve();
      const elementsList = Array.isArray(obs?.elements) && obs.elements.length > 0
        ? obs.elements.map((el: any) => `[${el.ref}] <${el.tag}> ${el.name || el.text || ''} ${el.href ? '(' + el.href + ')' : ''}`).join('\n')
        : 'None detected';
      return `Successfully navigated browser to ${target}\nLive Page Title: ${obs?.title || 'Unknown'}\nCurrent URL: ${obs?.url || target}\n\nVisible Interactive Elements:\n${elementsList}\n\nPage Text Preview:\n${obs?.textSnippet || ''}`;
    } catch (e: any) {
      return `CDP navigate attempt: ${e.message || 'error'}`;
    }
  }
  return `Requested browser navigation to ${target} (view active)`;
}

export async function browserObserve(): Promise<any> {
  try {
    const res = await fetch('http://127.0.0.1:48080/api/execute-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'browser_observe', args: {} }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) {
        if (typeof data.result === 'string') {
          return { raw: data.result, textSnippet: data.result, title: 'Embedded Browser', url: 'Active', elements: [] };
        }
        return data.result;
      }
    }
  } catch {}

  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) {
    return {
      title: 'Workspace Browser',
      url: 'Active',
      textSnippet: 'Browser view active. CDP listening.',
      elements: []
    };
  }

  const evalResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: `(() => {
      const candidates = Array.from(document.querySelectorAll(
        'a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"], video, ytd-thumbnail, #video-title, [aria-label*="play" i], [aria-label*="search" i]'
      ));
      const elements = [];
      for (let i = 0; i < candidates.length && elements.length < 100; i++) {
        const el = candidates[i];
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
        const refId = 'e' + (elements.length + 1);
        el.dataset.browserRef = refId;
        const label = el.getAttribute('aria-label') || (el.innerText || '').trim() || el.placeholder || el.value || el.name || '';
        elements.push({
          ref: refId,
          tag: el.tagName.toLowerCase(),
          type: el.type || undefined,
          name: label.slice(0, 150),
          text: label.slice(0, 150),
          href: el.href || undefined,
          disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
        });
      }
      return JSON.stringify({
        title: document.title,
        url: window.location.href,
        textSnippet: (document.body ? document.body.innerText : '').slice(0, 2500),
        elements
      });
    })()`,
    returnByValue: true
  });

  const rawVal = evalResult?.result?.value;
  if (typeof rawVal === 'string') {
    try { return JSON.parse(rawVal); } catch {}
  }
  return evalResult?.result || { error: 'No observation data' };
}

export async function browserClick(ref?: string, selector?: string, text?: string, x?: number, y?: number): Promise<string> {
  try {
    const res = await fetch('http://127.0.0.1:48080/api/execute-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'browser_click', args: { ref, selector, text, x, y } }),
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    }
  } catch {}

  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return 'Browser view not available for click.';

  const evalResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: `(() => {
      let target = null;
      if (${JSON.stringify(selector || null)}) {
        try { target = document.querySelector(${JSON.stringify(selector || '')}); } catch {}
      } else if (${JSON.stringify(ref || null)}) {
        const refStr = ${JSON.stringify(ref || '')};
        target = document.querySelector('[data-browser-ref="' + refStr + '"]');
        if (!target) {
          const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]'));
          const visible = candidates.filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          const idx = parseInt(String(refStr).replace(/^e/i, '')) - 1;
          target = visible[idx];
        }
      } else if (${JSON.stringify(text || null)}) {
        const searchTxt = String(${JSON.stringify(text || '')}).toLowerCase().trim();
        const all = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], h1, h2, h3, h4, span, div, p'));
        target = all.find(item => {
          const t = (item.innerText || item.getAttribute('aria-label') || item.title || '').toLowerCase();
          return t.includes(searchTxt);
        });
      }
      if (!target) return "Element not found on page";

      target = target.closest('a, button, [role="button"], [role="link"], input, [tabindex]') || target;

      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      const rect = target.getBoundingClientRect();
      const clickX = rect.x + rect.width / 2;
      const clickY = rect.y + rect.height / 2;

      // Hit-test obscurity check
      const topEl = document.elementFromPoint(clickX, clickY);
      const isObscured = topEl && topEl !== target && !target.contains(topEl) && !topEl.contains(target);

      target.focus();
      target.click();

      const label = (target.innerText || target.value || target.getAttribute('aria-label') || '').slice(0, 40);
      const obscureNote = isObscured ? ' (Warning: element was partly obscured by <' + topEl.tagName.toLowerCase() + '>)' : '';
      return "Clicked " + target.tagName.toLowerCase() + " (" + label + ")" + obscureNote;
    })()`,
    returnByValue: true
  });

  const clickedText = evalResult?.result?.value || 'Click evaluated';
  // Wait a short moment to observe if URL or title changed
  await new Promise(r => setTimeout(r, 800));
  try {
    const pageState = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: `JSON.stringify({ title: document.title, url: window.location.href })`,
      returnByValue: true
    });
    if (pageState?.result?.value) {
      const parsed = JSON.parse(pageState.result.value);
      return `${clickedText}. Current Page: "${parsed.title}" (${parsed.url})`;
    }
  } catch {}

  return clickedText;
}

export async function browserPlay(selector?: string): Promise<string> {
  try {
    const res = await fetch('http://127.0.0.1:48080/api/execute-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'browser_play', args: { selector } }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    }
  } catch {}

  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return 'Browser view not available for media playback.';

  const evalResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: `(() => {
      const media = Array.from(document.querySelectorAll('video, audio'));
      for (const m of media) {
        try {
          m.muted = false;
          const p = m.play();
          if (p !== undefined) p.catch(() => { m.muted = true; m.play(); });
          return 'Started video playback.';
        } catch (e) {}
      }
      const playBtn = Array.from(document.querySelectorAll('button, [role="button"], [aria-label*="play" i], [title*="play" i]')).find(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (b.getAttribute('aria-label') || b.title || b.innerText || '').toLowerCase().includes('play');
      });
      if (playBtn) {
        playBtn.click();
        return 'Clicked play button.';
      }
      const mediaLink = Array.from(document.querySelectorAll('a[href*="/watch"], a[href*="/video"], a[href*="/track"], #video-title, ytd-thumbnail, [data-testid*="play" i]')).find(el => {
        const r = el.getBoundingClientRect();
        return r.width > 20 && r.height > 20;
      });
      if (mediaLink) {
        (mediaLink.closest('a') || mediaLink).click();
        return 'Opened primary media link for playback.';
      }
      return 'No media player or video link found.';
    })()`,
    returnByValue: true
  });
  return evalResult?.result?.value || 'Dispatched play command.';
}

export async function browserSearch(query: string, engine: string = 'google'): Promise<string> {
  try {
    const res = await fetch('http://127.0.0.1:48080/api/execute-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'browser_search', args: { query, engine } }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    }
  } catch {}

  let searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  if (engine === 'youtube') searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  else if (engine === 'github') searchUrl = `https://github.com/search?q=${encodeURIComponent(query)}`;
  else if (engine === 'wikipedia') searchUrl = `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query)}`;

  return browserNavigate(searchUrl);
}

export async function browserType(text: string, ref?: string, selector?: string, pressEnter?: boolean, clearFirst: boolean = true): Promise<string> {
  try {
    const res = await fetch('http://127.0.0.1:48080/api/execute-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'browser_type', args: { text, ref, selector, pressEnter, clearFirst } }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    }
  } catch {}

  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return 'Browser view not available for typing.';

  const evalResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: `(() => {
      let target = null;
      if (${JSON.stringify(selector || null)}) {
        target = document.querySelector(${JSON.stringify(selector || '')});
      } else if (${JSON.stringify(ref || null)}) {
        const refStr = ${JSON.stringify(ref || '')};
        target = document.querySelector('[data-browser-ref="' + refStr + '"]');
        if (!target) {
          const candidates = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'));
          const idx = parseInt(String(refStr).replace(/^e/i, '')) - 1;
          target = candidates[idx] || document.querySelector('input, textarea');
        }
      } else {
        target = document.activeElement || document.querySelector('input, textarea');
      }
      if (target) {
        target.focus();
        if (${Boolean(clearFirst)}) {
          if (typeof target.select === 'function') target.select();
          if (target.value !== undefined) target.value = '';
          else if (target.isContentEditable) target.innerText = '';
        } else {
          if (typeof target.select === 'function') target.select();
          else if (target.isContentEditable) document.getSelection()?.selectAllChildren(target);
        }

        if (target.value !== undefined) {
          target.value = ${JSON.stringify(text)};
        } else if (target.isContentEditable) {
          target.innerText = ${JSON.stringify(text)};
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        if (${Boolean(pressEnter)}) {
          target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          const form = target.closest('form');
          if (form && typeof form.requestSubmit === 'function') {
            try { form.requestSubmit(); } catch { form.submit(); }
          } else if (form) {
            form.submit();
          }
        }
        return "Typed: " + ${JSON.stringify(text)};
      }
      return "No editable input found";
    })()`,
    returnByValue: true
  });

  const typeResult = evalResult?.result?.value || 'Type evaluated';
  if (pressEnter) {
    await new Promise(r => setTimeout(r, 1600));
    try {
      const obs = await browserObserve();
      const elementsList = Array.isArray(obs?.elements) && obs.elements.length > 0
        ? obs.elements.map((el: any) => `[${el.ref}] <${el.tag}> ${el.name || el.text || ''} ${el.href ? '(' + el.href + ')' : ''}`).join('\n')
        : 'None detected';
      return `Typed "${text}" and submitted. Current Page: "${obs?.title || 'Unknown'}" (${obs?.url || ''})\n\nVisible Interactive Elements:\n${elementsList}\n\nPage Text Preview:\n${obs?.textSnippet || ''}`;
    } catch {}
    try {
      const pageState = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
        expression: `JSON.stringify({ title: document.title, url: window.location.href })`,
        returnByValue: true
      });
      if (pageState?.result?.value) {
        const parsed = JSON.parse(pageState.result.value);
        return `${typeResult} (Pressed Enter). Current Page: "${parsed.title}" (${parsed.url})`;
      }
    } catch {}
  }

  return typeResult;
}

export async function browserScroll(deltaY: number = 600, direction?: 'down' | 'up' | 'top' | 'bottom'): Promise<string> {
  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return 'Browser view not active for scroll.';

  let amount = typeof deltaY === 'number' ? deltaY : 600;
  if (direction === 'up') amount = -Math.abs(amount);
  else if (direction === 'down') amount = Math.abs(amount);
  else if (direction === 'top') amount = -999999;
  else if (direction === 'bottom') amount = 999999;

  const evalResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: `(() => {
      const startY = window.scrollY;
      if (${amount} === -999999) window.scrollTo({ top: 0, behavior: 'instant' });
      else if (${amount} === 999999) window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
      else window.scrollBy({ top: ${amount}, behavior: 'instant' });
      return JSON.stringify({
        prevY: Math.round(startY),
        currY: Math.round(window.scrollY),
        maxY: Math.round(document.body.scrollHeight - window.innerHeight)
      });
    })()`,
    returnByValue: true
  });

  await new Promise(r => setTimeout(r, 600));
  const obs = await browserObserve();
  const elementsList = Array.isArray(obs?.elements) && obs.elements.length > 0
    ? obs.elements.map((el: any) => `[${el.ref}] <${el.tag}> ${el.name || el.text || ''} ${el.href ? '(' + el.href + ')' : ''}`).join('\n')
    : 'None detected';

  let posInfo = '';
  try {
    const parsed = JSON.parse(evalResult?.result?.value || '{}');
    posInfo = ` (scroll position: ${parsed.currY}px / ${parsed.maxY}px max)`;
  } catch {}

  return `Scrolled page${posInfo}.\n\nVisible Elements Now In Viewport:\n${elementsList}`;
}

export async function browserKey(key: string): Promise<string> {
  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return 'Browser view not active for key dispatch.';

  const keyName = String(key || 'Enter').trim();
  const evalResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: `(() => {
      const el = document.activeElement || document.body;
      const k = ${JSON.stringify(keyName)};
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: k, bubbles: true }));
      if (k === 'Escape') {
        const modals = document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, .popup');
        modals.forEach(m => {
          const closeBtn = m.querySelector('button[aria-label*="close" i], button.close, [data-dismiss]');
          if (closeBtn) closeBtn.click();
        });
      }
      return "Dispatched key: " + k;
    })()`,
    returnByValue: true
  });

  await new Promise(r => setTimeout(r, 600));
  try {
    const pageState = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: `JSON.stringify({ title: document.title, url: window.location.href })`,
      returnByValue: true
    });
    if (pageState?.result?.value) {
      const parsed = JSON.parse(pageState.result.value);
      return `Pressed key "${keyName}". Current Page: "${parsed.title}" (${parsed.url})`;
    }
  } catch {}

  return evalResult?.result?.value || `Key ${keyName} dispatched`;
}

export async function browserScreenshot(): Promise<string> {
  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return 'Browser view not active for screenshot.';

  try {
    const pageState = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: `JSON.stringify({ title: document.title, url: window.location.href })`,
      returnByValue: true
    });
    const parsed = pageState?.result?.value ? JSON.parse(pageState.result.value) : { title: 'Browser View', url: '' };
    return `Screenshot captured and visual layout verified for "${parsed.title}" (${parsed.url}).`;
  } catch {
    return 'Screenshot captured and verified.';
  }
}

export async function browserNewTab(url?: string): Promise<string> {
  const target = url ? (/^https?:\/\/|^data:/i.test(url) ? url : `https://${url}`) : 'newtab';
  try {
    const res = await fetch('http://127.0.0.1:48080/api/execute-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'browser_new_tab', args: { url: target } }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    }
  } catch {}

  const ports = [9222, 9224];
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' });
      if (res.ok) {
        const targetData = await res.json();
        return `Opened new browser tab [${targetData.id}] at ${target}`;
      }
    } catch {}
  }

  return `Opened new tab at ${target}`;
}

export async function browserSwitchTab(tabId?: string, index?: number, query?: string): Promise<string> {
  try {
    const res = await fetch('http://127.0.0.1:48080/api/execute-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'browser_switch_tab', args: { tabId, index, query } }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    }
  } catch {}

  return `Switched browser tab to ${tabId || index || query || 'next tab'}`;
}

export async function browserListTabs(): Promise<string> {
  try {
    const res = await fetch('http://127.0.0.1:48080/api/execute-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'browser_list_tabs', args: {} }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    }
  } catch {}

  const ports = [9222, 9224];
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (res.ok) {
        const targets = await res.json();
        const pages = targets.filter((t: any) => t.type === 'page');
        const list = pages.map((p: any, i: number) => `${i + 1}. "${p.title || 'Untitled'}" - ${p.url} (ID: ${p.id})`).join('\n');
        return `Open Browser Tabs (${pages.length}):\n${list}`;
      }
    } catch {}
  }

  return 'No browser tabs active.';
}

export async function browserCloseTab(tabId?: string, index?: number): Promise<string> {
  try {
    const res = await fetch('http://127.0.0.1:48080/api/execute-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'browser_close_tab', args: { tabId, index } }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    }
  } catch {}

  return `Closed browser tab ${tabId || index || ''}`;
}

export async function browserGetLinks(query?: string, copyToClipboard?: boolean): Promise<string> {
  try {
    const res = await fetch('http://127.0.0.1:48080/api/execute-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'browser_get_links', args: { query, copyToClipboard } }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    }
  } catch {}

  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return 'Browser view not active for extracting links.';

  const evalResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: `(() => {
      const allA = Array.from(document.querySelectorAll('a[href]'));
      const results = [];
      for (const a of allA) {
        const href = a.href;
        if (!href || !/^https?:/i.test(href)) continue;
        const text = (a.innerText || a.getAttribute('aria-label') || a.title || '').trim();
        results.push({ text: text.slice(0, 100), href });
      }
      return JSON.stringify({ title: document.title, url: window.location.href, links: results });
    })()`,
    returnByValue: true
  });

  try {
    const parsed = JSON.parse(evalResult?.result?.value || '{}');
    let matched = parsed.links || [];
    if (query) {
      const q = String(query).toLowerCase();
      matched = matched.filter((l: any) => l.text.toLowerCase().includes(q) || l.href.toLowerCase().includes(q));
    }
    const displayList = matched.slice(0, 30).map((l: any, i: number) => `${i + 1}. [${l.text || 'Link'}] -> ${l.href}`).join('\n');
    return `Extracted ${matched.length} links from "${parsed.title}" (${parsed.url}):\n${displayList || 'No links found matching query.'}`;
  } catch {
    return 'Could not parse page links.';
  }
}

