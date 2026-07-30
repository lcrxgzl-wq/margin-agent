import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  AGENT_TIMEOUT_DEFAULT_SECONDS,
  AGENT_TIMEOUT_MAX_SECONDS,
  AGENT_TIMEOUT_MIN_SECONDS,
  agentTimeoutMsToSeconds,
  agentTimeoutSecondsToMs,
} from "../../agentTimeout";
import {
  SELECTION_CONTEXT_MAX_CHARS,
  SELECTION_CONTEXT_MIN_CHARS,
  selectionContextCharsToInput,
  selectionContextInputToChars,
} from "../../selectionContext";
import {
  getLlmSettings,
  listHarnesses,
  saveLlmSettings,
  type ContextTier,
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

const CONTEXT_TIERS: Array<{ id: ContextTier; label: string; hint: string }> = [
  { id: "eco", label: "节省", hint: "更小上下文与预算，token 成本最低" },
  { id: "standard", label: "标准", hint: "默认档位，上下文与成本均衡" },
  { id: "max", label: "最强", hint: "最大上下文与预算，效果最好，token 成本最高" },
];

const TIMEOUT_PRESETS = [
  { seconds: 300, label: "5 分钟" },
  { seconds: 600, label: "10 分钟" },
  { seconds: 1_200, label: "20 分钟" },
  { seconds: 1_800, label: "30 分钟" },
] as const;
const SELECTION_CONTEXT_PRESETS = [12_000, 32_000, 64_000, 100_000] as const;
const TIER_SELECTION_DEFAULTS: Record<ContextTier, number> = {
  eco: 2_000,
  standard: 12_000,
  max: 48_000,
};

/** Agent 档位（修订模式）与推理强度。自定义服务的推理 opt-in 在模型页高级设置里。 */
export function AgentTab({ open, onSaved, onCloseLocked }: Props) {
  const [harnesses, setHarnesses] = useState<HarnessSummary[]>([]);
  const [harnessDefaultId, setHarnessDefaultId] = useState("");
  const [harnessId, setHarnessId] = useState("");
  const [savedHarnessId, setSavedHarnessId] = useState("");
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>("auto");
  const [savedReasoningMode, setSavedReasoningMode] = useState<ReasoningMode>("auto");
  const [contextTier, setContextTier] = useState<ContextTier>("standard");
  const [savedContextTier, setSavedContextTier] = useState<ContextTier>("standard");
  const [compactionAuto, setCompactionAuto] = useState(true);
  const [savedCompactionAuto, setSavedCompactionAuto] = useState(true);
  const [timeoutInput, setTimeoutInput] = useState("");
  const [savedTimeoutInput, setSavedTimeoutInput] = useState("");
  const [selectionContextInput, setSelectionContextInput] = useState("");
  const [savedSelectionContextInput, setSavedSelectionContextInput] = useState("");
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
        const currentTier = settings.contextTier ?? "standard";
        setContextTier(currentTier);
        setSavedContextTier(currentTier);
        const currentCompactionAuto = settings.compactionAuto !== false;
        setCompactionAuto(currentCompactionAuto);
        setSavedCompactionAuto(currentCompactionAuto);
        const currentTimeout = agentTimeoutMsToSeconds(settings.agentTimeoutMs);
        setTimeoutInput(currentTimeout);
        setSavedTimeoutInput(currentTimeout);
        const currentSelectionContext = selectionContextCharsToInput(
          settings.selectionContextChars,
        );
        setSelectionContextInput(currentSelectionContext);
        setSavedSelectionContextInput(currentSelectionContext);
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
  const dirty =
    harnessId !== savedHarnessId ||
    reasoningMode !== savedReasoningMode ||
    contextTier !== savedContextTier ||
    compactionAuto !== savedCompactionAuto ||
    timeoutInput !== savedTimeoutInput ||
    selectionContextInput !== savedSelectionContextInput;
  const harnessDefaultTitle = harnesses.find((h) => h.id === harnessDefaultId)?.title ?? "";

  const save = async () => {
    if (!dirty) return;
    const agentTimeoutMs = agentTimeoutSecondsToMs(timeoutInput);
    if (agentTimeoutMs === undefined) {
      setError(
        `请求超时需为 ${AGENT_TIMEOUT_MIN_SECONDS}–${AGENT_TIMEOUT_MAX_SECONDS} 的整数秒，或留空使用默认值。`,
      );
      return;
    }
    const selectionContextChars = selectionContextInputToChars(selectionContextInput);
    if (selectionContextChars === undefined) {
      setError(
        `选区上下文需为 ${SELECTION_CONTEXT_MIN_CHARS}–${SELECTION_CONTEXT_MAX_CHARS} 的整数，或留空跟随上下文档位。`,
      );
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const settings = await saveLlmSettings({
        harnessId: harnessId || null,
        reasoningMode,
        agentTimeoutMs,
        selectionContextChars,
        contextTier,
        compactionAuto,
      });
      onSaved?.(settings);
      setSavedHarnessId(harnessId);
      setSavedReasoningMode(reasoningMode);
      setSavedContextTier(contextTier);
      setSavedCompactionAuto(compactionAuto);
      setSavedTimeoutInput(timeoutInput);
      setSavedSelectionContextInput(selectionContextInput);
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

      <div className="settings-field" role="radiogroup" aria-label="上下文档位">
        <span>上下文档位</span>
        <div className="reasoning-mode-list">
          {CONTEXT_TIERS.map((tier) => (
            <label key={tier.id} className="reasoning-mode">
              <input
                type="radio"
                name="context-tier"
                role="radio"
                aria-checked={contextTier === tier.id}
                checked={contextTier === tier.id}
                disabled={busy}
                onChange={() => setContextTier(tier.id)}
              />
              <strong>{tier.label}</strong>
              <small>{tier.hint}</small>
            </label>
          ))}
        </div>
        <small className="settings-field-note">
          决定选区内联长度、大纲规模与上下文预算；档位越高，单次请求消耗的 token 越多。
        </small>
      </div>

      <div className="settings-field">
        <span id="selection-context-label">选区上下文上限（字符）</span>
        <input
          type="number"
          min={SELECTION_CONTEXT_MIN_CHARS}
          max={SELECTION_CONTEXT_MAX_CHARS}
          step={1}
          value={selectionContextInput}
          disabled={busy}
          placeholder={String(TIER_SELECTION_DEFAULTS[contextTier])}
          onChange={(event) => setSelectionContextInput(event.target.value)}
          aria-labelledby="selection-context-label"
        />
        <div className="preset-row" aria-label="选区上下文快捷值">
          {SELECTION_CONTEXT_PRESETS.map((chars) => (
            <button
              key={chars}
              type="button"
              className={selectionContextInput === String(chars) ? "chip accent" : "chip"}
              disabled={busy}
              aria-pressed={selectionContextInput === String(chars)}
              onClick={() => setSelectionContextInput(String(chars))}
            >
              {chars.toLocaleString("zh-CN")}
            </button>
          ))}
        </div>
        <small className="settings-field-note">
          留空跟随上下文档位；当前档位默认 {TIER_SELECTION_DEFAULTS[contextTier].toLocaleString("zh-CN")} 字符
        </small>
      </div>

      <div className="settings-field">
        <span>自动压缩上下文</span>
        <label className="settings-field-inline">
          <input
            type="checkbox"
            checked={compactionAuto}
            disabled={busy}
            onChange={(event) => setCompactionAuto(event.target.checked)}
            aria-label="自动压缩上下文"
          />
          <span>接近上下文上限时自动摘要旧对话</span>
        </label>
        <small className="settings-field-note">
          压缩前记录会完整存档；关闭后超长对话将退化为直接截断。节省（eco）档位始终不启用摘要。
        </small>
      </div>

      <div className="settings-field">
        <span id="agent-timeout-label">请求超时（秒）</span>
        <input
          type="number"
          min={AGENT_TIMEOUT_MIN_SECONDS}
          max={AGENT_TIMEOUT_MAX_SECONDS}
          step={1}
          value={timeoutInput}
          disabled={busy}
          placeholder={String(AGENT_TIMEOUT_DEFAULT_SECONDS)}
          onChange={(event) => setTimeoutInput(event.target.value)}
          aria-labelledby="agent-timeout-label"
        />
        <div className="preset-row" aria-label="请求超时快捷值">
          {TIMEOUT_PRESETS.map(({ seconds, label }) => (
            <button
              key={seconds}
              type="button"
              className={timeoutInput === String(seconds) ? "chip accent" : "chip"}
              disabled={busy}
              aria-pressed={timeoutInput === String(seconds)}
              onClick={() => setTimeoutInput(String(seconds))}
            >
              {label}
            </button>
          ))}
        </div>
        <small className="settings-field-note">
          单次 Agent 请求的最长等待（{AGENT_TIMEOUT_MIN_SECONDS}–{AGENT_TIMEOUT_MAX_SECONDS} 秒）；留空使用默认 {AGENT_TIMEOUT_DEFAULT_SECONDS} 秒
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
