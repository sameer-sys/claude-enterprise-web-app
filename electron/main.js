const { app, BrowserWindow, shell, Menu, MenuItem, Tray, nativeImage, ipcMain, dialog, globalShortcut, Notification, powerSaveBlocker, session, WebContentsView, BrowserView } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { claudeMcpManager } = require("./claude-desktop-mcp.cjs");
const { LocalBridgeServer } = require("./local-bridge.cjs");

// Enable remote debugging port for CDP / Playwright AI agent control
app.commandLine.appendSwitch("remote-debugging-port", "9224");
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");

const crashLogPath = path.join(app.getPath("userData"), "crash.log");

process.on("uncaughtException", (err) => {
  try { fs.appendFileSync(crashLogPath, "UNCAUGHT: " + (err?.stack || err) + "\n"); } catch(e){}
});
process.on("unhandledRejection", (reason) => {
  try { fs.appendFileSync(crashLogPath, "REJECTION: " + String(reason) + "\n"); } catch(e){}
});
app.on("before-quit", () => {
  try { fs.appendFileSync(crashLogPath, "app before-quit fired!\n"); } catch(e){}
});

const APP_URL = "https://claude-enterprise-app.vercel.app";
const isDev = process.argv.includes("--dev");
const LOAD_URL = isDev ? "http://localhost:3000" : APP_URL;

let mainWindow = null;
let tray = null;
let browserViewInstance = null;
let currentBrowserUrl = "https://github.com";
let localBridge = null;
let browserTabManager = null;

const windowStateFile = path.join(app.getPath("userData"), "window-state.json");
function loadWindowState() {
  try {
    if (fs.existsSync(windowStateFile)) {
      return JSON.parse(fs.readFileSync(windowStateFile, "utf8"));
    }
  } catch (e) {}
  return { width: 1400, height: 900, isMaximized: false };
}

let saveWindowStateTimer = null;
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const isMaximized = mainWindow.isMaximized();
    const bounds = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    fs.writeFileSync(windowStateFile, JSON.stringify({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized
    }));
  } catch (e) {}
}

function debouncedSaveWindowState() {
  if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer);
  saveWindowStateTimer = setTimeout(saveWindowState, 500);
}


function createWindow() {
  const savedState = loadWindowState();
  mainWindow = new BrowserWindow({
    x: savedState.x,
    y: savedState.y,
    width: savedState.width || 1400,
    height: savedState.height || 900,
    minWidth: 900,
    minHeight: 600,
    title: "Sameer AI Workspace",
    backgroundColor: "#1c1b18",
    frame: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.loadURL(LOAD_URL);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    try { fs.appendFileSync(crashLogPath, `FAIL_LOAD: ${code} ${desc}\n`); } catch(e){}
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on("resize", () => {
    mainWindow?.webContents.send("openwork:browser:bounds-invalidated");
    debouncedSaveWindowState();
  });
  mainWindow.on("move", () => {
    debouncedSaveWindowState();
  });
  mainWindow.on("close", () => {
    saveWindowState();
  });

  mainWindow.webContents.on("context-menu", (_e, params) => {
    const menu = new Menu();
    if (params.isEditable) {
      menu.append(new MenuItem({ role: "undo" }));
      menu.append(new MenuItem({ role: "redo" }));
      menu.append(new MenuItem({ type: "separator" }));
      menu.append(new MenuItem({ role: "cut" }));
      menu.append(new MenuItem({ role: "copy" }));
      menu.append(new MenuItem({ role: "paste" }));
      menu.append(new MenuItem({ role: "selectAll" }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: "copy" }));
      menu.append(new MenuItem({ role: "selectAll" }));
    } else {
      menu.append(new MenuItem({ label: "Reload", click: () => mainWindow?.reload() }));
      menu.append(new MenuItem({ type: "separator" }));
      menu.append(new MenuItem({ label: "Inspect Element", click: () => mainWindow?.webContents.inspectElement(params.x, params.y) }));
    }
    menu.popup({ window: mainWindow, x: params.x, y: params.y });
  });

  // Strip X-Frame-Options and Content-Security-Policy frame-ancestors
  // so the embedded Browser panel loads YouTube, GitHub, Instagram, etc. without a white screen!
  mainWindow.webContents.session.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
    try {
      const responseHeaders = { ...details.responseHeaders };
      for (const key of Object.keys(responseHeaders)) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'x-frame-options') {
          delete responseHeaders[key];
        }
        if (lowerKey === 'content-security-policy') {
          const val = responseHeaders[key];
          if (Array.isArray(val)) {
            responseHeaders[key] = val.map((csp) => typeof csp === 'string' ? csp.replace(/frame-ancestors[^;]+;?/gi, '') : csp);
          } else if (typeof val === 'string') {
            responseHeaders[key] = val.replace(/frame-ancestors[^;]+;?/gi, '');
          }
        }
      }
      callback({ responseHeaders });
    } catch (e) {
      callback({ responseHeaders: details.responseHeaders });
    }
  });

  // OpenWork Native Multi-Tab Browser Control (Embedded WebContentsView / BrowserView)
  class BrowserTabManager {
    constructor(getMainWindow) {
      this.getMainWindow = getMainWindow;
      this.tabs = [];
      this.activeTabId = null;
      this.lastBounds = null;
      this.isAttached = false;
    }

    createTab(url = "https://github.com", makeActive = true) {
      const tabId = "tab_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      const targetUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;

      const viewOptions = {
        webPreferences: {
          partition: "persist:sameer-browser",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
        },
      };

      let view;
      if (typeof WebContentsView !== "undefined") {
        view = new WebContentsView(viewOptions);
      } else {
        view = new BrowserView(viewOptions);
      }

      const contents = view.webContents;

      contents.on("did-navigate", (_event, navUrl) => {
        currentBrowserUrl = navUrl;
        const tab = this.tabs.find((t) => t.id === tabId);
        if (tab) {
          tab.url = navUrl;
          tab.title = contents.getTitle() || navUrl;
          this.notifyState();
        }
      });

      contents.on("did-navigate-in-page", (_event, navUrl) => {
        currentBrowserUrl = navUrl;
        const tab = this.tabs.find((t) => t.id === tabId);
        if (tab) {
          tab.url = navUrl;
          tab.title = contents.getTitle() || navUrl;
          this.notifyState();
        }
      });

      contents.on("page-title-updated", (_event, title) => {
        const tab = this.tabs.find((t) => t.id === tabId);
        if (tab) {
          tab.title = title;
          this.notifyState();
        }
      });

      contents.setWindowOpenHandler(({ url: popupUrl }) => {
        if (/^https?:\/\//i.test(popupUrl)) {
          this.createTab(popupUrl, true);
        }
        return { action: "deny" };
      });

      contents.loadURL(targetUrl);

      const tab = {
        id: tabId,
        view,
        url: targetUrl,
        title: "New Tab",
        createdAt: Date.now(),
      };
      this.tabs.push(tab);

      if (makeActive || !this.activeTabId) {
        this.selectTab(tabId);
      } else {
        this.notifyState();
      }

      return tab;
    }

    selectTab(tabId) {
      const tab = this.tabs.find((t) => t.id === tabId);
      if (!tab) return null;

      const mainWindow = this.getMainWindow();
      const prevTab = this.tabs.find((t) => t.id === this.activeTabId);

      if (mainWindow && !mainWindow.isDestroyed() && prevTab && prevTab.view && prevTab.view !== tab.view) {
        if (typeof WebContentsView !== "undefined" && mainWindow.contentView) {
          if (mainWindow.contentView.children.includes(prevTab.view)) {
            mainWindow.contentView.removeChildView(prevTab.view);
          }
        } else if (mainWindow.removeBrowserView) {
          mainWindow.removeBrowserView(prevTab.view);
        }
        if (prevTab.view.setVisible) prevTab.view.setVisible(false);
      }

      this.activeTabId = tabId;
      currentBrowserUrl = tab.url;

      if (this.isAttached && this.lastBounds) {
        this.attachActiveView();
      }

      this.notifyState();
      return tab;
    }

    closeTab(tabId) {
      const index = this.tabs.findIndex((t) => t.id === tabId);
      if (index === -1) return false;

      const tab = this.tabs[index];
      const mainWindow = this.getMainWindow();

      if (mainWindow && !mainWindow.isDestroyed() && tab.view) {
        if (typeof WebContentsView !== "undefined" && mainWindow.contentView) {
          if (mainWindow.contentView.children.includes(tab.view)) {
            mainWindow.contentView.removeChildView(tab.view);
          }
        } else if (mainWindow.removeBrowserView) {
          mainWindow.removeBrowserView(tab.view);
        }
      }

      try {
        if (!tab.view.webContents.isDestroyed()) {
          tab.view.webContents.close();
        }
      } catch (e) {}

      this.tabs.splice(index, 1);

      if (this.activeTabId === tabId) {
        if (this.tabs.length > 0) {
          const nextIndex = Math.min(index, this.tabs.length - 1);
          this.selectTab(this.tabs[nextIndex].id);
        } else {
          this.activeTabId = null;
          this.hide();
        }
      }

      this.notifyState();
      return true;
    }

    attachActiveView() {
      const tab = this.getActiveTab();
      if (!tab) return false;

      const mainWindow = this.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed() || !this.lastBounds) return false;

      const zoomFactor = mainWindow.webContents.getZoomFactor() || 1;
      const x = Math.round(this.lastBounds.x * zoomFactor);
      const y = Math.round(this.lastBounds.y * zoomFactor);
      const width = Math.round(this.lastBounds.width * zoomFactor);
      const height = Math.round(this.lastBounds.height * zoomFactor);

      if (typeof WebContentsView !== "undefined" && mainWindow.contentView) {
        if (!mainWindow.contentView.children.includes(tab.view)) {
          mainWindow.contentView.addChildView(tab.view);
        }
        tab.view.setBounds({ x, y, width, height });
        if (tab.view.setVisible) tab.view.setVisible(true);
      } else if (mainWindow.setBrowserView) {
        mainWindow.setBrowserView(tab.view);
        tab.view.setBounds({ x, y, width, height });
        tab.view.setAutoResize({ width: true, height: true });
      }

      this.isAttached = true;
      return true;
    }

    show(bounds) {
      this.lastBounds = bounds;
      this.isAttached = true;
      if (this.tabs.length === 0) {
        this.createTab(currentBrowserUrl || "https://github.com", true);
      } else {
        this.attachActiveView();
      }
      return true;
    }

    hide() {
      this.isAttached = false;
      const mainWindow = this.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return false;

      for (const tab of this.tabs) {
        if (typeof WebContentsView !== "undefined" && mainWindow.contentView) {
          if (mainWindow.contentView.children.includes(tab.view)) {
            mainWindow.contentView.removeChildView(tab.view);
          }
        } else if (mainWindow.removeBrowserView) {
          mainWindow.removeBrowserView(tab.view);
        }
        if (tab.view.setVisible) tab.view.setVisible(false);
      }
      return true;
    }

    setBounds(bounds) {
      this.lastBounds = bounds;
      if (this.isAttached) {
        this.attachActiveView();
      }
      return true;
    }

    getActiveTab() {
      return this.tabs.find((t) => t.id === this.activeTabId) || this.tabs[0] || null;
    }

    listTabs() {
      return this.tabs.map((t) => ({
        id: t.id,
        tabId: t.id,
        url: !t.view.webContents.isDestroyed() ? t.view.webContents.getURL() : t.url,
        title: !t.view.webContents.isDestroyed() ? t.view.webContents.getTitle() : t.title,
        active: t.id === this.activeTabId,
      }));
    }

    notifyState() {
      const mainWindow = this.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;

      const tabsData = this.listTabs();
      const active = this.getActiveTab();
      mainWindow.webContents.send("openwork:browser:tabs-updated", {
        tabs: tabsData,
        activeTabId: this.activeTabId,
        url: active ? active.url : "",
        title: active ? active.title : "",
      });
      mainWindow.webContents.send("openwork:browser:navigated", {
        url: active ? active.url : "",
        title: active ? active.title : "",
        canGoBack: active && !active.view.webContents.isDestroyed() ? active.view.webContents.canGoBack() : false,
        canGoForward: active && !active.view.webContents.isDestroyed() ? active.view.webContents.canGoForward() : false,
      });
    }
  }

  browserTabManager = new BrowserTabManager(() => mainWindow);
  function getOrCreateBrowserView() {
    let active = browserTabManager.getActiveTab();
    if (!active) {
      active = browserTabManager.createTab(currentBrowserUrl || "https://github.com", true);
    }
    return active.view;
  }

  // Register OpenWork IPC Handlers
  ipcMain.removeHandler("openwork:browser:show");
  ipcMain.handle("openwork:browser:show", (_event, bounds) => {
    return browserTabManager.show(bounds);
  });

  ipcMain.removeHandler("openwork:browser:hide");
  ipcMain.handle("openwork:browser:hide", () => {
    return browserTabManager.hide();
  });

  ipcMain.removeHandler("openwork:browser:bounds");
  ipcMain.handle("openwork:browser:bounds", (_event, bounds) => {
    return browserTabManager.setBounds(bounds);
  });

  ipcMain.removeHandler("openwork:browser:navigate");
  ipcMain.handle("openwork:browser:navigate", (_event, url) => {
    let active = browserTabManager.getActiveTab();
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    currentBrowserUrl = target;
    if (!active) {
      active = browserTabManager.createTab(target, true);
      return { success: true, url: target, tabId: active.id };
    }
    active.url = target;
    active.view.webContents.loadURL(target);
    return { success: true, url: target, tabId: active.id };
  });

  ipcMain.removeHandler("openwork:browser:createTab");
  ipcMain.handle("openwork:browser:createTab", (_event, url) => {
    const tab = browserTabManager.createTab(url || "https://www.google.com", true);
    return { success: true, tabId: tab.id, url: tab.url, title: tab.title };
  });

  ipcMain.removeHandler("openwork:browser:newTab");
  ipcMain.handle("openwork:browser:newTab", (_event, url) => {
    const tab = browserTabManager.createTab(url || "https://www.google.com", true);
    return { success: true, tabId: tab.id, url: tab.url, title: tab.title };
  });

  ipcMain.removeHandler("openwork:browser:selectTab");
  ipcMain.handle("openwork:browser:selectTab", (_event, tabId) => {
    const tab = browserTabManager.selectTab(tabId);
    return { success: Boolean(tab), tabId, url: tab?.url, title: tab?.title };
  });

  ipcMain.removeHandler("openwork:browser:switchTab");
  ipcMain.handle("openwork:browser:switchTab", (_event, tabId) => {
    const tab = browserTabManager.selectTab(tabId);
    return { success: Boolean(tab), tabId, url: tab?.url, title: tab?.title };
  });

  ipcMain.removeHandler("openwork:browser:closeTab");
  ipcMain.handle("openwork:browser:closeTab", (_event, tabId) => {
    return browserTabManager.closeTab(tabId);
  });

  ipcMain.removeHandler("openwork:browser:listTabs");
  ipcMain.handle("openwork:browser:listTabs", () => {
    return browserTabManager.listTabs();
  });

  ipcMain.removeHandler("openwork:browser:back");
  ipcMain.handle("openwork:browser:back", () => {
    const active = browserTabManager.getActiveTab();
    if (active && !active.view.webContents.isDestroyed()) {
      if (active.view.webContents.canGoBack()) active.view.webContents.goBack();
    }
    return true;
  });

  ipcMain.removeHandler("openwork:browser:forward");
  ipcMain.handle("openwork:browser:forward", () => {
    const active = browserTabManager.getActiveTab();
    if (active && !active.view.webContents.isDestroyed()) {
      if (active.view.webContents.canGoForward()) active.view.webContents.goForward();
    }
    return true;
  });

  ipcMain.removeHandler("openwork:browser:reload");
  ipcMain.handle("openwork:browser:reload", () => {
    const active = browserTabManager.getActiveTab();
    if (active && !active.view.webContents.isDestroyed()) {
      active.view.webContents.reload();
    }
    return true;
  });

  ipcMain.removeHandler("openwork:browser:state");
  ipcMain.handle("openwork:browser:state", () => {
    const active = browserTabManager.getActiveTab();
    if (!active || active.view.webContents.isDestroyed()) {
      return { isAttached: false, url: currentBrowserUrl, title: "", tabs: [] };
    }
    const contents = active.view.webContents;
    return {
      isAttached: browserTabManager.isAttached,
      url: contents.getURL() || active.url || currentBrowserUrl,
      title: contents.getTitle(),
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward(),
      isLoading: contents.isLoading(),
      activeTabId: active.id,
      tabs: browserTabManager.listTabs(),
    };
  });

  // WebMCP Browser Automation: Observe, Click, Type, Screenshot, GetLinks
  ipcMain.removeHandler("openwork:browser:observe");
  ipcMain.handle("openwork:browser:observe", async () => {
    const active = browserTabManager.getActiveTab();
    if (!active || active.view.webContents.isDestroyed()) {
      return { success: false, error: "Browser view not active or open" };
    }
    try {
      const contents = active.view.webContents;
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
            type: el.type || undefined,
            name: label.slice(0, 150),
            href: el.href || undefined,
            disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          });
        }
        return {
          title: document.title,
          url: window.location.href,
          textSnippet: (document.body ? document.body.innerText : '').slice(0, 4000),
          elements,
        };
      })()`);
      return { success: true, ...observation };
    } catch (e) {
      return { success: false, error: e?.message || "Failed to observe browser page" };
    }
  });

  ipcMain.removeHandler("openwork:browser:click");
  ipcMain.handle("openwork:browser:click", async (_event, params = {}) => {
    const active = browserTabManager.getActiveTab();
    if (!active || active.view.webContents.isDestroyed()) {
      return { success: false, error: "Browser view not active" };
    }
    try {
      const contents = active.view.webContents;
      const targetRef = params.ref || null;
      const selector = params.selector || null;
      const res = await contents.executeJavaScript(`(() => {
        let el = null;
        if (${JSON.stringify(selector)}) {
          el = document.querySelector(${JSON.stringify(selector)});
        } else if (${JSON.stringify(targetRef)}) {
          const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"]'));
          const visible = candidates.filter(item => {
            const r = item.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          const idx = parseInt(String(${JSON.stringify(targetRef)}).replace(/^e/i, '')) - 1;
          el = visible[idx];
        }
        if (el) {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          el.focus();
          el.click();
          return { success: true, clicked: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 60) };
        }
        return { success: false, error: "Element not found" };
      })()`);
      return res;
    } catch (e) {
      return { success: false, error: e?.message || "Click failed" };
    }
  });

  ipcMain.removeHandler("openwork:browser:type");
  ipcMain.handle("openwork:browser:type", async (_event, params = {}) => {
    const active = browserTabManager.getActiveTab();
    if (!active || active.view.webContents.isDestroyed()) {
      return { success: false, error: "Browser view not active" };
    }
    try {
      const contents = active.view.webContents;
      const targetRef = params.ref || null;
      const selector = params.selector || null;
      const text = params.text || "";
      const res = await contents.executeJavaScript(`(() => {
        let el = null;
        if (${JSON.stringify(selector)}) {
          el = document.querySelector(${JSON.stringify(selector)});
        } else if (${JSON.stringify(targetRef)}) {
          const candidates = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'));
          const idx = parseInt(String(${JSON.stringify(targetRef)}).replace(/^e/i, '')) - 1;
          el = candidates[idx] || document.querySelector('input, textarea');
        } else {
          el = document.activeElement || document.querySelector('input, textarea');
        }
        if (el) {
          el.focus();
          if (el.value !== undefined) {
            el.value = ${JSON.stringify(text)};
          } else if (el.isContentEditable) {
            el.innerText = ${JSON.stringify(text)};
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, typed: ${JSON.stringify(text)} };
        }
        return { success: false, error: "No input element found to type into" };
      })()`);
      return res;
    } catch (e) {
      return { success: false, error: e?.message || "Type failed" };
    }
  });

  ipcMain.removeHandler("openwork:browser:screenshot");
  ipcMain.handle("openwork:browser:screenshot", async () => {
    const active = browserTabManager.getActiveTab();
    if (!active || active.view.webContents.isDestroyed()) {
      return { success: false, error: "Browser view not active" };
    }
    try {
      const image = await active.view.webContents.capturePage();
      return { success: true, dataUrl: image.toDataURL() };
    } catch (e) {
      return { success: false, error: e?.message || "Screenshot failed" };
    }
  });

  ipcMain.removeHandler("openwork:browser:getLinks");
  ipcMain.handle("openwork:browser:getLinks", async (_event, params = {}) => {
    const active = browserTabManager.getActiveTab();
    if (!active || active.view.webContents.isDestroyed()) {
      return { success: false, error: "No active browser tab" };
    }
    try {
      const contents = active.view.webContents;
      const res = await contents.executeJavaScript(`(() => {
        const allA = Array.from(document.querySelectorAll('a[href]'));
        const results = [];
        for (const a of allA) {
          const href = a.href;
          if (!href || !/^https?:/i.test(href)) continue;
          const text = (a.innerText || a.getAttribute('aria-label') || a.title || '').trim();
          results.push({ text: text.slice(0, 100), href });
        }
        return { title: document.title, url: window.location.href, links: results };
      })()`);

      let matched = res.links;
      if (params.query) {
        const q = String(params.query).toLowerCase();
        matched = res.links.filter(l => l.text.toLowerCase().includes(q) || l.href.toLowerCase().includes(q));
      }
      if (params.copyToClipboard !== false && matched.length > 0) {
        const { clipboard } = require('electron');
        clipboard.writeText(matched[0].href);
      }
      return { success: true, ...res, links: matched, topCopied: matched[0]?.href };
    } catch (e) {
      return { success: false, error: e?.message || "Failed to extract links" };
    }
  });

  // Claude Desktop Local MCP IPC Handlers
  ipcMain.removeHandler("openwork:mcp:list-claude-desktop");
  ipcMain.handle("openwork:mcp:list-claude-desktop", async () => {
    try {
      const tools = await claudeMcpManager.listAllTools();
      return { success: true, tools };
    } catch (e) {
      return { success: false, error: e?.message || "Failed to list Claude Desktop MCP tools", tools: [] };
    }
  });

  ipcMain.removeHandler("openwork:mcp:call-claude-desktop");
  ipcMain.handle("openwork:mcp:call-claude-desktop", async (_event, { serverName, toolName, args }) => {
    try {
      const result = await claudeMcpManager.callTool(serverName, toolName, args);
      return { success: true, result };
    } catch (e) {
      return { success: false, error: e?.message || "Failed to call Claude Desktop MCP tool" };
    }
  });

  // Local Bridge Native IPC (Browser, Terminal, Filesystem, Claude Desktop MCP)
  ipcMain.removeHandler("openwork:local:execute-tool");
  ipcMain.handle("openwork:local:execute-tool", async (_event, { name, args }) => {
    if (!localBridge) return { success: false, error: "Local bridge not initialized" };
    try {
      const result = await localBridge.executeTool(name, args || {});
      return { success: true, result };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.removeHandler("openwork:local:get-tools");
  ipcMain.handle("openwork:local:get-tools", async () => {
    try {
      const claudeTools = await claudeMcpManager.listAllTools();
      return { success: true, tools: claudeTools };
    } catch (e) {
      return { success: false, error: e?.message || String(e), tools: [] };
    }
  });

  // Open external links in real browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      const appOrigin = new URL(APP_URL).origin;
      const localhostAllowed = isDev && target.origin === "http://localhost:3000";
      if (target.origin === appOrigin || localhostAllowed) {
        return { action: "allow" };
      }
      if (target.protocol === "https:" || target.protocol === "http:") {
        shell.openExternal(target.toString());
      }
      return { action: "deny" };
    } catch {
      return { action: "deny" };
    }
  });

  mainWindow.on("close", (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// System Tray
function createTray() {
  try {
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 });
    tray = new Tray(trayIcon);
    tray.setToolTip("Sameer AI Workspace");
    const menu = Menu.buildFromTemplate([
      { label: "Open Sameer AI Workspace", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { label: "New Chat", click: () => { mainWindow?.show(); mainWindow?.webContents.executeJavaScript("window.__newChat && window.__newChat()"); } },
      { type: "separator" },
      { label: "Quit", click: () => { tray = null; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on("double-click", () => { mainWindow?.show(); mainWindow?.focus(); });
  } catch (e) { /* icon not found — skip tray */ }
}

// File System IPC
ipcMain.handle("open-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Text & Code Files", extensions: ["txt","md","js","ts","tsx","jsx","py","json","html","css","xml","yaml","yml","csv","sh","bat","env","toml","ini","sql","rs","go","cpp","c","h","php","rb","swift","kt","dart","vue","svelte"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return { path: filePath, name: path.basename(filePath), content };
  } catch (e) { return null; }
});

ipcMain.handle("save-file", async (event, { filePath, content }) => {
  try {
    if (!filePath) {
      const result = await dialog.showSaveDialog(mainWindow, { defaultPath: "untitled.txt" });
      if (result.canceled) return null;
      filePath = result.filePath;
    }
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  } catch (e) { return null; }
});

ipcMain.handle("new-file", async () => {
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: "untitled.txt" });
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, "", "utf-8");
  return { path: result.filePath, name: path.basename(result.filePath), content: "" };
});

ipcMain.handle("get-version", () => app.getVersion());

let blockerId = null;
ipcMain.handle("start-automation", () => {
  if (blockerId === null) {
    blockerId = powerSaveBlocker.start("prevent-app-suspension");
  }
  return true;
});

ipcMain.handle("stop-automation", () => {
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
  return false;
});

ipcMain.handle("show-notification", (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});

// Native code execution for desktop Code Runner.
ipcMain.handle("execute-code", async (event, { code, language = "python" }) => {
  if (typeof code !== "string" || !code.trim()) {
    return { success: false, stdout: "", stderr: "No code supplied.", exitCode: 1, executionTimeMs: 0 };
  }
  const startTime = Date.now();
  const safeLanguage = String(language || "python").toLowerCase();
  const randId = Math.random().toString(36).slice(2, 10);
  const tempDir = app.getPath("temp");
  let tempFilePath = null;
  let cmd = "";

  try {
    if (safeLanguage === "python" || safeLanguage === "py") {
      tempFilePath = path.join(tempDir, "sameer_runner_" + randId + ".py");
      fs.writeFileSync(tempFilePath, code, "utf8");
      cmd = `python "${tempFilePath}"`;
    } else if (safeLanguage === "javascript" || safeLanguage === "js" || safeLanguage === "node") {
      tempFilePath = path.join(tempDir, "sameer_runner_" + randId + ".js");
      fs.writeFileSync(tempFilePath, code, "utf8");
      cmd = `node "${tempFilePath}"`;
    } else if (safeLanguage === "powershell" || safeLanguage === "ps1") {
      tempFilePath = path.join(tempDir, "sameer_runner_" + randId + ".ps1");
      fs.writeFileSync(tempFilePath, code, "utf8");
      cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${tempFilePath}"`;
    } else if (safeLanguage === "cmd" || safeLanguage === "bash" || safeLanguage === "sh") {
      cmd = code;
    } else {
      return { success: false, stdout: "", stderr: "Unsupported language for native execution: " + safeLanguage, exitCode: 1, executionTimeMs: Date.now() - startTime };
    }

    const workspaceDir = path.join(os.homedir(), "sameer workspace");
    const nodeModulesDir = path.join(workspaceDir, "node_modules");
    const nodePath = process.env.NODE_PATH ? `${process.env.NODE_PATH};${nodeModulesDir}` : nodeModulesDir;

    const result = await new Promise((resolve) => {
      const { exec } = require("child_process");
      exec(cmd, {
        cwd: workspaceDir,
        timeout: 45000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: false,
        env: { ...process.env, PYTHONUNBUFFERED: "1", NODE_PATH: nodePath }
      }, (error, stdout, stderr) => {
        resolve({
          success: !error,
          stdout: stdout || "",
          stderr: stderr || (error?.message || ""),
          exitCode: error?.code || 0,
          executionTimeMs: Date.now() - startTime,
          error: error?.message
        });
      });
    });
    return result;
  } finally {
    if (tempFilePath) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
  }
});

// Launch Real External Chrome Browser
ipcMain.handle("launch-external-browser", async () => {
  try {
    const { spawn } = require("child_process");
    const browserDir = path.join(os.homedir(), "sameer workspace", "browser");
    const script = path.join(browserDir, "browser_start.mjs");
    const child = spawn("node", [script], {
      cwd: browserDir,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

// Automatic Native In-App Updater & Restart
ipcMain.handle("restart-to-update", async (event, { downloadUrl } = {}) => {
  try {
    const https = require("https");
    const { spawn } = require("child_process");
    const targetUrl = downloadUrl || "https://github.com/sameer-sys/claude-enterprise-desktop-app/releases/latest/download/Sameer.AI.Workspace.Setup.1.0.0.exe";
    const tempExe = path.join(app.getPath("temp"), `Sameer-AI-Workspace-Update-${Date.now()}.exe`);
    
    const fileStream = fs.createWriteStream(tempExe);
    
    const download = (url) => new Promise((resolve, reject) => {
      https.get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return download(response.headers.location).then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        }
        response.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close();
          resolve(tempExe);
        });
      }).on("error", (err) => {
        try { fs.unlinkSync(tempExe); } catch (e) {}
        reject(err);
      });
    });

    await download(targetUrl);

    // Launch installer and cleanly exit current process
    const child = spawn(tempExe, [], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    app.quit();
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

// OpenWork Approvals IPC Handlers
ipcMain.handle("openwork:approval:respond", async (_event, { id, approved }) => {
  if (localBridge && localBridge.approvals) {
    return localBridge.approvals.resolve(id, approved);
  }
  return { success: false, error: "Approvals manager not available" };
});

ipcMain.handle("openwork:approval:list", async () => {
  if (localBridge && localBridge.approvals) {
    return localBridge.approvals.getPendingList();
  }
  return [];
});

// OpenWork Interactive Terminal IPC Handlers
ipcMain.handle("openwork:terminal:spawn", async (_event, { id, shell }) => {
  if (localBridge && localBridge.terminal) {
    return localBridge.terminal.spawnInteractive(id, shell);
  }
  return { success: false, error: "Terminal manager not available" };
});

ipcMain.handle("openwork:terminal:write", async (_event, { id, input }) => {
  if (localBridge && localBridge.terminal) {
    return localBridge.terminal.write(id, input);
  }
  return { success: false, error: "Terminal manager not available" };
});

ipcMain.handle("openwork:terminal:read", async (_event, { id, clear }) => {
  if (localBridge && localBridge.terminal) {
    return localBridge.terminal.read(id, clear);
  }
  return { success: false, error: "Terminal manager not available", buffer: "" };
});

ipcMain.handle("openwork:terminal:kill", async (_event, { id }) => {
  if (localBridge && localBridge.terminal) {
    return localBridge.terminal.kill(id);
  }
  return { success: false, error: "Terminal manager not available" };
});

// OpenWork Embedded SQLite Database IPC Handlers
ipcMain.handle("openwork:db:get-sessions", async () => {
  if (localBridge && localBridge.db) {
    return localBridge.db.getSessions();
  }
  return [];
});

ipcMain.handle("openwork:db:save-session", async (_event, session) => {
  if (localBridge && localBridge.db) {
    localBridge.db.saveSession(session);
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle("openwork:db:delete-session", async (_event, id) => {
  if (localBridge && localBridge.db) {
    localBridge.db.deleteSession(id);
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle("openwork:db:get-groups", async () => {
  if (localBridge && localBridge.db) {
    return localBridge.db.getGroups();
  }
  return [];
});

ipcMain.handle("openwork:db:save-group", async (_event, group) => {
  if (localBridge && localBridge.db) {
    localBridge.db.saveGroup(group);
    return { success: true };
  }
  return { success: false };
});

// App menu
function buildMenu() {
  const template = [
    { label: "Sameer AI Workspace", submenu: [
      { label: "About", role: "about" },
      { type: "separator" },
      { label: "Check for Updates...", click: () => shell.openExternal(APP_URL) },
      { type: "separator" },
      { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => { tray = null; app.quit(); } },
    ]},
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" },
      { role: "selectAll" },
    ]},
    { label: "View", submenu: [
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => mainWindow?.reload() },
      { label: "Hard Reload", accelerator: "CmdOrCtrl+Shift+R", click: () => mainWindow?.webContents.reloadIgnoringCache() },
      { type: "separator" },
      { role: "togglefullscreen" },
      { label: "Dev Tools", accelerator: "F12", click: () => mainWindow?.webContents.toggleDevTools() },
      { type: "separator" },
      { label: "Zoom In", accelerator: "CmdOrCtrl+=", role: "zoomIn" },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-", role: "zoomOut" },
      { label: "Reset Zoom", accelerator: "CmdOrCtrl+0", role: "resetZoom" },
    ]},
    { label: "Window", submenu: [
      { role: "minimize" },
      { label: "Hide to Tray", click: () => mainWindow?.hide() },
      { type: "separator" },
      { label: "Bring All to Front", role: "front" },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Media, Clipboard & Notification Permissions
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'openExternal'];
    callback(allowed.includes(permission));
  });

  try { fs.appendFileSync(crashLogPath, "whenReady fired\n"); } catch(e){}
  buildMenu();
  try { fs.appendFileSync(crashLogPath, "buildMenu done\n"); } catch(e){}
  createWindow();
  try { fs.appendFileSync(crashLogPath, "createWindow done\n"); } catch(e){}
  createTray();
  try { fs.appendFileSync(crashLogPath, "createTray done\n"); } catch(e){}

  // Initialize OpenWork Local Bridge Server on 127.0.0.1:48080
  try {
    localBridge = new LocalBridgeServer({
      getMainWindow: () => mainWindow,
      getBrowserView: () => browserTabManager.getActiveTab()?.view,
      tabManager: browserTabManager,
      claudeMcpManager,
      sidecarPath: path.join(__dirname, "../openwork-core/sidecars/opencode.exe"),
    });
    localBridge.start(48080);
    try { fs.appendFileSync(crashLogPath, "localBridge.start called\n"); } catch(e){}
  } catch (err) {
    try { fs.appendFileSync(crashLogPath, "localBridge ERR: " + err.message + "\n"); } catch(e){}
  }

  // Global shortcut: Ctrl+Shift+Space to show/hide
  try {
    globalShortcut.register("CmdOrCtrl+Shift+Space", () => {
      if (mainWindow?.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow?.show();
        mainWindow?.focus();
      }
    });
  } catch (e) {}

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else { mainWindow?.show(); mainWindow?.focus(); }
  });
});

app.on("will-quit", () => {
  try { fs.appendFileSync(crashLogPath, "will-quit fired\n"); } catch(e){}
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  try { fs.appendFileSync(crashLogPath, `window-all-closed fired (tray: ${Boolean(tray)})\n`); } catch(e){}
  if (process.platform !== "darwin" && !tray) app.quit();
});

app.setName("Sameer AI Workspace");
