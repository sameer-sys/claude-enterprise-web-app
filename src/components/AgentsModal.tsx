'use client';

import React, { useState } from 'react';
import {
  X,
  Search,
  Crown,
  FolderKanban,
  Users,
  CheckCircle2,
  Network,
  Cpu,
  Database,
  Layout,
  Smartphone,
  FileCheck,
  Boxes,
  ShieldAlert,
  Activity,
  Brain,
  FileSearch,
  Globe,
  Palette,
  Compass,
  ShieldCheck,
  Sparkles,
  Zap,
  Check,
} from 'lucide-react';
import { OpenWorkAgent } from '@/types/chat';
import { OPENWORK_AGENTS } from '@/data/openworkAgents';

interface AgentsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectAgent: (agent: OpenWorkAgent) => void;
  onAddToSquad?: (agent: OpenWorkAgent) => void;
  activeAgentId?: string;
}

const CATEGORIES = [
  { id: 'all', label: 'All Agents (260+)' },
  { id: 'engineering', label: '🛠️ Engineering' },
  { id: 'devops', label: '🚀 DevOps & Cloud' },
  { id: 'ai', label: '🧠 AI & Data' },
  { id: 'design', label: '🎨 Design & UX' },
  { id: 'security', label: '🛡️ Security' },
];

export default function AgentsModal({
  isOpen,
  onClose,
  onSelectAgent,
  onAddToSquad,
  activeAgentId,
}: AgentsModalProps) {
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [previewAgent, setPreviewAgent] = useState<OpenWorkAgent | null>(OPENWORK_AGENTS[0]);

  if (!isOpen) return null;

  const filteredAgents = OPENWORK_AGENTS.filter((ag) => {
    const matchCategory = selectedCategory === 'all' || ag.category === selectedCategory;
    const query = search.toLowerCase().trim();
    if (!query) return matchCategory;
    const matchQuery =
      ag.name.toLowerCase().includes(query) ||
      ag.role.toLowerCase().includes(query) ||
      ag.description.toLowerCase().includes(query);
    return matchCategory && matchQuery;
  });

  const getAgentIcon = (iconName: string) => {
    switch (iconName) {
      case 'Crown':
        return <Crown className="w-4 h-4 text-[#cc785c]" />;
      case 'FolderKanban':
        return <FolderKanban className="w-4 h-4 text-blue-400" />;
      case 'Users':
        return <Users className="w-4 h-4 text-purple-400" />;
      case 'CheckCircle2':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
      case 'Network':
        return <Network className="w-4 h-4 text-cyan-400" />;
      case 'Cpu':
        return <Cpu className="w-4 h-4 text-amber-400" />;
      case 'Database':
        return <Database className="w-4 h-4 text-teal-400" />;
      case 'Layout':
        return <Layout className="w-4 h-4 text-blue-400" />;
      case 'Smartphone':
        return <Smartphone className="w-4 h-4 text-yellow-400" />;
      case 'FileCheck':
        return <FileCheck className="w-4 h-4 text-rose-400" />;
      case 'Boxes':
        return <Boxes className="w-4 h-4 text-slate-300" />;
      case 'ShieldAlert':
        return <ShieldAlert className="w-4 h-4 text-orange-400" />;
      case 'Activity':
        return <Activity className="w-4 h-4 text-green-400" />;
      case 'Brain':
        return <Brain className="w-4 h-4 text-[#cc785c]" />;
      case 'FileSearch':
        return <FileSearch className="w-4 h-4 text-purple-400" />;
      case 'Globe':
        return <Globe className="w-4 h-4 text-sky-400" />;
      case 'Palette':
        return <Palette className="w-4 h-4 text-pink-400" />;
      case 'Compass':
        return <Compass className="w-4 h-4 text-cyan-400" />;
      case 'ShieldCheck':
        return <ShieldCheck className="w-4 h-4 text-rose-400" />;
      default:
        return <Sparkles className="w-4 h-4 text-[#cc785c]" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-5xl h-[88vh] rounded-2xl bg-[#1e1d19] border border-[#38352d] shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#2d2b24] bg-[#181714]">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-xl bg-[#cc785c]/15 border border-[#cc785c]/30 flex items-center justify-center">
              <Zap className="w-4 h-4 text-[#cc785c]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-[#ece9e2]">OpenWork Agent & Skill Catalog</h2>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-[#cc785c]/15 text-[#cc785c] border border-[#cc785c]/30 font-mono">
                  260+ Agents
                </span>
              </div>
              <p className="text-xs text-[#9c978b]">
                Deploy specialized autonomous agents or assign them to the Executive Manager squad
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[#282620] text-[#9c978b] hover:text-[#ece9e2] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filters & Search */}
        <div className="p-4 border-b border-[#2d2b24] bg-[#1a1915] flex flex-col sm:flex-row gap-3 items-center justify-between">
          <div className="relative w-full sm:w-80">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-[#7d786e]" />
            <input
              type="text"
              placeholder="Search by role, name, or skill..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-[#24221d] border border-[#3b382f] text-xs text-[#ece9e2] placeholder-zinc-500 focus:outline-none focus:border-[#cc785c]"
            />
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto no-scrollbar">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`text-xs px-2.5 py-1 rounded-lg shrink-0 font-medium transition-all ${
                  selectedCategory === cat.id
                    ? 'bg-[#cc785c] text-black font-semibold shadow-sm'
                    : 'bg-[#24221d] hover:bg-[#2d2b23] text-[#a6a094] hover:text-[#ece9e2] border border-[#333129]'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* Main Content: Left List & Right Detail Preview */}
        <div className="flex-1 flex overflow-hidden">
          {/* Agent Cards Grid */}
          <div className="w-full md:w-3/5 overflow-y-auto p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 border-r border-[#2d2b24]">
            {filteredAgents.length === 0 ? (
              <div className="col-span-2 text-center py-12 text-zinc-500 text-xs">
                No matching OpenWork agents found for "{search}".
              </div>
            ) : (
              filteredAgents.map((ag) => {
                const isSelected = previewAgent?.id === ag.id;
                const isActiveInChat = activeAgentId === ag.id;

                return (
                  <div
                    key={ag.id}
                    onClick={() => setPreviewAgent(ag)}
                    className={`p-3.5 rounded-xl border cursor-pointer transition-all flex flex-col justify-between text-left group ${
                      isSelected
                        ? 'bg-[#282620] border-[#cc785c]/70 shadow-md'
                        : 'bg-[#21201b] hover:bg-[#26241e] border-[#312f27] hover:border-[#423f34]'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2 truncate">
                          <div className="w-7 h-7 rounded-lg bg-[#191814] border border-[#38352d] flex items-center justify-center shrink-0">
                            {getAgentIcon(ag.avatarIcon)}
                          </div>
                          <span className="font-semibold text-xs text-[#ece9e2] truncate group-hover:text-[#cc785c]">
                            {ag.name}
                          </span>
                        </div>
                        {isActiveInChat && (
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 font-mono shrink-0">
                            Active
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-[#9c978b] line-clamp-2 leading-relaxed mb-2">
                        {ag.description}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-1 pt-1 border-t border-[#292721]">
                      {ag.skills.slice(0, 2).map((sk) => (
                        <span
                          key={sk}
                          className="text-[10px] px-1.5 py-0.2 rounded bg-[#181713] text-[#a6a094] border border-[#2b2a22] font-mono"
                        >
                          #{sk.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Right Detail Preview */}
          <div className="hidden md:flex w-2/5 flex-col h-full overflow-y-auto p-5 bg-[#171613]">
            {previewAgent ? (
              <div className="flex flex-col h-full justify-between space-y-4">
                <div className="space-y-4">
                  <div className="flex items-center space-x-3">
                    <div className="w-11 h-11 rounded-xl bg-[#cc785c]/15 border border-[#cc785c]/40 flex items-center justify-center">
                      {getAgentIcon(previewAgent.avatarIcon)}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-[#f2eee6]">{previewAgent.name}</h3>
                      <p className="text-xs text-[#cc785c] font-medium">{previewAgent.role}</p>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-[#1f1e1a] border border-[#333129] space-y-1.5">
                    <h4 className="text-[11px] uppercase font-bold text-[#8a8579] tracking-wider font-mono">
                      Agent Profile
                    </h4>
                    <p className="text-xs text-[#dcd8ce] leading-relaxed">{previewAgent.description}</p>
                  </div>

                  <div className="space-y-1.5">
                    <h4 className="text-[11px] uppercase font-bold text-[#8a8579] tracking-wider font-mono">
                      Specialized Skills
                    </h4>
                    <div className="flex flex-wrap gap-1.5">
                      {previewAgent.skills.map((sk) => (
                        <span
                          key={sk}
                          className="text-[11px] px-2 py-0.5 rounded-lg bg-[#24221d] text-[#baa898] border border-[#35332a]"
                        >
                          ⚡ {sk.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <h4 className="text-[11px] uppercase font-bold text-[#8a8579] tracking-wider font-mono">
                      System Directive Preview
                    </h4>
                    <div className="p-3 rounded-xl bg-[#13120f] border border-[#26251f] text-[11px] text-[#9c978b] font-mono leading-relaxed max-h-48 overflow-y-auto">
                      {previewAgent.systemPrompt}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="pt-4 border-t border-[#2d2b24] space-y-2">
                  <button
                    onClick={() => {
                      onSelectAgent(previewAgent);
                      onClose();
                    }}
                    className="w-full py-2 px-3 rounded-xl bg-[#cc785c] hover:bg-[#db8a6e] text-black font-semibold text-xs shadow-md shadow-[#cc785c]/25 transition-all flex items-center justify-center gap-1.5 active:scale-98"
                  >
                    <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                    <span>Deploy Agent to Chat</span>
                  </button>

                  {onAddToSquad && (
                    <button
                      onClick={() => {
                        onAddToSquad(previewAgent);
                        onClose();
                      }}
                      className="w-full py-2 px-3 rounded-xl bg-[#282620] hover:bg-[#333129] border border-[#3f3c32] text-[#dcd8ce] font-semibold text-xs transition-all flex items-center justify-center gap-1.5"
                    >
                      <Crown className="w-3.5 h-3.5 text-[#cc785c]" />
                      <span>Assign to Executive Squad</span>
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-zinc-500">
                Select an agent to preview
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
