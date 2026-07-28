import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  getLlmSettings,
  listHarnesses,
  saveLlmSettings,
  type HarnessSummary,
  type LlmSettingsPublic,
  type ReasoningMode,
} from "../../api";

type Props = {
  open: boolean;
  onSaved?: (settings: LlmSettingsPublic) => void;
  onCloseLocked?: (locked: boolean) => void;
};

const REASONING_MODES: Array<{ id: ReasoningMode; label: string; hint: string }> = [
  { id: "auto", label: "自动", hint: "不附加服务商特定推理参数（默认）" },
  { id: "fast", label: "快速", hint: "更低推理开销，响应更快" },
  { id: "standard", label: "标准", hint: "平衡的推理强度" },
  { id: "deep", label: "深入", hint: "更强推理，兼容模型才生效" },
];

/** Agent 档位（修订模式）与推理强度。自定义服务的推理 opt-in 在模型页高级设置里。 */
export function AgentTab({ open, onSaved, onCloseLocked }: Props) {
  const [harnesses, setHarnesses] = useState<HarnessSummary[]>([]);
  const [harnessDefaultId, setHarnessDefaultId] = useState("");
  const [harnessId, setHarnessId] = useState("");
  const [savedHarnessId, setSavedHarnessId] = useState("");
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>("auto");
  const [savedReasoningMode, setSavedReasoningMode] = useState<ReasoningMode>("auto");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    setNotice(null);
    void Promise.all([getLlmSettings(), listHarnesses()])
      .then(([settings, harnessResult]) => {
        if (!active) return;
        setHarnesses(harnessResult.harnesses);
        setHarnessDefaultId(harnessResult.defaultId);
        const currentHarness = settings.harnessId ?? "";
        const currentReasoning = settings.reasoningMode ?? "auto";
        setHarnessId(currentHarness);
        setSavedHarnessId(currentHarness);
        setReasoningMode(currentReasoning);
        setSavedReasoningMode(currentReasoning);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    onCloseLocked?.(saving);
  }, [saving, onCloseLocked]);

  if (!open) return null;

  const busy = loading || saving;
  const dirty = harnessId !== savedHarnessId || reasoningMode !== savedReasoningMode;
  const harnessDefaultTitle = harnesses.find((h) => h.id === harnessDefaultId)?.title ?? "";

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const settings = await saveLlmSettings({
        harnessId: harnessId || null,
        reasoningMode,
      });
      onSaved?.(settings);
      setSavedHarnessId(harnessId);
      setSavedReasoningMode(reasoningMode);
      setNotice("已保存 Agent 设置。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-tab-body" aria-busy={busy}>
      {loading ? <p className="settings-msg" role="status">正在读取 Agent 设置…</p> : null}

      <label className="settings-field">
        <span>修订模式（写作档案）</span>
        <select
          value={harnessId}
          disabled={busy}
          onChange={(event) => setHarnessId(event.target.value)}
          aria-label="修订模式"
        >
          <option value="">
            默认{harnessDefaultTitle ? `（${harnessDefaultTitle}）` : ""}
          </option>
          {harnesses.map((harness) => (
            <option key={harness.id} value={harness.id}>
              {harness.title}
            </option>
          ))}
        </select>
        <small className="settings-field-note">决定提案与讨论使用的 Agent 档位</small>
      </label>

      <div className="settings-field" role="radiogroup" aria-label="推理强度">
        <span>推理强度</span>
        <div className="reasoning-mode-list">
          {REASONING_MODES.map((mode) => (
            <label key={mode.id} className="reasoning-mode">
              <input
                type="radio"
                name="reasoning-mode"
                role="radio"
                aria-checked={reasoningMode === mode.id}
                checked={reasoningMode === mode.id}
                disabled={busy}
                onChange={() => setReasoningMode(mode.id)}
              />
              <strong>{mode.label}</strong>
              <small>{mode.hint}</small>
            </label>
          ))}
        </div>
        <small className="settings-field-note">
          自动以外的档位仅对兼容模型生效；自定义服务需在模型页高级设置中明确启用推理控制。
        </small>
      </div>

      {notice ? <p className="settings-msg ok" role="status">{notice}</p> : null}
      {error ? <p className="settings-msg err" role="alert">{error}</p> : null}

      <footer className="settings-actions settings-footer">
        <button
          type="button"
          className="btn"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          <Check size={15} />
          {saving ? "保存中…" : "保存"}
        </button>
      </footer>
    </div>
  );
}
