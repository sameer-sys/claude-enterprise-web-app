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
  Columns,
  GripVertical,
} from 'lucide-react';

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

  // Sync geometry / bounds of the embedded WebContentsView to match this container exactly
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

  // Show / Hide and attach ResizeObserver when panel opens or closes
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
          api.navigate(target);
        }
      }

      const ro = new ResizeObserver(() => {
        syncBounds();
      });
      ro.observe(containerRef.current);
      window.addEventListener('resize', syncBounds);

      const cleanupNav = api.onNavigated?.((data: any) => {
        if (data?.url) {
          setCurrentUrl(data.url);
          setInputUrl(data.url);
          onUrlChange?.(data.url);
        }
      });

      const cleanupBounds = api.onBoundsInvalidated?.(() => {
        syncBounds();
      });

      return () => {
        ro.disconnect();
        window.removeEventListener('resize', syncBounds);
        cleanupNav?.();
        cleanupBounds?.();
        api.hide?.();
      };
    }
  }, [isOpen, initialUrl, onUrlChange, syncBounds]);

  // Sync bounds whenever panel width or fullscreen changes
  useEffect(() => {
    const t = setTimeout(syncBounds, 60);
    return () => clearTimeout(t);
  }, [panelWidth, isFullscreen, syncBounds]);

  // Drag-to-resize listener
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = Math.max(380, Math.min(window.innerWidth - 60, window.innerWidth - e.clientX));
      setPanelWidth(newWidth);
      try {
        localStorage.setItem('browser_panel_width', String(newWidth));
      } catch {}
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
    try {
      localStorage.setItem('browser_panel_width', String(targetWidth));
    } catch {}
    setTimeout(syncBounds, 60);
  };

  const navigateTo = (target: string) => {
    const clean = normalizeUrl(target);
    setCurrentUrl(clean);
    setInputUrl(clean);
    onUrlChange?.(clean);
    const api = (window as any).electronAPI?.browser;
    if (api) {
      api.navigate(clean);
    }
  };

  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputUrl) navigateTo(inputUrl);
  };

  const handleBack = () => {
    (window as any).electronAPI?.browser?.back?.();
  };

  const handleForward = () => {
    (window as any).electronAPI?.browser?.forward?.();
  };

  const handleReload = () => {
    (window as any).electronAPI?.browser?.reload?.();
  };

  const handleHome = () => {
    navigateTo('https://github.com');
  };

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

      {/* Top Header: Nav, Clean Address Bar, Window Controls */}
      <div className="flex flex-col border-b border-[#2a2822] bg-[#1d1c18] shrink-0">
        {/* Main Toolbar */}
        <div className="flex items-center justify-between px-3.5 py-2.5 gap-2">
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

          {/* Window & Width Adjustment Controls */}
          <div className="flex items-center space-x-1 shrink-0">
            {/* Quick Size Presets */}
            <div className="hidden sm:flex items-center bg-[#141310] border border-[#333028] rounded-lg p-0.5 space-x-0.5">
              <button
                type="button"
                onClick={() => setPresetWidth(0.35)}
                className={`px-1.5 py-0.5 text-[10px] rounded font-medium transition-colors ${
                  !isFullscreen && Math.abs(panelWidth - (typeof window !== 'undefined' ? window.innerWidth * 0.35 : 500)) < 40
                    ? 'bg-[#cc785c] text-white'
                    : 'text-[#8c867a] hover:text-[#ece9e2] hover:bg-[#26241e]'
                }`}
                title="Compact View (35% screen width)"
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
                title="Half View (50% screen width)"
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
                title="Wide View (70% screen width)"
              >
                70%
              </button>
            </div>

            <button
              type="button"
              onClick={() => setIsFullscreen((prev) => !prev)}
              className="p-1.5 rounded-lg hover:bg-[#2b2923] text-[#a09b8f] hover:text-[#ece9e2] transition-colors"
              title={isFullscreen ? 'Restore Previous Width' : 'Maximize Fullscreen'}
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

        {/* Clean Shortcuts */}
        <div className="flex items-center space-x-2 px-3.5 pb-2 text-[11px] overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => navigateTo('https://github.com')}
            className="px-2.5 py-1 rounded-lg bg-[#26241e] hover:bg-[#302e26] border border-[#38352d] text-[#e0ded8] hover:text-white transition-all text-[11px]"
          >
            GitHub
          </button>
          <button
            type="button"
            onClick={() => navigateTo('https://www.google.com')}
            className="px-2.5 py-1 rounded-lg bg-[#26241e] hover:bg-[#302e26] border border-[#38352d] text-[#e0ded8] hover:text-white transition-all text-[11px]"
          >
            Google
          </button>
          <button
            type="button"
            onClick={() => navigateTo('https://www.youtube.com')}
            className="px-2.5 py-1 rounded-lg bg-[#26241e] hover:bg-[#302e26] border border-[#38352d] text-[#e0ded8] hover:text-white transition-all text-[11px]"
          >
            YouTube
          </button>
        </div>

        {/* Active AI Agent Banner (Visible only when AI is actively performing browser actions) */}
        {(isAgentRunning || agentStepText) && (
          <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#cc785c]/20 border-t border-[#cc785c]/35 text-xs text-[#f2eee6] animate-in fade-in">
            <div className="flex items-center space-x-2 truncate">
              <Sparkles className="w-3.5 h-3.5 text-[#cc785c] animate-spin shrink-0" />
              <span className="font-semibold text-[#cc785c]">AI Browser Action:</span>
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

      {/* Main Viewport: OpenWork Embedded Native Browser View */}
      <div
        ref={containerRef}
        className="flex-1 w-full h-full bg-[#141310] relative overflow-hidden"
      >
        {/* If running in standalone browser without Electron, show iframe fallback */}
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
