'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  ArrowUp,
  PanelLeft,
  Square,
  Menu,
  Sparkles,
  FileCode,
  Copy,
  Check,
  Paperclip,
  RotateCcw,
  User,
  ThumbsUp,
  ThumbsDown,
  SlidersHorizontal,
  X,
  Zap,
  Download,
  Bot,
  Radio,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Image as ImageIcon,
  Maximize2,
  Wand2,
  FileDown,
  PlusCircle,
  Key,
  ExternalLink,
  Globe,
  Cpu,
  Mail,
  Github,
  Crown,
  CheckCircle2,
  Pencil,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Message, ModelId, Artifact, ResponseStyle, Attachment, ThinkingBudget, CustomButton, Connector, ConnectorConfig } from '@/types/chat';
import CodeBlockRunner from '@/components/CodeBlockRunner';
import ModelSelector from './ModelSelector';

interface ChatAreaProps {
  messages: Message[];
  activeModel: ModelId;
  onSelectModel: (model: ModelId) => void;
  onSendMessage: (text: string, attachments?: Attachment[], isBrowserMode?: boolean) => void;
  onEditMessage?: (id: string, newText: string) => void;
  onStopStreaming: () => void;
  onRegenerateLast: () => void;
  isStreaming: boolean;
  onOpenMobileSidebar: () => void;
  onSelectArtifact: (artifact: Artifact) => void;
  activeArtifactId?: string;
  onOpenConnectors: () => void;
  onOpenDownload: () => void;
  activeConnectorsCount: number;
  activeConnectors?: Connector[];
  onToggleConnector?: (id: string) => void;
  onUpdateConnectorConfig?: (id: string, config: ConnectorConfig) => void;
  thinkingBudget: ThinkingBudget;
  onSelectThinkingBudget: (budget: ThinkingBudget) => void;
  isProactiveMode: boolean;
  onToggleProactiveMode: () => void;
  customButtons?: CustomButton[];
  onAddCustomButton?: (btn: CustomButton) => void;
  onDeleteCustomButton?: (id: string) => void;
  sessionTitle?: string;
  onOpenSettings?: () => void;
  onOpenFeatures?: () => void;
  onOpenSquad?: () => void;
  hasGeminiKey?: boolean;
  onToggleBrowserPanel?: () => void;
  isBrowserPanelOpen?: boolean;
  isSidebarOpen?: boolean;
}

export default function ChatArea({
  messages,
  activeModel,
  onSelectModel,
  onSendMessage,
  onEditMessage,
  onStopStreaming,
  onRegenerateLast,
  isStreaming,
  onOpenMobileSidebar,
  onSelectArtifact,
  activeArtifactId,
  onOpenConnectors,
  onOpenDownload,
  activeConnectorsCount,
  activeConnectors = [],
  onToggleConnector,
  onUpdateConnectorConfig,
  thinkingBudget,
  onSelectThinkingBudget,
  isProactiveMode,
  onToggleProactiveMode,
  customButtons = [],
  onAddCustomButton,
  onDeleteCustomButton,
  sessionTitle,
  onOpenSettings,
  onOpenFeatures,
  onOpenSquad,
  hasGeminiKey = false,
  onToggleBrowserPanel,
  isBrowserPanelOpen = false,
  isSidebarOpen = true,
}: ChatAreaProps) {
  const [input, setInput] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isThinkingEnabled, setIsThinkingEnabled] = useState(true);
  const [selectedStyle, setSelectedStyle] = useState<ResponseStyle>('normal');
  const [isStyleMenuOpen, setIsStyleMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [interimTranscript, setInterimTranscript] = useState<string>('');
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [interactionMode, setInteractionMode] = useState<'chat' | 'cowork'>('chat');
  const [isBrowserMode, setIsBrowserMode] = useState<boolean>(false);
  const [updateInfo, setUpdateInfo] = useState<{ hasUpdate: boolean; latestVersion?: string; downloadUrl?: string; releaseNotes?: string } | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        let currentVer = '1.0.52';
        if (typeof window !== 'undefined' && (window as any).electronAPI?.getVersion) {
          const v = await (window as any).electronAPI.getVersion();
          if (v) currentVer = v;
        }
        const res = await fetch(`/api/check-update?current=${encodeURIComponent(currentVer)}`);
        const data = await res.json();
        if (data?.hasUpdate) {
          setUpdateInfo(data);
        } else {
          setUpdateInfo(null);
        }
      } catch {}
    };
    check();
    const interval = setInterval(check, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handleRestartToUpdate = async () => {
    setIsUpdating(true);
    try {
      if (typeof window !== 'undefined' && (window as any).electronAPI?.restartToUpdate) {
        await (window as any).electronAPI.restartToUpdate(updateInfo?.downloadUrl);
      } else if (updateInfo?.downloadUrl) {
        window.open(updateInfo.downloadUrl, '_blank');
      }
    } catch (err) {
      console.error('Update failed:', err);
      if (updateInfo?.downloadUrl) window.open(updateInfo.downloadUrl, '_blank');
    } finally {
      setIsUpdating(false);
    }
  };

  // Downside Per-Session Connector Quick Edit State
  const [editingDownsideConn, setEditingDownsideConn] = useState<Connector | null>(null);
  const [downsideEditValue, setDownsideEditValue] = useState('');

  // Message Edit State (official Claude hover-to-edit feature)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  // Cowork Mode — File Access State
  const [coworkFile, setCoworkFile] = useState<{ name: string; content: string; path?: string; handle?: any } | null>(null);
  const [coworkDirty, setCoworkDirty] = useState(false);

  const handleOpenFile = async () => {
    try {
      // Desktop Electron native dialog
      if (typeof window !== 'undefined' && (window as any).electronAPI?.openFile) {
        const res = await (window as any).electronAPI.openFile();
        if (res && res.content !== undefined) {
          setCoworkFile({ name: res.name, content: res.content, path: res.path });
          setCoworkDirty(false);
          onSendMessage(`I've opened the file "${res.name}" (${res.path || ''}) for cowork. Here is its content:\n\n\`\`\`\n${res.content.slice(0, 8000)}\n\`\`\`\n\nPlease review it. I'll tell you what changes to make.`);
          return;
        }
      }

      // Browser File System Access API where supported (desktop Chrome/Edge)
      if (typeof window !== 'undefined' && typeof (window as any).showOpenFilePicker === 'function') {
        const [handle] = await (window as any).showOpenFilePicker({
          types: [{ description: 'Any File', accept: { '*/*': [] } }],
          multiple: false,
        });
        const file = await handle.getFile();
        const content = await file.text();
        setCoworkFile({ name: file.name, content, handle });
        setCoworkDirty(false);
        onSendMessage(`I've opened the file "${file.name}" for cowork. Here is its content:\n\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\`\n\nPlease review it. I'll tell you what changes to make.`);
        return;
      }

      // Mobile-safe fallback: use a normal file input.
      coworkFileInputRef.current?.click();
    } catch {
      // user cancelled
    }
  };

  const handleSaveFile = async () => {
    if (!coworkFile) return;
    try {
      // Desktop Electron native save
      if (typeof window !== 'undefined' && (window as any).electronAPI?.saveFile) {
        const savedPath = await (window as any).electronAPI.saveFile(coworkFile.path, coworkFile.content);
        if (savedPath) {
          setCoworkFile((prev) => prev ? { ...prev, path: savedPath } : prev);
          setCoworkDirty(false);
          return;
        }
      }

      // Browser File System Access API where supported
      if (coworkFile.handle && typeof coworkFile.handle.createWritable === 'function') {
        const writable = await coworkFile.handle.createWritable();
        await writable.write(coworkFile.content);
        await writable.close();
        setCoworkDirty(false);
        return;
      }

      if (typeof window !== 'undefined' && typeof (window as any).showSaveFilePicker === 'function') {
        const handle = await (window as any).showSaveFilePicker({ suggestedName: coworkFile.name || 'untitled.txt' });
        const writable = await handle.createWritable();
        await writable.write(coworkFile.content);
        await writable.close();
        setCoworkFile((prev) => prev ? { ...prev, handle } : prev);
        setCoworkDirty(false);
        return;
      }

      // Mobile/browser fallback: download the edited file.
      const blob = new Blob([coworkFile.content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = coworkFile.name || 'untitled.txt';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setCoworkDirty(false);
    } catch {
      // user cancelled
    }
  };

  const handleNewFile = async () => {
    try {
      if (typeof window !== 'undefined' && (window as any).electronAPI?.newFile) {
        const res = await (window as any).electronAPI.newFile();
        if (res) {
          setCoworkFile({ name: res.name, content: res.content || '', path: res.path });
          setCoworkDirty(false);
          return;
        }
      }

      if (typeof window !== 'undefined' && typeof (window as any).showSaveFilePicker === 'function') {
        const handle = await (window as any).showSaveFilePicker({ suggestedName: 'untitled.txt' });
        const writable = await handle.createWritable();
        await writable.write('');
        await writable.close();
        const file = await handle.getFile();
        setCoworkFile({ name: file.name, content: '', handle });
        setCoworkDirty(false);
        return;
      }

      // Mobile/browser fallback: create an in-memory workspace file.
      setCoworkFile({ name: 'untitled.txt', content: '' });
      setCoworkDirty(false);
    } catch {
      // user cancelled
    }
  };

  const handleSaveEdit = (msgId: string) => {
    if (!editContent.trim()) return;
    if (onEditMessage) {
      onEditMessage(msgId, editContent.trim());
    } else {
      onSendMessage(editContent.trim());
    }
    setEditingMessageId(null);
    setEditContent('');
  };



  const handleSaveDownsideConfig = () => {
    if (!editingDownsideConn || !onUpdateConnectorConfig) return;
    if (editingDownsideConn.id === 'conn-gmail') {
      onUpdateConnectorConfig(editingDownsideConn.id, {
        ...editingDownsideConn.config,
        email: downsideEditValue.trim(),
      });
    } else if (editingDownsideConn.id === 'conn-github') {
      onUpdateConnectorConfig(editingDownsideConn.id, {
        ...editingDownsideConn.config,
        repo: downsideEditValue.trim(),
      });
    }
    setEditingDownsideConn(null);
  };

  // Self-Customization Modal State
  const [isAddingButton, setIsAddingButton] = useState(false);
  const [newBtnLabel, setNewBtnLabel] = useState('');
  const [newBtnPrompt, setNewBtnPrompt] = useState('');

  const handlePolishPrompt = () => {
    if (!input.trim()) return;
    const polished = `Act as Claude 3.7 Sonnet Enterprise. Provide a rigorous, production-grade, and beautifully structured solution with complete implementations and nuanced architectural patterns for:\n\n${input.trim()}`;
    setInput(polished);
  };

  const handleExportChat = () => {
    if (messages.length === 0) return;
    const mdContent = messages
      .map((m) => `### ${m.role === 'user' ? '👤 User' : '🤖 Claude'}\n\n${m.content}\n\n---\n`)
      .join('\n');
    const blob = new Blob(
      [
        `# Conversation Export: ${sessionTitle || 'Claude Session'}\n\nDate: ${new Date().toLocaleString()}\n\n---\n\n${mdContent}`,
      ],
      { type: 'text/markdown' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `claude-conversation-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const coworkFileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning, Sameer';
    if (hour < 18) return 'Good afternoon, Sameer';
    return 'Good evening, Sameer';
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`;
    }
  }, [input]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!input.trim() && attachments.length === 0) return;
    const text = input.trim();
    const currentAttachments = [...attachments];
    setInput('');
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
    }
    onSendMessage(text, currentAttachments, isBrowserMode);
    if (isBrowserMode) {
      setIsBrowserMode(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const copyMessage = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Text-to-Speech (TTS) Voice playback for Claude's messages
  const handleSpeak = (msgId: string, text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      alert('Speech synthesis is not supported on this device/browser.');
      return;
    }

    if (speakingMsgId === msgId) {
      window.speechSynthesis.cancel();
      setSpeakingMsgId(null);
      return;
    }

    window.speechSynthesis.cancel();
    const cleanText = text
      .replace(/```[\s\S]*?```/g, 'Code block omitted.')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
      .replace(/[#*_~]/g, '');

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.onend = () => setSpeakingMsgId(null);
    utterance.onerror = () => setSpeakingMsgId(null);

    setSpeakingMsgId(msgId);
    window.speechSynthesis.speak(utterance);
  };

  // Web Speech Recognition for Voice Dictation
  const toggleListening = () => {
    if (isListening) {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      setIsListening(false);
      setInterimTranscript('');
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser. Please use Chrome or Edge.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      setIsListening(true);
      setInterimTranscript('');
    };

    recognition.onresult = (event: any) => {
      let currentInterim = '';
      let finalStr = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalStr += event.results[i][0].transcript + ' ';
        } else {
          currentInterim += event.results[i][0].transcript;
        }
      }
      if (finalStr) {
        setInput((prev) => (prev ? `${prev} ${finalStr.trim()}` : finalStr.trim()));
      }
      setInterimTranscript(currentInterim);
    };

    recognition.onerror = () => {
      setIsListening(false);
      setInterimTranscript('');
    };

    recognition.onend = () => {
      setIsListening(false);
      setInterimTranscript('');
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (e) {
      setIsListening(false);
    }
  };

  // Multimodal File & Document Processing
  const processFile = async (file: File): Promise<Attachment> => {
    const id = `att_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const isImg = file.type.startsWith('image/');
    const sizeLabel = `${(file.size / 1024).toFixed(1)} KB`;
    const lowerName = file.name.toLowerCase();
    const ext = lowerName.includes('.') ? lowerName.split('.').pop() || '' : '';

    if (isImg) {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Could not read image.'));
        reader.readAsDataURL(file);
      });
      return {
        id,
        name: file.name,
        size: sizeLabel,
        type: file.type || 'image',
        dataUrl,
        isImage: true,
      };
    }

    const textExtensions = new Set([
      'txt','md','markdown','csv','json','xml','yaml','yml','html','htm','css',
      'js','jsx','ts','tsx','py','sql','java','c','cpp','h','hpp','go','rs',
      'php','rb','swift','kt','dart','sh','bash','toml','ini','env'
    ]);

    if (textExtensions.has(ext) || file.type.startsWith('text/')) {
      const contentStr = await file.text();
      return {
        id,
        name: file.name,
        size: sizeLabel,
        type: file.type || 'text',
        contentSnippet: contentStr.slice(0, 50000),
      };
    }

    const structuredDocument = new Set(['pdf','docx','xlsx','xls','xlsm']);
    if (structuredDocument.has(ext)) {
      if (file.size > 4 * 1024 * 1024) {
        return {
          id,
          name: file.name,
          size: sizeLabel,
          type: file.type || 'document',
          contentSnippet: 'This document is larger than the 4 MB online extraction limit. Please use a smaller file or split the document into parts.',
        };
      }

      try {
        const form = new FormData();
        form.append('file', file);
        const response = await fetch('/api/files/extract', {
          method: 'POST',
          body: form,
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data?.ok) {
          return {
            id,
            name: file.name,
            size: sizeLabel,
            type: file.type || 'document',
            contentSnippet: `Document extraction failed: ${data?.error || `HTTP ${response.status}`}`,
          };
        }

        const warnings = Array.isArray(data.warnings) && data.warnings.length
          ? `\n\nExtraction notes:\n- ${data.warnings.join('\n- ')}`
          : '';

        return {
          id,
          name: file.name,
          size: sizeLabel,
          type: data.type || file.type || 'document',
          contentSnippet: String(data.text || '').slice(0, 50000) + warnings,
        };
      } catch (error: any) {
        return {
          id,
          name: file.name,
          size: sizeLabel,
          type: file.type || 'document',
          contentSnippet: 'Document extraction failed: ' + (error?.message || 'network error'),
        };
      }
    }

    return {
      id,
      name: file.name,
      size: sizeLabel,
      type: file.type || 'document',
      contentSnippet: 'This file format is not currently text-extractable in the workspace.',
    };
  };

  const handleCoworkFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const textResult = await file.text();
      setCoworkFile({ name: file.name, content: textResult });
      setCoworkDirty(false);
      onSendMessage(`I've opened the file "${file.name}" for cowork. Here is its content:\n\n\`\`\`\n${textResult.slice(0, 8000)}\n\`\`\`\n\nPlease review it. I'll tell you what changes to make.`);
    } catch {
      // ignored
    } finally {
      if (coworkFileInputRef.current) coworkFileInputRef.current.value = '';
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const newAttachments = await Promise.all(Array.from(files).map(processFile));
    setAttachments((prev) => [...prev, ...newAttachments]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const filesToProcess: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) filesToProcess.push(file);
      }
    }

    if (filesToProcess.length > 0) {
      e.preventDefault();
      const newAtts = await Promise.all(filesToProcess.map(processFile));
      setAttachments((prev) => [...prev, ...newAtts]);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const hasMessages = messages.length > 0;

  const renderPromptBox = (isHero: boolean) => (
    <form
      onSubmit={handleSubmit}
      className={`relative w-full rounded-2xl bg-[#23221d] border border-[#38352d] shadow-2xl focus-within:border-[#cc785c]/70 transition-all p-3 ${
        isHero ? 'max-w-2xl mx-auto mt-6' : 'max-w-3xl mx-auto'
      }`}
    >
      {/* Attachments with Image Thumbnails */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 pb-2 mb-2 border-b border-[#2e2c24]">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="flex items-center space-x-2 px-2 py-1 rounded-lg bg-[#2b2923] border border-[#38352d] text-xs text-[#ece9e2]"
            >
              {att.isImage && att.dataUrl ? (
                <img
                  src={att.dataUrl}
                  alt={att.name}
                  className="w-7 h-7 object-cover rounded shadow-sm cursor-pointer"
                  onClick={() => setPreviewImage(att.dataUrl!)}
                />
              ) : (
                <Paperclip className="w-3.5 h-3.5 text-[#cc785c]" />
              )}
              <span className="truncate max-w-[130px] font-medium">{att.name}</span>
              <span className="text-[10px] text-[#8a8579] font-mono">({att.size})</span>
              <button
                type="button"
                onClick={() => removeAttachment(att.id)}
                className="hover:text-rose-400 p-0.5 rounded"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Voice Listening Banner */}
      {isListening && (
        <div className="flex items-center justify-between px-3 py-1.5 mb-2 rounded-xl bg-[#cc785c]/15 border border-[#cc785c]/30 text-[#cc785c] text-xs animate-in fade-in">
          <div className="flex items-center space-x-2 truncate">
            <div className="w-2 h-2 rounded-full bg-[#cc785c] animate-ping shrink-0" />
            <span className="font-semibold shrink-0">Listening... Speak now</span>
            {interimTranscript && (
              <span className="text-[#ece9e2] italic truncate max-w-[200px] sm:max-w-[320px]">
                "{interimTranscript}"
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={toggleListening}
            className="text-[11px] font-medium px-2 py-0.5 rounded bg-[#cc785c]/25 hover:bg-[#cc785c]/40 text-[#ece9e2] transition-colors shrink-0"
          >
            Done
          </button>
        </div>
      )}


      {/* Browser Mode Banner */}
      {isBrowserMode && (
        <div className="flex items-center justify-between px-3 py-1.5 mb-2 rounded-xl bg-[#cc785c]/15 border border-[#cc785c]/35 text-[#cc785c] text-xs animate-in fade-in">
          <div className="flex items-center space-x-2 truncate">
            <Globe className="w-3.5 h-3.5 text-[#cc785c] animate-pulse shrink-0" />
            <span className="font-semibold shrink-0">Browser Agent Active</span>
            <span className="text-[#ece9e2]/80 truncate">
              — Automated browser actions using your saved logins
            </span>
          </div>
          <button
            type="button"
            onClick={() => setIsBrowserMode(false)}
            className="text-[11px] font-medium px-2 py-0.5 rounded bg-[#cc785c]/25 hover:bg-[#cc785c]/40 text-[#ece9e2] transition-colors shrink-0"
          >
            Turn Off
          </button>
        </div>
      )}

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        rows={isHero ? 2 : 1}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={
          isListening
            ? 'Transcribing your voice in real-time...'
            : isBrowserMode
            ? 'Describe a browser task (e.g. Go to YouTube, create playlist named X and add videos from Y)...'
            : isStreaming
            ? 'Type to interrupt and send instantly (never queued)...'
            : isHero
            ? 'How can Claude help you today?'
            : 'Reply to Claude... (Shift+Enter for newline, Ctrl+V to paste screenshot)'
        }
        className="w-full bg-transparent text-sm text-[#ece9e2] placeholder-[#7d786e] px-2 py-1.5 focus:outline-none resize-none max-h-48 leading-relaxed font-normal"
      />

      <input
        type="file"
        ref={coworkFileInputRef}
        onChange={handleCoworkFileInput}
        className="hidden"
        accept=".txt,.md,.csv,.json,.xml,.yaml,.yml,.html,.css,.js,.jsx,.ts,.tsx,.py,.sql,.java,.c,.cpp,.h,.hpp,.go,.rs,.php,.rb,.swift,.kt,.dart,.sh,.toml,.ini,.env"
      />

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        className="hidden"
        multiple
        accept="image/*,.txt,.pdf,.md,.docx,.xlsx,.xls,.xlsm,.csv,.md,.json,.xml,.yaml,.yml,.js,.jsx,.ts,.tsx,.py,.sql,.java,.c,.cpp,.h,.hpp,.go,.rs,.php,.rb,.swift,.kt,.dart,.html,.css,.toml,.ini,.env"
      />

      {/* Controls Bar inside the Input Box */}
      <div className="flex items-center justify-between pt-2 mt-1 border-t border-[#2c2a23]">
        <div className="flex items-center space-x-2 text-xs text-[#9c978b]">
          {/* Official Claude Plus '+' Button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-7 h-7 rounded-lg hover:bg-[#2e2c24] text-[#8a8579] hover:text-[#ece9e2] flex items-center justify-center transition-colors text-base font-light"
            title="Add content, images, or documents"
          >
            +
          </button>

          {/* Official Claude [ Chat | Cowork ] Segmented Pill Switcher */}
          <div className="flex items-center p-0.5 rounded-xl bg-[#171613] border border-[#2b2923]">
            <button
              type="button"
              onClick={() => setInteractionMode('chat')}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                interactionMode === 'chat'
                  ? 'bg-[#292721] text-[#f4efe6] shadow-sm font-semibold'
                  : 'text-[#827d73] hover:text-[#ece9e2]'
              }`}
            >
              Chat
            </button>
            <button
              type="button"
              onClick={() => setInteractionMode('cowork')}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                interactionMode === 'cowork'
                  ? 'bg-[#292721] text-[#f4efe6] shadow-sm font-semibold'
                  : 'text-[#827d73] hover:text-[#ece9e2]'
              }`}
            >
              Cowork
            </button>
          </div>
        </div>

        {/* Right side: Model Selector, Thinking, Mic, Send */}
        <div className="flex items-center space-x-1.5 shrink-0">
          <ModelSelector
            selectedModel={activeModel}
            onSelectModel={onSelectModel}
            thinkingBudget={thinkingBudget}
            onSelectThinkingBudget={onSelectThinkingBudget}
            isThinkingEnabled={isThinkingEnabled}
          />

          {/* Magic Wand Prompt Polish Button */}
          <button
            type="button"
            onClick={handlePolishPrompt}
            disabled={!input.trim()}
            className={`p-1.5 rounded-lg transition-all hidden sm:flex ${
              input.trim()
                ? 'hover:bg-[#2d2b23] text-[#cc785c] hover:text-[#db8a6e]'
                : 'text-[#5c574e] cursor-not-allowed'
            }`}
            title="Polish prompt for Claude Enterprise"
          >
            <Wand2 className="w-3.5 h-3.5" />
          </button>

          {/* Voice Dictation (Speech-to-Text) Button */}
          <button
            type="button"
            onClick={toggleListening}
            className={`p-1.5 rounded-lg transition-all ${
              isListening
                ? 'bg-[#cc785c] text-black animate-pulse shadow-md shadow-[#cc785c]/40'
                : 'hover:bg-[#2d2b23] text-[#8a8579] hover:text-[#ece9e2]'
            }`}
            title={isListening ? 'Stop Voice Dictation' : 'Speak to Claude'}
          >
            {isListening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
          </button>

          {isStreaming ? (
            <button
              type="button"
              onClick={onStopStreaming}
              className="px-3 py-1.5 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-xs font-medium flex items-center space-x-1.5 border border-rose-500/30 transition-all"
              title="Stop generation"
            >
              <Square className="w-3 h-3 fill-current" />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim() && attachments.length === 0}
              className={`w-7 h-7 rounded-xl flex items-center justify-center transition-all ${
                input.trim() || attachments.length > 0
                  ? 'bg-[#cc785c] hover:bg-[#db8a6e] text-black shadow-md shadow-[#cc785c]/25 active:scale-95'
                  : 'bg-[#2b2923] text-[#6d685e] cursor-not-allowed'
              }`}
              title="Send to Claude"
            >
              <ArrowUp className="w-4 h-4 stroke-[2.5]" />
            </button>
          )}
        </div>
      </div>
    </form>
  );


  return (
    <div className="flex-1 flex flex-col h-full bg-[#1c1b18] relative overflow-hidden">
      {/* Top Navbar */}
      <header className="h-14 border-b border-[#2b2a24] bg-[#1c1b18]/95 backdrop-blur-md flex items-center justify-between px-4 z-10 shrink-0">
        <div className={`flex items-center space-x-3 ${!isSidebarOpen ? 'pl-10' : ''}`}>
          {!isSidebarOpen && (
            <button
              onClick={onOpenMobileSidebar}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="p-1.5 rounded-lg bg-[#282620]/80 hover:bg-[#38352d] text-[#8a8579] hover:text-[#ece9e2] border border-[#38352d] transition-all shadow-sm hidden md:flex items-center justify-center"
            >
              <PanelLeft className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onOpenMobileSidebar}
            className="md:hidden p-2 rounded-lg hover:bg-[#282621] text-[#9c978b] hover:text-[#ece9e2]"
          >
            <Menu className="w-5 h-5" />
          </button>
          {hasMessages && (
            <ModelSelector
              selectedModel={activeModel}
              onSelectModel={onSelectModel}
              thinkingBudget={thinkingBudget}
              onSelectThinkingBudget={onSelectThinkingBudget}
              isThinkingEnabled={isThinkingEnabled}
            />
          )}
        </div>

        <div className="flex items-center space-x-2">
          {/* EXPORT CHAT BUTTON */}
          <button
            onClick={handleExportChat}
            disabled={messages.length === 0}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${
              messages.length > 0
                ? 'bg-[#26241f] hover:bg-[#302e27] border-[#38352d] text-[#dcd8ce] hover:text-[#ece9e2]'
                : 'bg-[#21201b] border-[#2e2c24] text-[#6d685e] cursor-not-allowed'
            }`}
            title="Export conversation as Markdown (.md)"
          >
            <FileDown className="w-3.5 h-3.5 text-[#cc785c]" />
            <span className="hidden sm:inline">Export</span>
          </button>

          {/* RESTART TO UPDATE PILL (ANTIGRAVITY STYLE) */}
          {updateInfo?.hasUpdate && (
            <button
              onClick={handleRestartToUpdate}
              disabled={isUpdating}
              className="flex items-center space-x-1.5 px-3 py-1 rounded-full bg-[#0284c7] hover:bg-[#0369a1] active:bg-[#075985] text-white text-xs font-semibold shadow-md transition-all active:scale-95 animate-pulse"
              title="Restart and update to the latest version"
            >
              <span>{isUpdating ? 'Updating...' : 'Restart to Update'}</span>
              <span className="font-bold">→</span>
            </button>
          )}

          {/* OPENWORK CLOUD WEBSITE */}
          <a
            href="https://claude-enterprise-website-original.vercel.app"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-[#cc785c]/20 to-[#cc785c]/10 hover:from-[#cc785c]/30 hover:to-[#cc785c]/20 border border-[#cc785c]/30 text-xs font-semibold text-[#f2eee6] transition-all hover:text-white group"
            title="Open the official OpenWork Cloud Website (Apps & Showcase)"
          >
            <Globe className="w-3.5 h-3.5 text-[#cc785c] group-hover:scale-110 transition-transform" />
            <span className="hidden sm:inline">OpenWork Cloud ↗</span>
          </a>

          {/* Autonomous Two-Way Proactive Mode Toggle (User's favorite feature) */}
          <button
            onClick={onToggleProactiveMode}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold font-mono transition-all shadow-sm active:scale-95 ${
              isProactiveMode
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/25'
                : 'bg-[#26241f] border-[#38352d] text-[#8a8579] hover:text-[#ece9e2]'
            }`}
            title="Two-Way Autonomous Proactive Mode: AI checks in and messages in background"
          >
            <Radio className={`w-3.5 h-3.5 ${isProactiveMode ? 'text-emerald-400 animate-pulse' : ''}`} />
            <span>Two-Way: {isProactiveMode ? 'ON' : 'OFF'}</span>
          </button>

          {/* DOWNLOAD BUTTON */}
          <button
            onClick={onOpenDownload}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-[#26241f] hover:bg-[#302e27] border border-[#38352d] text-xs font-medium text-[#dcd8ce] transition-all hover:text-[#ece9e2]"
            title="Download Desktop & Android Apps"
          >
            <Download className="w-3.5 h-3.5 text-[#cc785c]" />
            <span>Download</span>
          </button>
        </div>
      </header>

      {/* Session-Level Toolbar: Browser Agent Mode & Connectors */}
      <div className="flex justify-end items-center px-4 sm:px-6 pt-2.5 pb-1 shrink-0 z-10 gap-2">
        <button
          onClick={() => {
            setIsBrowserMode((prev) => !prev);
            onToggleBrowserPanel?.();
          }}
          className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-xl border text-xs font-semibold transition-all shadow-sm active:scale-95 ${
            isBrowserPanelOpen || isBrowserMode
              ? 'bg-[#cc785c]/25 border-[#cc785c] text-[#f2eee6] shadow-[#cc785c]/10'
              : 'bg-[#26241f] hover:bg-[#302e27] border-[#38352d] hover:border-[#cc785c]/60 text-[#a09b8f]'
          }`}
          title="Open Built-in Browser Panel"
        >
          <Globe className={`w-3.5 h-3.5 transition-transform ${isBrowserPanelOpen || isBrowserMode ? 'text-[#cc785c] animate-pulse' : 'text-[#8a8579]'}`} />
          <span>Browser</span>
          <span className={`w-1.5 h-1.5 rounded-full inline-block ${isBrowserPanelOpen || isBrowserMode ? 'bg-[#cc785c] shadow-sm shadow-[#cc785c]' : 'bg-[#5c574e]'}`} />
        </button>

        <button
          onClick={onOpenConnectors}
          className="flex items-center space-x-2 px-3.5 py-1.5 rounded-xl bg-[#26241f] hover:bg-[#302e27] border border-[#38352d] hover:border-[#cc785c]/60 text-xs font-semibold text-[#f2eee6] transition-all shadow-sm group active:scale-95"
          title="Connectors (Live)"
        >
          <Cpu className="w-3.5 h-3.5 text-[#cc785c] group-hover:rotate-12 transition-transform shrink-0" />
          <span>Connectors</span>
          <span className="text-[#4a473f]">•</span>
          <span className="text-[11px] text-[#cc785c] font-mono">
            connectors
          </span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block shadow-sm shadow-emerald-400/50" />
        </button>
      </div>

      {/* Messages Stream / Hero Container — split with Cowork panel when active */}
      <div className={`flex-1 flex overflow-hidden ${interactionMode === 'cowork' ? 'flex-row' : 'flex-col'}`}>

        {/* Left: Chat messages */}
        <div className={`overflow-y-auto px-4 py-6 md:px-8 space-y-6 ${interactionMode === 'cowork' ? 'w-1/2 border-r border-[#2b2923]' : 'flex-1'}`}>
        {!hasMessages ? (
          /* Claude Hero Welcome View - Exact match to official Claude screenshot */
          <div className="min-h-full flex flex-col items-center justify-center max-w-2xl mx-auto text-center space-y-5 py-8 animate-in fade-in duration-200">
            {/* Terracotta Claude Star */}
            <div className="text-[#cc785c] text-4xl select-none leading-none font-serif">
              ✳
            </div>

            {/* Serif Heading */}
            <h1 className="text-3xl sm:text-4xl font-serif text-[#ece9e2] font-normal tracking-tight">
              Coffee and Claude time?
            </h1>

            {/* Centered Hero Prompt Box */}
            <div className="w-full pt-1">
              {renderPromptBox(true)}
            </div>

            {/* Quick Starter Pills */}
            <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => onSendMessage('Help me write clean, robust code or debug an application.')}
                className="flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-[#23221d] hover:bg-[#2b2923] border border-[#333129] hover:border-[#cc785c]/50 text-xs font-medium text-[#dcd8ce] hover:text-[#f4efe6] transition-all shadow-sm group"
              >
                <span className="text-[#cc785c] font-mono text-[11px] group-hover:scale-110 transition-transform">&lt;/&gt;</span>
                <span>Code</span>
              </button>

              <button
                type="button"
                onClick={() => onSendMessage('Help me develop a strategic business or engineering plan with actionable phases.')}
                className="flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-[#23221d] hover:bg-[#2b2923] border border-[#333129] hover:border-[#cc785c]/50 text-xs font-medium text-[#dcd8ce] hover:text-[#f4efe6] transition-all shadow-sm group"
              >
                <span className="text-emerald-400 text-[12px] group-hover:scale-110 transition-transform">📈</span>
                <span>Strategize</span>
              </button>

              <button
                type="button"
                onClick={() => onSendMessage('Explain a complex concept with clear analogies, real-world examples, and key takeaways.')}
                className="flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-[#23221d] hover:bg-[#2b2923] border border-[#333129] hover:border-[#cc785c]/50 text-xs font-medium text-[#dcd8ce] hover:text-[#f4efe6] transition-all shadow-sm group"
              >
                <span className="text-amber-400 text-[12px] group-hover:scale-110 transition-transform">🎓</span>
                <span>Learn</span>
              </button>

              <button
                type="button"
                onClick={() => onSendMessage('Search my Google Drive files and summarize documents.')}
                className="flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-[#23221d] hover:bg-[#2b2923] border border-[#333129] hover:border-[#cc785c]/50 text-xs font-medium text-[#dcd8ce] hover:text-[#f4efe6] transition-all shadow-sm group"
              >
                <span className="text-blue-400 text-[12px] group-hover:scale-110 transition-transform">🔺</span>
                <span>From Drive</span>
              </button>

              <button
                type="button"
                onClick={() => onSendMessage('Draft an email for me to send with subject line and 1-click send link.')}
                className="flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-[#23221d] hover:bg-[#2b2923] border border-[#333129] hover:border-[#cc785c]/50 text-xs font-medium text-[#dcd8ce] hover:text-[#f4efe6] transition-all shadow-sm group"
              >
                <span className="text-rose-400 text-[12px] group-hover:scale-110 transition-transform">✉️</span>
                <span>From Gmail</span>
              </button>
            </div>
          </div>
        ) : (
          /* Ongoing Conversation Stream */
          messages.map((msg, index) => {
            const isUser = msg.role === 'user';
            const isLastAssistant = !isUser && index === messages.length - 1;

            return (
              <div
                key={msg.id}
                className={`flex space-x-3.5 max-w-3xl mx-auto ${
                  isUser ? 'justify-end' : 'justify-start'
                }`}
              >
                {!isUser && (
                  <div className="w-7 h-7 rounded-lg bg-[#cc785c] flex items-center justify-center shrink-0 shadow-sm mt-1">
                    <Sparkles className="w-3.5 h-3.5 text-black fill-current" />
                  </div>
                )}

                <div
                  className={`relative group text-sm leading-relaxed ${
                    isUser
                      ? 'bg-[#2b2923] text-[#f4efe6] max-w-[85%] rounded-2xl rounded-tr-sm border border-[#3d3a31] px-4 py-3'
                      : 'text-[#ede8df] w-full px-1 py-1'
                  }`}
                >
                  {/* Attachments */}
                  {isUser && msg.attachments && msg.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2 pb-2 border-b border-[#3d3a31]">
                      {msg.attachments.map((att) => (
                        <div key={att.id}>
                          {att.isImage && att.dataUrl ? (
                            <div
                              onClick={() => setPreviewImage(att.dataUrl!)}
                              className="group/img relative cursor-pointer overflow-hidden rounded-xl border border-[#484439] hover:border-[#cc785c] transition-all my-1 shadow-sm"
                            >
                              <img
                                src={att.dataUrl}
                                alt={att.name}
                                className="max-h-60 max-w-xs object-cover rounded-lg group-hover/img:scale-102 transition-transform duration-200"
                              />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center">
                                <Maximize2 className="w-5 h-5 text-white drop-shadow" />
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-[#35332b] text-xs text-[#dcd8ce] border border-[#444136]">
                              <Paperclip className="w-3.5 h-3.5 text-[#cc785c]" />
                              <span className="truncate max-w-[140px] font-medium">{att.name}</span>
                              <span className="text-[10px] text-[#8a8579] font-mono">({att.size})</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Clean Assistant Action Bar (hover only, zero clutter) */}
                  {!isUser && (
                    <div className="flex items-center justify-end mb-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => copyMessage(msg.id, msg.content)}
                        className="p-1 rounded hover:bg-[#2c2a23] text-[#8a8579] hover:text-[#ece9e2] transition-all"
                        title="Copy message"
                      >
                        {copiedId === msg.id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  )}

                  {/* User inline editor OR message body */}
                  {isUser && editingMessageId === msg.id ? (
                    <div className="space-y-2 w-full min-w-[280px] sm:min-w-[420px]">
                      <textarea
                        rows={3}
                        autoFocus
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSaveEdit(msg.id);
                          } else if (e.key === 'Escape') {
                            setEditingMessageId(null);
                          }
                        }}
                        className="w-full p-3 rounded-xl bg-[#1d1c18] border border-[#cc785c]/60 text-sm text-[#f4efe6] focus:outline-none resize-none leading-relaxed shadow-inner"
                      />
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingMessageId(null)}
                          className="px-3 py-1.5 text-xs rounded-lg text-[#9c978b] hover:text-[#ece9e2] hover:bg-[#35332b] transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveEdit(msg.id)}
                          disabled={!editContent.trim()}
                          className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-[#cc785c] hover:bg-[#db8a6e] text-black transition-all shadow-sm disabled:opacity-50"
                        >
                          Save & Submit
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>


                      {!isUser && (msg.agentAssigned || msg.skillActivated) && (
                        <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
                          {msg.agentAssigned && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#25231c] border border-[#3d392e] text-[11px] font-medium text-[#cc785c] shadow-sm">
                              <Sparkles className="w-3 h-3 text-[#cc785c]" />
                              {msg.agentAssigned}
                            </span>
                          )}
                          {msg.skillActivated && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#22201a] border border-[#353228] text-[11px] font-mono text-[#a8a296] shadow-sm">
                              <Zap className="w-3 h-3 text-amber-400" />
                              {msg.skillActivated}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Main Markdown Body */}
                      <div className="markdown-body space-y-3 text-[14.5px] leading-relaxed text-[#ede8df]">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            code({ inline, className, children, ...props }: any) {
                              const match = /language-(\w+)/.exec(className || '');
                              const lang = match ? match[1] : '';
                              const codeText = String(children).replace(/\n$/, '');

                              if (!inline && (lang || codeText.includes('\n'))) {
                                return (
                                  <CodeBlockRunner
                                    code={codeText}
                                    language={lang}
                                    className={className}
                                  >
                                    {children}
                                  </CodeBlockRunner>
                                );
                              }

                              return (
                                <code
                                  className="px-1.5 py-0.5 rounded bg-[#272520] text-[#cc785c] font-mono text-xs border border-[#36342b]"
                                  {...props}
                                >
                                  {children}
                                </code>
                              );
                            },
                            table({ children }) {
                              return (
                                <div className="my-3 overflow-x-auto rounded-xl border border-[#302e27]">
                                  <table className="min-w-full text-xs text-left divide-y divide-[#302e27]">
                                    {children}
                                  </table>
                                </div>
                              );
                            },
                        td({ children }) {
                          return (
                            <td className="px-3 py-2 border-t border-[#292822] text-[#dcd8ce]">
                              {children}
                            </td>
                          );
                        },
                        blockquote({ children }) {
                          return (
                            <blockquote className="my-2 border-l-2 border-[#cc785c] pl-3 italic text-[#aba597]">
                              {children}
                            </blockquote>
                          );
                        },
                        a({ href, children }) {
                          const childText = String(children || '');
                          const isActionLink =
                            childText.includes('✉️') ||
                            childText.includes('🐙') ||
                            childText.includes('📂') ||
                            childText.includes('📝') ||
                            childText.includes('📊') ||
                            childText.includes('💬') ||
                            childText.includes('📑') ||
                            childText.includes('🎨') ||
                            childText.includes('🔍') ||
                            childText.includes('Send') ||
                            childText.includes('Open in') ||
                            childText.includes('View on') ||
                            childText.includes('Gmail') ||
                            href?.startsWith('https://mail.google.com/mail/') ||
                            href?.startsWith('https://github.com/') ||
                            href?.startsWith('https://drive.google.com/') ||
                            href?.startsWith('https://docs.google.com/') ||
                            href?.startsWith('https://app.slack.com/') ||
                            href?.startsWith('https://notion.so/');

                          if (isActionLink) {
                            return (
                              <a
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-2 px-3.5 py-2 my-1.5 rounded-xl bg-[#26241f] hover:bg-[#322f27] border border-[#cc785c]/50 hover:border-[#cc785c] text-[#f4efe6] hover:text-[#ffffff] text-xs font-medium shadow-md shadow-black/30 hover:shadow-[#cc785c]/15 transition-all group/btn no-underline"
                              >
                                <span className="flex items-center gap-1.5 font-semibold text-[#f4efe6]">
                                  {children}
                                </span>
                                <ExternalLink className="w-3.5 h-3.5 text-[#cc785c] group-hover/btn:translate-x-0.5 group-hover/btn:-translate-y-0.5 transition-transform shrink-0" />
                              </a>
                            );
                          }

                          return (
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[#cc785c] hover:underline inline-flex items-center gap-0.5 font-medium"
                            >
                              {children}
                              <ExternalLink className="w-3 h-3 inline-block opacity-70 ml-0.5" />
                            </a>
                          );
                        },
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>

                  {/* User message hover action bar (Copy & Edit) */}
                  {isUser && (
                    <div className="flex items-center justify-end gap-1.5 pt-1 mt-1.5 border-t border-[#3d3a31]/50 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => copyMessage(msg.id, msg.content)}
                        className="p-1 rounded hover:bg-[#38352b] text-[#9c978b] hover:text-[#ece9e2] transition-colors"
                        title="Copy message"
                      >
                        {copiedId === msg.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      </button>
                      <button
                        onClick={() => {
                          setEditingMessageId(msg.id);
                          setEditContent(msg.content);
                        }}
                        className="p-1 rounded hover:bg-[#38352b] text-[#9c978b] hover:text-[#cc785c] transition-colors"
                        title="Edit prompt"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </>
              )}



                  {/* Claude Artifact Card */}
                  {msg.artifact && (
                    <div
                      onClick={() => onSelectArtifact(msg.artifact!)}
                      className="mt-3.5 p-3 rounded-xl bg-[#1d1c18] border border-[#3b382f] hover:border-[#cc785c]/60 cursor-pointer transition-all flex items-center justify-between group/art"
                    >
                      <div className="flex items-center space-x-2.5 truncate">
                        <div className="w-8 h-8 rounded-lg bg-[#cc785c]/15 border border-[#cc785c]/30 flex items-center justify-center">
                          <FileCode className="w-4 h-4 text-[#cc785c]" />
                        </div>
                        <div className="truncate">
                          <p className="text-xs font-semibold text-[#ece9e2] truncate group-hover/art:text-[#cc785c]">
                            {msg.artifact.title}
                          </p>
                          <p className="text-[11px] text-[#8a8579] uppercase font-mono">
                            {msg.artifact.language || msg.artifact.type} Artifact • Click to Open
                          </p>
                        </div>
                      </div>
                      <span className="text-xs px-2.5 py-1 rounded-lg bg-[#292721] text-[#ece9e2] font-medium border border-[#38352d]">
                        View Artifact →
                      </span>
                    </div>
                  )}

                  {/* Claude Action Toolbar */}
                  {!isUser && (
                    <div className="flex items-center space-x-2 pt-2 mt-2 border-t border-[#292721] text-[#8a8579] opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => copyMessage(msg.id, msg.content)}
                        className="p-1 rounded hover:bg-[#2c2a23] hover:text-[#ece9e2]"
                        title="Copy"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleSpeak(msg.id, msg.content)}
                        className={`p-1 rounded transition-colors ${
                          speakingMsgId === msg.id
                            ? 'bg-[#cc785c]/20 text-[#cc785c]'
                            : 'hover:bg-[#2c2a23] hover:text-[#ece9e2]'
                        }`}
                        title={speakingMsgId === msg.id ? 'Stop audio' : 'Listen to Claude speak'}
                      >
                        {speakingMsgId === msg.id ? (
                          <VolumeX className="w-3.5 h-3.5 text-[#cc785c] animate-pulse" />
                        ) : (
                          <Volume2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                      {isLastAssistant && (
                        <button
                          onClick={onRegenerateLast}
                          className="p-1 rounded hover:bg-[#2c2a23] hover:text-[#ece9e2]"
                          title="Retry / Regenerate response"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        className="p-1 rounded hover:bg-[#2c2a23] hover:text-emerald-400"
                        title="Helpful"
                      >
                        <ThumbsUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        className="p-1 rounded hover:bg-[#2c2a23] hover:text-rose-400"
                        title="Not helpful"
                      >
                        <ThumbsDown className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {isUser && (
                  <div className="w-7 h-7 rounded-lg bg-[#3d3a31] flex items-center justify-center shrink-0 mt-1">
                    <User className="w-3.5 h-3.5 text-[#dcd8ce]" />
                  </div>
                )}
              </div>
            );
          })
        )}

        {isStreaming && (
          <div className="flex space-x-3.5 max-w-3xl mx-auto items-center text-xs text-[#9c978b] pt-1">
            <div className="w-2 h-2 rounded-full bg-[#cc785c] animate-ping mr-2" />
            <span>Claude is synthesizing & generating...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
        </div>

        {/* Right: Cowork File Editor Panel */}
        {interactionMode === 'cowork' && (
          <div className="w-1/2 flex flex-col bg-[#181714] border-l border-[#2b2923]">
            {/* Cowork Toolbar */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#2b2923] bg-[#1c1b18] shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs font-semibold text-[#f2eee6]">
                  {coworkFile ? coworkFile.name : 'Cowork — File Access'}
                </span>
                {coworkDirty && <span className="text-[10px] text-amber-400 font-mono">● unsaved</span>}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleNewFile}
                  className="px-2 py-1 rounded-lg text-[11px] text-[#9c978b] hover:text-[#ece9e2] hover:bg-[#2a2822] transition-colors"
                  title="New file on your PC"
                >New</button>
                <button
                  onClick={handleOpenFile}
                  className="px-2.5 py-1 rounded-lg text-[11px] bg-[#26241f] hover:bg-[#302e27] border border-[#38352d] text-[#dcd8ce] transition-colors"
                  title="Open file from your PC"
                >📂 Open</button>
                {coworkFile && (
                  <button
                    onClick={handleSaveFile}
                    className="px-2.5 py-1 rounded-lg text-[11px] bg-[#cc785c] hover:bg-[#db8a6e] text-black font-semibold transition-colors"
                    title="Save file to your PC"
                  >💾 Save</button>
                )}
              </div>
            </div>

            {/* File Content Editor */}
            {coworkFile ? (
              <textarea
                className="flex-1 w-full bg-[#141210] text-[#e6e2d8] text-xs font-mono p-4 resize-none focus:outline-none leading-relaxed"
                value={coworkFile.content}
                onChange={(e) => {
                  setCoworkFile((prev) => prev ? { ...prev, content: e.target.value } : prev);
                  setCoworkDirty(true);
                }}
                spellCheck={false}
                placeholder="File content will appear here..."
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
                <div className="w-16 h-16 rounded-2xl bg-[#23221d] border border-[#38352d] flex items-center justify-center text-3xl">
                  📂
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-[#f2eee6]">Open any file from your PC</p>
                  <p className="text-xs text-[#8a8579] max-w-xs leading-relaxed">
                    Read, edit, and save files directly. Claude can see the content and help you modify it.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleOpenFile}
                    className="px-4 py-2 rounded-xl bg-[#cc785c] hover:bg-[#db8a6e] text-black text-xs font-bold transition-all shadow-md"
                  >Open File from PC</button>
                  <button
                    onClick={handleNewFile}
                    className="px-4 py-2 rounded-xl bg-[#26241f] hover:bg-[#302e27] border border-[#38352d] text-[#dcd8ce] text-xs font-medium transition-all"
                  >New File</button>
                </div>
                <p className="text-[10px] text-[#6b675d] font-mono">
                  Supports: .txt .md .js .ts .py .json .html .css and any text file
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Floating Prompt Box at Bottom */}
      {hasMessages && (
        <div className="p-4 md:p-6 bg-gradient-to-t from-[#1c1b18] via-[#1c1b18] to-transparent shrink-0">
          {renderPromptBox(false)}
        </div>
      )}


      {/* Fullscreen Image Lightbox Modal */}
      {previewImage && (
        <div
          onClick={() => setPreviewImage(null)}
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in"
        >
          <div className="relative max-w-4xl max-h-[90vh] flex flex-col items-center">
            <button
              onClick={() => setPreviewImage(null)}
              className="absolute -top-10 right-0 p-1.5 rounded-full bg-black/60 hover:bg-black/90 text-white"
            >
              <X className="w-5 h-5" />
            </button>
            <img
              src={previewImage}
              alt="Attachment Preview"
              className="max-w-full max-h-[85vh] rounded-xl shadow-2xl object-contain border border-zinc-800"
            />
          </div>
        </div>
      )}

      {/* Add Custom Button Modal (Self-Customization) */}
      {isAddingButton && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="relative w-full max-w-md rounded-2xl bg-[#23221e] border border-[#383630] shadow-2xl overflow-hidden p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#33312a]">
              <div className="flex items-center space-x-2">
                <PlusCircle className="w-5 h-5 text-[#cc785c]" />
                <h3 className="text-sm font-semibold text-[#ece9e2]">Add Custom Action Button</h3>
              </div>
              <button
                onClick={() => setIsAddingButton(false)}
                className="p-1 rounded hover:bg-[#2c2a25] text-[#9c978b] hover:text-[#ece9e2]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-[#8a8579]">Button Label</label>
                <input
                  type="text"
                  placeholder="e.g. 🚀 Deploy App or ⚡ Optimize Code"
                  value={newBtnLabel}
                  onChange={(e) => setNewBtnLabel(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#1a1916] border border-[#36342e] text-xs text-[#ece9e2] placeholder-zinc-600 focus:outline-none focus:border-[#cc785c]"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-[#8a8579]">Prompt to Trigger</label>
                <textarea
                  rows={3}
                  placeholder="e.g. Review the architecture, check for security vulnerabilities, and optimize performance."
                  value={newBtnPrompt}
                  onChange={(e) => setNewBtnPrompt(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#1a1916] border border-[#36342e] text-xs text-[#ece9e2] placeholder-zinc-600 focus:outline-none focus:border-[#cc785c] resize-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-[#33312a]">
              <button
                type="button"
                onClick={() => setIsAddingButton(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-[#9c978b] hover:text-[#ece9e2]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!newBtnLabel.trim() || !newBtnPrompt.trim()}
                onClick={() => {
                  if (onAddCustomButton && newBtnLabel.trim() && newBtnPrompt.trim()) {
                    onAddCustomButton({
                      id: `btn_${Date.now()}`,
                      label: newBtnLabel.trim(),
                      prompt: newBtnPrompt.trim(),
                    });
                    setNewBtnLabel('');
                    setNewBtnPrompt('');
                    setIsAddingButton(false);
                  }
                }}
                className={`px-4 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                  newBtnLabel.trim() && newBtnPrompt.trim()
                    ? 'bg-[#cc785c] hover:bg-[#db8a6e] text-black shadow-md'
                    : 'bg-[#2b2923] text-[#6d685e] cursor-not-allowed'
                }`}
              >
                Add Button
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Per-Session Connector Quick Edit Modal (Gmail email / GitHub repo) */}
      {editingDownsideConn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="relative w-full max-w-sm rounded-2xl bg-[#23221e] border border-[#383630] shadow-2xl overflow-hidden p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#33312a]">
              <div className="flex items-center space-x-2">
                {editingDownsideConn.id === 'conn-gmail' ? (
                  <Mail className="w-4 h-4 text-[#cc785c]" />
                ) : (
                  <Github className="w-4 h-4 text-[#cc785c]" />
                )}
                <h3 className="text-sm font-semibold text-[#ece9e2]">
                  {editingDownsideConn.id === 'conn-gmail'
                    ? 'Set Gmail Address for this Chat'
                    : 'Set GitHub Repo for this Chat'}
                </h3>
              </div>
              <button
                onClick={() => setEditingDownsideConn(null)}
                className="p-1 rounded hover:bg-[#2c2a25] text-[#9c978b] hover:text-[#ece9e2]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-[#8a8579]">
                {editingDownsideConn.id === 'conn-gmail' ? 'Gmail Address' : 'GitHub Repo (owner/repo)'}
              </label>
              <input
                type="text"
                value={downsideEditValue}
                onChange={(e) => setDownsideEditValue(e.target.value)}
                placeholder={
                  editingDownsideConn.id === 'conn-gmail'
                    ? 'sameer@gmail.com'
                    : 'sameer-sys/my-repo'
                }
                className="w-full px-3 py-2 rounded-xl bg-[#1a1916] border border-[#36342e] text-xs text-[#ece9e2] placeholder-zinc-600 focus:outline-none focus:border-[#cc785c]"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveDownsideConfig();
                  if (e.key === 'Escape') setEditingDownsideConn(null);
                }}
              />
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-[#33312a]">
              <button
                type="button"
                onClick={() => setEditingDownsideConn(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-[#9c978b] hover:text-[#ece9e2]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!downsideEditValue.trim()}
                onClick={handleSaveDownsideConfig}
                className={`px-4 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                  downsideEditValue.trim()
                    ? 'bg-[#cc785c] hover:bg-[#db8a6e] text-black shadow-md'
                    : 'bg-[#2b2923] text-[#6d685e] cursor-not-allowed'
                }`}
              >
                <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />
                Save for this Chat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
