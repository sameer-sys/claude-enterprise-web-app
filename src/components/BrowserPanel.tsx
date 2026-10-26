'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Home,
  Maximize2,
  Minimize2,
  X,
  Search,
  Lock,
  Sparkles,
  Plus,
  Globe,
} from 'lucide-react';

interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

interface BrowserPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialUrl?: string;
  agentTask?: string;
  isAgentRunning?: boolean;
  agentStepText?: string;
  onUrlChange?: (url: string) => void;
}

export default function BrowserPanel({
  isOpen,
  onClose,
  initialUrl = 'https://github.com',
  agentTask,
  isAgentRunning = false,
  agentStepText,
  onUrlChange,
}: BrowserPanelProps) {
  const [tabs, setTabs] = useState<BrowserTab[]>([
    { id: 'tab-1', url: initialUrl, title: 'GitHub' },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('tab-1');

  const [currentUrl, setCurrentUrl] = useState<string>(initialUrl);
  const [inputUrl, setInputUrl] = useState<string>(initialUrl);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('browser_panel_width');
      if (saved) {
        const num = parseInt(saved, 10);
        if (!isNaN(num) && num >= 360 && num <= 1920) return num;
      }
      return Math.min(860, Math.round(window.innerWidth * 0.55));
    }
    return 860;
  });

  const isResizingRef = useRef<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const normalizeUrl = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return 'https://github.com';
    if (!trimmed.includes('.') && !trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      return `https://${trimmed}`;
    }
    return trimmed;
  };

  const syncBounds = useCallback(() => {
    if (!containerRef.current || typeof window === 'undefined') return;
    const api = (window as any).electronAPI?.browser;
    if (!api) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      api.bounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const api = (window as any).electronAPI?.browser;

    if (!isOpen) {
      api?.hide?.();
      return;
    }

    if (api && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        api.show({
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
        if (initialUrl) {
          const target = normalizeUrl(initialUrl);
          setCurrentUrl(target);
          setInputUrl(target);
          api?.navigate?.(target);
          fetch('http://127.0.0.1:48080/api/execute-tool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'browser_navigate', args: { url: target } }),
          }).catch(() => {});
        }
      }

      const ro = new ResizeObserver(() => syncBounds());
      ro.observe(containerRef.current);
      window.addEventListener('resize', syncBounds);

      const cleanupTabs = api.onTabsUpdated?.((data: any) => {
        if (Array.isArray(data?.tabs) && data.tabs.length > 0) {
          setTabs(data.tabs.map((t: any) => ({
            id: t.id || t.tabId,
            url: t.url,
            title: t.title || 'Tab',
          })));
          if (data.activeTabId) setActiveTabId(data.activeTabId);
          if (data.url) {
            setCurrentUrl(data.url);
            setInputUrl(data.url);
            onUrlChange?.(data.url);
          }
        }
      });

      const cleanupNav = api.onNavigated?.((data: any) => {
        if (data?.url) {
          setCurrentUrl(data.url);
          setInputUrl(data.url);
          onUrlChange?.(data.url);
          setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, url: data.url, title: data.title || t.title } : t));
        }
      });

      const cleanupBounds = api.onBoundsInvalidated?.(() => syncBounds());

      return () => {
        ro.disconnect();
        window.removeEventListener('resize', syncBounds);
        cleanupNav?.();
        cleanupTabs?.();
        cleanupBounds?.();
        api.hide?.();
      };
    }
  }, [isOpen, initialUrl, onUrlChange, syncBounds, activeTabId]);

  useEffect(() => {
    const t = setTimeout(syncBounds, 60);
    return () => clearTimeout(t);
  }, [panelWidth, isFullscreen, syncBounds]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = Math.max(380, Math.min(window.innerWidth - 60, window.innerWidth - e.clientX));
      setPanelWidth(newWidth);
      try { localStorage.setItem('browser_panel_width', String(newWidth)); } catch {}
      syncBounds();
    };

    const handleMouseUp = () => {
      if (isResizingRef.current) {
        isResizingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        syncBounds();
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [syncBounds]);

  const handleStartResize = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  };

  const setPresetWidth = (fraction: number) => {
    setIsFullscreen(false);
    const targetWidth = Math.max(380, Math.round(window.innerWidth * fraction));
    setPanelWidth(targetWidth);
    try { localStorage.setItem('browser_panel_width', String(targetWidth)); } catch {}
    setTimeout(syncBounds, 60);
  };

  const navigateTo = (target: string) => {
    const clean = normalizeUrl(target);
    setCurrentUrl(clean);
    setInputUrl(clean);
    onUrlChange?.(clean);
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, url: clean, title: clean.replace(/^https?:\/\//, '').split('/')[0] } : t));
    const api = (window as any).electronAPI?.browser;
    if (api) api.navigate(clean);
  };

  const handleSelectTab = (tab: BrowserTab) => {
    setActiveTabId(tab.id);
    setCurrentUrl(tab.url);
    setInputUrl(tab.url);
    const api = (window as any).electronAPI?.browser;
    if (api) {
      if (api.switchTab) api.switchTab(tab.id);
      else if (api.selectTab) api.selectTab(tab.id);
      else api.navigate(tab.url);
    }
  };

  const handleNewTab = () => {
    const api = (window as any).electronAPI?.browser;
    const tabNum = tabs.length + 1;
    if (api?.newTab || api?.createTab) {
      (api.newTab || api.createTab)('newtab');
    } else {
      const newId = `tab-${Date.now()}`;
      const newTab: BrowserTab = { id: newId, url: 'about:blank', title: `New Tab #${tabNum}` };
      setTabs(prev => [...prev, newTab]);
      handleSelectTab(newTab);
    }
  };

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    const api = (window as any).electronAPI?.browser;
    if (api?.closeTab) {
      api.closeTab(tabId);
    } else {
      if (tabs.length === 1) return;
      const remaining = tabs.filter(t => t.id !== tabId);
      setTabs(remaining);
      if (activeTabId === tabId) {
        handleSelectTab(remaining[remaining.length - 1]);
      }
    }
  };

  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputUrl) navigateTo(inputUrl);
  };

  const handleBack = () => { (window as any).electronAPI?.browser?.back?.(); };
  const handleForward = () => { (window as any).electronAPI?.browser?.forward?.(); };
  const handleReload = () => { (window as any).electronAPI?.browser?.reload?.(); };
  const handleHome = () => { navigateTo('https://github.com'); };

  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      style={!isFullscreen ? { width: `${panelWidth}px` } : undefined}
      className={`fixed top-0 right-0 h-full bg-[#161512] border-l border-[#2e2c25] flex flex-col z-40 transition-none shadow-2xl ${
        isFullscreen ? 'w-full inset-0 z-50' : ''
      }`}
    >
      {/* Draggable Left Resize Handle */}
      {!isFullscreen && (
        <div
          onMouseDown={handleStartResize}
          className="absolute left-0 top-0 bottom-0 w-2 -ml-1 cursor-ew-resize hover:bg-[#cc785c]/60 active:bg-[#cc785c] z-50 flex items-center justify-center group transition-colors"
          title="Drag to adjust browser width"
        >
          <div className="w-1 h-8 rounded-full bg-[#524d40] group-hover:bg-[#f2eee6] transition-colors" />
        </div>
      )}

      {/* Top Header: Tabs Bar & Toolbar */}
      <div className="flex flex-col border-b border-[#2a2822] bg-[#1d1c18] shrink-0">
        {/* OpenWork Multi-Tabs Bar */}
        <div className="flex items-center px-2 pt-1.5 pb-0 space-x-1 overflow-x-auto no-scrollbar border-b border-[#25231e]">
          {tabs.map((tab, idx) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => handleSelectTab(tab)}
                className={`group flex items-center space-x-1.5 px-3 py-1.5 rounded-t-lg text-xs cursor-pointer select-none transition-all border-t border-x relative ${
                  isActive
                    ? 'bg-[#141310] text-[#ece9e2] border-[#cc785c]/70 font-medium shadow-sm'
                    : 'bg-[#181714] text-[#8c867a] border-transparent hover:bg-[#211f1a] hover:text-[#c4bfb4]'
                }`}
              >
                <span className={`text-[10px] px-1 py-0.2 rounded font-mono font-semibold ${
                  isActive ? 'bg-[#cc785c]/20 text-[#cc785c]' : 'bg-[#25231e] text-[#6b675e]'
                }`}>
                  #{idx + 1}
                </span>
                <Globe className={`w-3 h-3 ${isActive ? 'text-[#cc785c]' : 'text-[#6b675e]'}`} />
                <span className="truncate max-w-[120px]">{tab.title || `Tab #${idx + 1}`}</span>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => handleCloseTab(e, tab.id)}
                    className="p-0.5 rounded hover:bg-[#38352d] text-[#6b675e] hover:text-[#ece9e2] opacity-0 group-hover:opacity-100 transition-opacity ml-1"
                    title="Close Tab"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={handleNewTab}
            className="p-1 rounded-lg hover:bg-[#26241e] text-[#8c867a] hover:text-[#ece9e2] transition-colors"
            title="Open New Tab"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Navigation Toolbar */}
        <div className="flex items-center justify-between px-3 py-2 gap-2">
          {/* History Controls */}
          <div className="flex items-center space-x-1 shrink-0">
            <button
              type="button"
              onClick={handleBack}
              className="p-1.5 rounded-lg hover:bg-[#2b2923] text-[#a09b8f] hover:text-[#ece9e2] transition-colors"
              title="Back"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleForward}
              className="p-1.5 rounded-lg hover:bg-[#2b2923] text-[#a09b8f] hover:text-[#ece9e2] transition-colors"
              title="Forward"
            >
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleReload}
              className="p-1.5 rounded-lg hover:bg-[#2b2923] text-[#a09b8f] hover:text-[#ece9e2] transition-colors"
              title="Reload"
            >
              <RotateCw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleHome}
              className="p-1.5 rounded-lg hover:bg-[#2b2923] text-[#a09b8f] hover:text-[#ece9e2] transition-colors"
              title="Home"
            >
              <Home className="w-4 h-4" />
            </button>
          </div>

          {/* Clean URL Omnibox */}
          <form onSubmit={handleInputSubmit} className="flex-1 min-w-0">
            <div className="flex items-center bg-[#141310] hover:bg-[#181713] focus-within:bg-[#181713] border border-[#333028] focus-within:border-[#cc785c] rounded-xl px-3 py-1.5 transition-all shadow-inner">
              <Lock className="w-3.5 h-3.5 text-emerald-500 shrink-0 mr-2" />
              <input
                type="text"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                placeholder="Search or enter URL (e.g. google.com, github.com)"
                className="w-full bg-transparent text-xs text-[#ece9e2] placeholder-[#6b675e] focus:outline-none font-mono"
              />
              <button type="submit" className="text-[#a09b8f] hover:text-[#ece9e2] shrink-0 ml-2" title="Go">
                <Search className="w-3.5 h-3.5" />
              </button>
            </div>
          </form>

          {/* Width Adjustment & Window Controls */}
          <div className="flex items-center space-x-1 shrink-0">
            <div className="hidden sm:flex items-center bg-[#141310] border border-[#333028] rounded-lg p-0.5 space-x-0.5">
              <button
                type="button"
                onClick={() => setPresetWidth(0.35)}
                className={`px-1.5 py-0.5 text-[10px] rounded font-medium transition-colors ${
                  !isFullscreen && Math.abs(panelWidth - (typeof window !== 'undefined' ? window.innerWidth * 0.35 : 500)) < 40
                    ? 'bg-[#cc785c] text-white'
                    : 'text-[#8c867a] hover:text-[#ece9e2] hover:bg-[#26241e]'
                }`}
                title="Compact (35%)"
              >
                35%
              </button>
              <button
                type="button"
                onClick={() => setPresetWidth(0.50)}
                className={`px-1.5 py-0.5 text-[10px] rounded font-medium transition-colors ${
                  !isFullscreen && Math.abs(panelWidth - (typeof window !== 'undefined' ? window.innerWidth * 0.50 : 700)) < 40
                    ? 'bg-[#cc785c] text-white'
                    : 'text-[#8c867a] hover:text-[#ece9e2] hover:bg-[#26241e]'
                }`}
                title="Half (50%)"
              >
                50%
              </button>
              <button
                type="button"
                onClick={() => setPresetWidth(0.70)}
                className={`px-1.5 py-0.5 text-[10px] rounded font-medium transition-colors ${
                  !isFullscreen && Math.abs(panelWidth - (typeof window !== 'undefined' ? window.innerWidth * 0.70 : 1000)) < 40
                    ? 'bg-[#cc785c] text-white'
                    : 'text-[#8c867a] hover:text-[#ece9e2] hover:bg-[#26241e]'
                }`}
                title="Wide (70%)"
              >
                70%
              </button>
            </div>

            <button
              type="button"
              onClick={() => setIsFullscreen((prev) => !prev)}
              className="p-1.5 rounded-lg hover:bg-[#2b2923] text-[#a09b8f] hover:text-[#ece9e2] transition-colors"
              title={isFullscreen ? 'Restore' : 'Maximize'}
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-red-500/20 text-[#a09b8f] hover:text-red-400 transition-colors"
              title="Close Browser"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Active AI Agent Banner */}
        {(isAgentRunning || agentStepText) && (
          <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#cc785c]/20 border-t border-[#cc785c]/35 text-xs text-[#f2eee6] animate-in fade-in">
            <div className="flex items-center space-x-2 truncate">
              <Sparkles className="w-3.5 h-3.5 text-[#cc785c] animate-spin shrink-0" />
              <span className="font-semibold text-[#cc785c]">AI Action:</span>
              <span className="truncate text-[#e6e2d8] font-mono text-[11.5px]">
                {agentStepText || agentTask || 'Executing task in browser...'}
              </span>
            </div>
            <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-[#cc785c]/30 text-[#f2eee6] shrink-0">
              Live
            </span>
          </div>
        )}
      </div>

      {/* Main Viewport */}
      <div
        ref={containerRef}
        className="flex-1 w-full h-full bg-[#141310] relative overflow-hidden"
      >
        {typeof window !== 'undefined' && !(window as any).electronAPI?.browser && (
          <iframe
            src={currentUrl}
            className="w-full h-full border-0 bg-white"
            title="Browser"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          />
        )}
      </div>
    </div>
  );
}
