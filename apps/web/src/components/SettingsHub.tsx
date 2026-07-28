import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { LlmSettingsPublic } from "../api";
import { useDialogFocus } from "../dialogFocus";
import { AgentTab } from "./settings/AgentTab";
import { MethodsTab } from "./settings/MethodsTab";
import { ModelTab } from "./settings/ModelTab";
import { ToolsTab } from "./settings/ToolsTab";

export type SettingsHubTab = "model" | "agent" | "methods" | "tools";

const TABS: Array<{ id: SettingsHubTab; label: string }> = [
  { id: "model", label: "模型" },
  { id: "agent", label: "Agent" },
  { id: "methods", label: "方法" },
  { id: "tools", label: "外部工具" },
];

type Props = {
  open: boolean;
  initialTab?: SettingsHubTab;
  onClose: () => void;
  onSaved?: (settings: LlmSettingsPublic) => void;
};

/**
 * 唯一的设置入口：模型 / Agent / 方法 / 外部工具四个视图。
 * 各视图共用 loading / success / error / empty / 启停 / 重试语义；
 * 只有运行时可用的配置才显示为“已启用”。
 */
export function SettingsHub({ open, initialTab = "model", onClose, onSaved }: Props) {
  const [tab, setTab] = useState<SettingsHubTab>(initialTab);
  const panelRef = useRef<HTMLDivElement>(null);
  const locksRef = useRef<Partial<Record<SettingsHubTab, boolean>>>({});
  const [closeLocked, setCloseLocked] = useState(false);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const reportLock = useCallback((id: SettingsHubTab, locked: boolean) => {
    locksRef.current[id] = locked;
    setCloseLocked(Object.values(locksRef.current).some(Boolean));
  }, []);

  const requestClose = useCallback(() => {
    if (Object.values(locksRef.current).some(Boolean)) return;
    onClose();
  }, [onClose]);

  useDialogFocus({
    active: open,
    containerRef: panelRef,
    canClose: () => !closeLocked,
    onEscape: requestClose,
  });

  if (!open) return null;

  return (
    <div className="settings-overlay" role="presentation">
      <div
        ref={panelRef}
        className="settings-panel wide settings-hub-panel"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <header className="settings-head">
          <div>
            <h2>设置</h2>
            <p>连接模型、调整 Agent 档位、管理方法与外部工具。保存后才会启用。</p>
          </div>
          <button
            type="button"
            className="settings-close"
            disabled={closeLocked}
            onClick={requestClose}
            aria-label="关闭设置"
            title="关闭"
          >
            <X size={18} />
          </button>
        </header>

        <nav className="settings-hub-tabs" role="tablist" aria-label="设置视图">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`settings-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`settings-panel-${item.id}`}
              className={tab === item.id ? "active" : ""}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="settings-hub-body">
          <div
            id="settings-panel-model"
            role="tabpanel"
            aria-labelledby="settings-tab-model"
            hidden={tab !== "model"}
          >
            <ModelTab
              open={open}
              onSaved={onSaved}
              onClose={onClose}
              onCloseLocked={(locked) => reportLock("model", locked)}
            />
          </div>
          <div
            id="settings-panel-agent"
            role="tabpanel"
            aria-labelledby="settings-tab-agent"
            hidden={tab !== "agent"}
          >
            <AgentTab open={open} onSaved={onSaved} onCloseLocked={(locked) => reportLock("agent", locked)} />
          </div>
          <div
            id="settings-panel-methods"
            role="tabpanel"
            aria-labelledby="settings-tab-methods"
            hidden={tab !== "methods"}
          >
            <MethodsTab open={open} onCloseLocked={(locked) => reportLock("methods", locked)} />
          </div>
          <div
            id="settings-panel-tools"
            role="tabpanel"
            aria-labelledby="settings-tab-tools"
            hidden={tab !== "tools"}
          >
            <ToolsTab open={open} onCloseLocked={(locked) => reportLock("tools", locked)} />
          </div>
        </div>
      </div>
    </div>
  );
}
