'use client';

import React, { useEffect, useState } from 'react';
import { ShieldAlert, Check, X, Terminal, FileCode, AlertTriangle, Clock } from 'lucide-react';

export interface PendingApproval {
  id: string;
  tool: string;
  args: Record<string, any>;
  timestamp: number;
}

interface ApprovalModalProps {
  pendingApprovals: PendingApproval[];
  onRespond: (id: string, approved: boolean) => void;
}

export default function ApprovalModal({ pendingApprovals, onRespond }: ApprovalModalProps) {
  const [timeLeftMap, setTimeLeftMap] = useState<Record<string, number>>({});

  useEffect(() => {
    if (pendingApprovals.length === 0) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const updated: Record<string, number> = {};
      pendingApprovals.forEach((appr) => {
        const elapsedSec = Math.floor((now - appr.timestamp) / 1000);
        const remaining = Math.max(0, 60 - elapsedSec);
        updated[appr.id] = remaining;
      });
      setTimeLeftMap(updated);
    }, 1000);

    return () => clearInterval(interval);
  }, [pendingApprovals]);

  if (pendingApprovals.length === 0) return null;

  const current = pendingApprovals[0];
  const remainingSec = timeLeftMap[current.id] ?? 60;

  const isShell = current.tool === 'shell_command';
  const isFile = current.tool === 'workspace_write_file';

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-[#1f1d19] border border-amber-500/40 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[#f2eee6] flex items-center gap-2">
                Action Approval Required
                {pendingApprovals.length > 1 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-mono">
                    +{pendingApprovals.length - 1} more
                  </span>
                )}
              </h3>
              <p className="text-xs text-[#a8a29e]">
                An autonomous agent is requesting permission to execute a system command.
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-1 text-xs text-amber-400/90 font-mono bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20">
            <Clock className="w-3.5 h-3.5 animate-spin" />
            <span>{remainingSec}s</span>
          </div>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 text-xs text-[#dcd8ce]">
          <div className="flex items-center justify-between pb-2 border-b border-[#2d2a24]">
            <span className="text-[#8e897f]">Requested Tool:</span>
            <span className="font-mono px-2 py-0.5 rounded bg-[#2b2923] text-amber-300 border border-[#3b3830] flex items-center gap-1.5">
              {isShell ? <Terminal className="w-3.5 h-3.5" /> : isFile ? <FileCode className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
              {current.tool}
            </span>
          </div>

          {/* Details / Command Preview */}
          <div className="space-y-1.5">
            <span className="text-[#8e897f]">Execution Payload:</span>
            <div className="bg-[#141310] border border-[#2b2923] rounded-xl p-3 font-mono text-xs text-[#f2eee6] overflow-x-auto max-h-48 whitespace-pre-wrap select-text">
              {isShell && (
                <div>
                  <div className="text-[#8e897f] text-[10px] mb-1">COMMAND:</div>
                  <span className="text-emerald-400">$ {String(current.args.command || '')}</span>
                  {current.args.cwd && (
                    <div className="text-[10px] text-[#8e897f] mt-2">
                      CWD: <span className="text-[#a8a29e]">{String(current.args.cwd)}</span>
                    </div>
                  )}
                </div>
              )}
              {isFile && (
                <div>
                  <div className="text-[#8e897f] text-[10px] mb-1">PATH: {String(current.args.path || '')}</div>
                  <div className="text-[10px] text-[#8e897f] mt-1 mb-0.5">CONTENT PREVIEW:</div>
                  <div className="text-[#a8a29e] line-clamp-6">{String(current.args.content || '').slice(0, 500)}</div>
                </div>
              )}
              {!isShell && !isFile && (
                <pre>{JSON.stringify(current.args, null, 2)}</pre>
              )}
            </div>
          </div>

          <div className="bg-amber-500/5 border border-amber-500/10 rounded-xl p-3 flex items-start space-x-2 text-[11px] text-[#b8b2a7]">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <span>
              Always verify commands before approving. Denying will safely cancel the execution without interrupting your chat.
            </span>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 bg-[#171612] border-t border-[#2d2a24] flex items-center justify-end space-x-3">
          <button
            onClick={() => onRespond(current.id, false)}
            className="flex items-center space-x-1.5 px-4 py-2 rounded-xl text-xs font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 border border-rose-500/20 transition-all"
          >
            <X className="w-4 h-4" />
            <span>Deny Execution</span>
          </button>
          <button
            onClick={() => onRespond(current.id, true)}
            className="flex items-center space-x-1.5 px-5 py-2 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 shadow-lg shadow-emerald-900/30 transition-all"
          >
            <Check className="w-4 h-4" />
            <span>Approve & Execute</span>
          </button>
        </div>
      </div>
    </div>
  );
}
