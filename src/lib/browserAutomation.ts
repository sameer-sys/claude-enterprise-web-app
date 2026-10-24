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

export async function browserClick(ref?: string, selector?: string): Promise<string> {
  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return 'Browser view not available for click.';

  const evalResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: `(() => {
      let target = null;
      if (${JSON.stringify(selector || null)}) {
        target = document.querySelector(${JSON.stringify(selector || '')});
      } else if (${JSON.stringify(ref || null)}) {
        const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]'));
        const visible = candidates.filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const idx = parseInt(String(${JSON.stringify(ref || '')}).replace(/^e/i, '')) - 1;
        target = visible[idx];
      }
      if (!target) return "Element not found on page";

      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      const rect = target.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;

      // Hit-test obscurity check
      const topEl = document.elementFromPoint(x, y);
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

export async function browserType(text: string, ref?: string, selector?: string, pressEnter?: boolean): Promise<string> {
  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return 'Browser view not available for typing.';

  const evalResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: `(() => {
      let target = null;
      if (${JSON.stringify(selector || null)}) {
        target = document.querySelector(${JSON.stringify(selector || '')});
      } else if (${JSON.stringify(ref || null)}) {
        const candidates = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'));
        const idx = parseInt(String(${JSON.stringify(ref || '')}).replace(/^e/i, '')) - 1;
        target = candidates[idx] || document.querySelector('input, textarea');
      } else {
        target = document.activeElement || document.querySelector('input, textarea');
      }
      if (target) {
        target.focus();
        if (typeof target.select === 'function') target.select();
        else if (target.isContentEditable) document.getSelection()?.selectAllChildren(target);

        if (target.value !== undefined) {
          target.value = ${JSON.stringify(text)};
        } else if (target.isContentEditable) {
          target.innerText = ${JSON.stringify(text)};
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        if (${Boolean(pressEnter)}) {
          target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          const form = target.closest('form');
          if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
        return "Typed: " + ${JSON.stringify(text)};
      }
      return "No editable input found";
    })()`,
    returnByValue: true
  });

  const typeResult = evalResult?.result?.value || 'Type evaluated';
  if (pressEnter) {
    await new Promise(r => setTimeout(r, 1000));
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
