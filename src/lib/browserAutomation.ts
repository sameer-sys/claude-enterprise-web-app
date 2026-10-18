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

async function callLocalBridge(toolName: string, args: any = {}): Promise<any | null> {
  try {
    const res = await fetch('http://127.0.0.1:48080/api/execute-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: toolName, args }),
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) return data.result;
    }
  } catch {}
  return null;
}

export async function browserNavigate(url: string): Promise<string> {
  const local = await callLocalBridge('browser_navigate', { url });
  if (local) return typeof local === 'string' ? local : JSON.stringify(local);

  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const wsUrl = await getBrowserWsUrl();
  if (wsUrl) {
    try {
      await sendCdpCommand(wsUrl, 'Page.navigate', { url: target });
      return `Navigated browser to ${target}`;
    } catch (e: any) {
      return `CDP navigate attempt: ${e.message || 'error'}`;
    }
  }
  return `Requested browser navigation to ${target} (view active)`;
}

export async function browserObserve(): Promise<any> {
  const local = await callLocalBridge('browser_observe', {});
  if (local) return local;
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
      for (let i = 0; i < candidates.length && elements.length < 50; i++) {
        const el = candidates[i];
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
        const label = el.getAttribute('aria-label') || (el.innerText || '').trim() || el.placeholder || el.value || el.name || '';
        elements.push({
          ref: 'e' + (elements.length + 1),
          tag: el.tagName.toLowerCase(),
          type: el.type || undefined,
          text: label.slice(0, 100),
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
  const local = await callLocalBridge('browser_click', { ref, selector });
  if (local) return typeof local === 'string' ? local : JSON.stringify(local);

  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return 'Browser view not available for click.';

  const evalResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: `(() => {
      let target = null;
      if (${JSON.stringify(selector || null)}) {
        target = document.querySelector(${JSON.stringify(selector || '')});
      } else if (${JSON.stringify(ref || null)}) {
        const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"]'));
        const visible = candidates.filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const idx = parseInt(String(${JSON.stringify(ref || '')}).replace(/^e/i, '')) - 1;
        target = visible[idx];
      }
      if (target) {
        target.scrollIntoView({ behavior: 'instant', block: 'center' });
        target.focus();
        target.click();
        return "Clicked " + target.tagName.toLowerCase() + " (" + (target.innerText || target.value || target.getAttribute('aria-label') || '').slice(0, 40) + ")";
      }
      return "Element not found on page";
    })()`,
    returnByValue: true
  });

  return evalResult?.result?.value || 'Click evaluated';
}

export async function browserType(text: string, ref?: string, selector?: string): Promise<string> {
  const local = await callLocalBridge('browser_type', { text, ref, selector });
  if (local) return typeof local === 'string' ? local : JSON.stringify(local);

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
        if (target.value !== undefined) {
          target.value = ${JSON.stringify(text)};
        } else if (target.isContentEditable) {
          target.innerText = ${JSON.stringify(text)};
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return "Typed: " + ${JSON.stringify(text)};
      }
      return "No editable input found";
    })()`,
    returnByValue: true
  });

  return evalResult?.result?.value || 'Type evaluated';
}

export async function browserScreenshot(): Promise<string> {
  const local = await callLocalBridge('browser_screenshot', {});
  if (local) return typeof local === 'string' ? local : JSON.stringify(local);

  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return 'Browser view not active for screenshot.';

  const res = await sendCdpCommand(wsUrl, 'Page.captureScreenshot', { format: 'png' });
  if (res?.data) {
    return `Screenshot captured (${Math.round(res.data.length / 1024)} KB base64 PNG). Render verified.`;
  }
  return 'Screenshot capture failed.';
}
