import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  CircleAlert,
  Crosshair,
  Globe,
  History,
  Layers,
  ListChecks,
  MessageSquare,
  Monitor,
  Moon,
  PanelRight,
  PanelRightClose,
  PictureInPicture2,
  RotateCcw,
  Settings2,
  Square,
  Sun,
  X,
} from "lucide-react";
import { ATTENTION_COPY, attentionMode } from "../attention";
import type { ReviewChecklistItem } from "@margin/domain";
import {
  listSkills,
  type AgentTask,
  type Comment,
  type Proposal,
  type ReviewChecklistBundle,
  type SessionContextUsage,
  type SkillSummary,
} from "../api";
import { executableChatRetry, type ChatRetryPayload } from "../chatRetry";
import { contextUsageCopy } from "../contextUsage";
import type { CascadeCandidate, ReviewThread } from "../store";
import { CascadeCard } from "./CascadeCard";
import { hasMarkdown, Markdown } from "./Markdown";
import { PromptChips } from "./PromptChips";
import { ReviewPanel } from "./ReviewPanel";
import { SourcePicker } from "./SourcePicker";
import { mentionableSkills } from "../extensionsModel";
import { submitEnterFrom } from "../ime";
import { formatElapsedTime } from "../sessionTime";
import { checklistOpenCount } from "../reviewChecklists";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  task?: AgentTask;
  threadId?: string;
  /** Skills actually loaded this turn (explicit selection or load_skill), name + hash. */
  loadedSkills?: Array<{ name: string; contentHash: string }>;
  retry?: ChatRetryPayload;
};

type Props = {
  messages: ChatMessage[];
  busy: boolean;
  statusHint?: string;
  landing?: boolean;
  docTitle?: string;
  documentPath?: string;
  documentId?: string;
  documentRevision?: number;
  llmMode?: "mock" | "byok";
  contextUsage?: SessionContextUsage | null;
  selectionHint?: string;
  selectionBlockCount?: number;
  sourcePaths?: string[];
  onToggleSourcePath?: (relativePath: string) => Promise<void>;
  cascadeOffer?: CascadeCandidate[] | null;
  onCascadeLocalOnly?: () => void;
  onCascadeConfirm?: (blockIds: string[]) => void;
  composerPrefill?: string | null;
  onComposerPrefillConsumed?: () => void;
  onSend: (text: string, opts?: { selectedSkills?: string[] }) => void;
  onCancel?: () => void;
  onContinueTask?: () => void;
  onRetryChat?: (errorMessageId: string) => void;
  onOpenSettings?: () => void;
  onOpenSessions?: () => void;
  onOpenDocx?: () => void;
  onClearSelection?: () => void;
  layoutMode?: "dock" | "float" | "focus";
  onLayoutModeChange?: (mode: "dock" | "float" | "focus") => void;
  activity?: "chat" | "review";
  onActivityChange?: (activity: "chat" | "review") => void;
  proposals?: Proposal[];
  comments?: Comment[];
  checklists?: ReviewChecklistBundle[];
  documentDirty?: boolean;
  reviewError?: string | null;
  reviewBusy?: boolean;
  onAccept?: (proposalId: string) => void;
  onEdit?: (proposalId: string, editedText: string) => void;
  onUndo?: (proposalId: string) => void;
  onRewrite?: (proposalId: string, blockId: string) => void;
  onActiveProposalChange?: (proposalId: string | null) => void;
  threads?: ReviewThread[];
  activeThreadId?: string | null;
  onOpenThread?: (thread: ReviewThread) => void;
  onChecklistDecision?: (
    runId: string,
    itemIds: string[],
    kind: "resolve" | "dismiss",
  ) => Promise<void>;
  onLocateChecklistItem?: (item: ReviewChecklistItem) => void;
  onHeaderPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
  themeMode?: "light" | "dark" | "system";
  onThemeModeChange?: (mode: "light" | "dark" | "system") => void;
};

export function Chat({
  messages,
  busy,
  statusHint,
  landing,
  docTitle,
  documentPath,
  documentId,
  documentRevision,
  llmMode,
  contextUsage,
  selectionHint,
  selectionBlockCount = 0,
  sourcePaths = [],
  onToggleSourcePath,
  cascadeOffer,
  onCascadeLocalOnly,
  onCascadeConfirm,
  composerPrefill,
  onComposerPrefillConsumed,
  onSend,
  onCancel,
  onContinueTask,
  onRetryChat,
  onOpenSettings,
  onOpenSessions,
  onOpenDocx,
  onClearSelection,
  layoutMode,
  onLayoutModeChange,
  activity = "chat",
  onActivityChange,
  proposals = [],
  comments = [],
  checklists = [],
  documentDirty = false,
  reviewError,
  reviewBusy = false,
  onAccept,
  onEdit,
  onUndo,
  onRewrite,
  onActiveProposalChange,
  threads = [],
  activeThreadId,
  onOpenThread,
  onChecklistDecision,
  onLocateChecklistItem,
  onHeaderPointerDown,
  themeMode,
  onThemeModeChange,
}: Props) {
  const [draft, setDraft] = useState("");
  const [skillOptions, setSkillOptions] = useState<SkillSummary[]>([]);
  const [pickedSkills, setPickedSkills] = useState<SkillSummary[]>([]);
  const [skillQuery, setSkillQuery] = useState<string | null>(null);
  const [busyElapsedSeconds, setBusyElapsedSeconds] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeActivity = landing ? "chat" : activity;
  const attention = attentionMode({
    hasSelection: Boolean(selectionHint),
    selectionBlockCount,
    sourceCount: sourcePaths.length,
  });
  const AttentionIcon = attention === "global" ? Globe : attention === "mixed" ? Layers : Crosshair;
  const attentionHint = ATTENTION_COPY[attention].hint;
  const reviewCount = proposals.length + checklistOpenCount(checklists);

  useEffect(() => {
    if (followTail.current || messages.at(-1)?.role === "user") {
      bottom.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [messages, busy, activeActivity]);

  useEffect(() => {
    if (!busy) {
      setBusyElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const update = () => setBusyElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (landing) inputRef.current?.focus();
  }, [landing]);

  useEffect(() => {
    if (!composerPrefill) return;
    setDraft(composerPrefill);
    onComposerPrefillConsumed?.();
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      const el = inputRef.current;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    }, 20);
    return () => window.clearTimeout(t);
  }, [composerPrefill, onComposerPrefillConsumed]);

  // Load the enabled skill list lazily the first time the @ picker opens.
  useEffect(() => {
    if (skillQuery === null || skillOptions.length) return;
    let active = true;
    void listSkills()
      .then((result) => {
        if (active) setSkillOptions(result.skills);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [skillQuery, skillOptions.length]);

  const updateDraft = (value: string, caret: number) => {
    setDraft(value);
    const before = value.slice(0, caret);
    const match = before.match(/(?:^|[\s，。；、（(])@([a-z0-9-]{0,64})$/i);
    setSkillQuery(match ? (match[1] ?? "").toLowerCase() : null);
  };

  const skillMatches = skillQuery === null
    ? []
    : mentionableSkills(skillOptions, skillQuery)
        .filter((skill) => !pickedSkills.some((picked) => picked.name === skill.name))
        .slice(0, 6);

  const pickSkill = (skill: SkillSummary) => {
    const caret = inputRef.current?.selectionStart ?? draft.length;
    setDraft(
      `${draft.slice(0, caret).replace(/@([a-z0-9-]{0,64})$/i, "")}${draft.slice(caret)}`,
    );
    setPickedSkills((current) =>
      current.some((picked) => picked.name === skill.name) ? current : [...current, skill],
    );
    setSkillQuery(null);
    inputRef.current?.focus();
  };

  const removeSkill = (name: string) => {
    setPickedSkills((current) => current.filter((skill) => skill.name !== name));
  };

  const submit = () => {
    const t = draft.trim();
    if (!t || busy) return;
    setDraft("");
    setSkillQuery(null);
    // Structured one-turn selection: ids travel in the request body,
    // never as raw @text, and chips clear after send.
    const ids = pickedSkills.map((skill) => skill.name);
    setPickedSkills([]);
    onSend(t, { selectedSkills: ids.length ? ids : undefined });
  };

  const handleComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && skillQuery !== null) {
      setSkillQuery(null);
      return;
    }
    // IME composition (isComposing) Enter confirms a candidate; never submit.
    if (submitEnterFrom(e)) {
      e.preventDefault();
      if (skillQuery !== null && skillMatches.length) pickSkill(skillMatches[0]!);
      else submit();
    }
  };

  const skillControls = (
    <>
      {pickedSkills.length ? (
        <div className="skill-chips" aria-label="本轮选用的 Skill">
          {pickedSkills.map((skill) => (
            <span key={skill.name} className="skill-chip" title={skill.description}>
              @{skill.name}
              <button
                type="button"
                className="skill-chip-remove"
                aria-label={`移除 ${skill.name}`}
                onClick={() => removeSkill(skill.name)}
              ><X size={11} /></button>
            </span>
          ))}
        </div>
      ) : null}
      {skillQuery !== null && skillMatches.length ? (
        <ul className="skill-picker" role="listbox" aria-label="选择 Skill">
          {skillMatches.map((skill) => (
            <li key={skill.name}>
              <button type="button" role="option" aria-selected={false} onClick={() => pickSkill(skill)}>
                <strong>@{skill.name}</strong>
                <small>{skill.description}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );

  const visibleMessages = messages
    // Anchored discussions have their own focused surface and inbox; rendering
    // them here as well makes one exchange appear twice while the popover is open.
    .filter((m) => !m.threadId && (m.role === "user" || m.text.trim()))
    .slice(-80);
  const showLandingStage = !!landing && visibleMessages.length <= 1 && !busy;
  const executableRetry = !busy
    ? executableChatRetry({
        messages,
        currentDocument: documentId !== undefined && documentRevision !== undefined
          ? { id: documentId, revision: documentRevision }
          : undefined,
        documentDirty,
        currentThreadIds: threads.map((thread) => thread.id),
      })
    : null;
  const retryMessageId = executableRetry?.errorMessageId ?? null;
  const contextCopy = contextUsage ? contextUsageCopy(contextUsage) : null;
  const themeIcon = themeMode === "dark" ? <Moon size={16} /> : themeMode === "light" ? <Sun size={16} /> : <Monitor size={16} />;
  const cycleTheme = () => {
    if (!themeMode || !onThemeModeChange) return;
    onThemeModeChange(themeMode === "system" ? "light" : themeMode === "light" ? "dark" : "system");
  };

  return (
    <div className={`chat-pane${landing ? " landing" : ""}${showLandingStage ? " stage" : ""}`}>
      <header className="shell-bar" onPointerDown={onHeaderPointerDown}>
        <div className="shell-brand">
          {!landing ? <span className="shell-logo">Margin</span> : <span className="shell-spacer" />}
        </div>
        <div className="shell-actions">
          {!landing && layoutMode && onLayoutModeChange ? (
            <div className="layout-control" role="group" aria-label="页面布局">
              <button type="button" className={layoutMode === "dock" ? "active" : ""} aria-label="停靠侧栏" title="停靠侧栏" onClick={() => onLayoutModeChange("dock")}><PanelRight size={15} /></button>
              <button type="button" className={layoutMode === "float" ? "active" : ""} aria-label="悬浮侧栏" title="悬浮侧栏" onClick={() => onLayoutModeChange("float")}><PictureInPicture2 size={15} /></button>
              <button type="button" className={layoutMode === "focus" ? "active" : ""} aria-label="专注文稿" title="专注文稿" onClick={() => onLayoutModeChange("focus")}><PanelRightClose size={15} /></button>
            </div>
          ) : null}
          {themeMode && onThemeModeChange ? (
            <button type="button" className="icon-button theme-cycle" aria-label="切换主题" title={`主题：${themeMode === "system" ? "跟随系统" : themeMode === "light" ? "浅色" : "深色"}`} onClick={cycleTheme}>{themeIcon}</button>
          ) : null}
          {llmMode !== "byok" ? <span className="connection-warning" title="当前为离线模式" aria-label="当前为离线模式"><CircleAlert /></span> : null}
          {onOpenSessions ? (
            <button
              type="button"
              className="icon-button sessions-trigger"
              title="会话"
              aria-label="会话管理"
              onClick={onOpenSessions}
            >
              <History size={17} strokeWidth={1.8} />
            </button>
          ) : null}
          {onOpenSettings ? (
            <button
              type="button"
              className="icon-button settings-trigger"
              title="设置"
              aria-label="设置"
              onClick={onOpenSettings}
            >
              <Settings2 size={17} strokeWidth={1.8} />
            </button>
          ) : null}
        </div>
      </header>

      {!landing && onActivityChange ? (
        <div className="activity-tabs" role="tablist" aria-label="工作区侧栏">
          <button type="button" role="tab" aria-selected={activity === "chat"} className={activity === "chat" ? "active" : ""} onClick={() => onActivityChange("chat")}><MessageSquare />对话</button>
          <button type="button" role="tab" aria-selected={activity === "review"} className={activity === "review" ? "active" : ""} onClick={() => onActivityChange("review")}><ListChecks />审阅{reviewCount ? <b>{reviewCount}</b> : null}</button>
        </div>
      ) : null}

      {showLandingStage ? (
        <div className="landing-stage">
          <div className="chat-hero">
            <p className="hero-eyebrow">本地文档修订 Agent</p>
            <h1 className="brand">Margin</h1>
            <p className="hero-line">打开文稿，边聊边改；修订逐条由你裁决——定稿由你接受。</p>
          </div>
          <div className="composer-wrap landing-composer">
            <div className={`composer-card${busy ? " busy" : ""}`}>
              {skillControls}
              <textarea
                ref={inputRef}
                value={draft}
                placeholder="问我任何事，或说「打开样章」…"
                rows={2}
                disabled={busy}
                onChange={(e) => updateDraft(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                onKeyDown={handleComposerKey}
              />
              <div className="composer-footer">
                <div className="composer-tools">
                  {contextCopy ? (
                    <span className="context-usage" title={contextCopy.title}>{contextCopy.label}</span>
                  ) : null}
                  <span className="composer-hint">Enter 发送</span>
                </div>
                <button
                  className="icon-button send"
                  type="button"
                  disabled={busy ? !onCancel : !draft.trim()}
                  onClick={busy ? onCancel : submit}
                  aria-label={busy ? "停止生成" : "发送"}
                  title={busy ? "停止生成" : "发送"}
                >
                  {busy ? <Square size={15} fill="currentColor" /> : <ArrowUp size={18} strokeWidth={2} />}
                </button>
              </div>
            </div>
            <PromptChips busy={busy} visible onSend={onSend} onOpenDocx={onOpenDocx} />
          </div>
        </div>
      ) : (
        <>
          {documentId && onAccept && onEdit && onUndo && onRewrite ? (
            <div className="sidecar-activity-body" hidden={activeActivity !== "review"}>
            <ReviewPanel
              proposals={proposals}
              comments={comments}
              checklists={checklists}
              documentId={documentId}
              busy={busy || reviewBusy}
              dirty={documentDirty}
              error={reviewError}
              onAccept={onAccept}
              onEdit={onEdit}
              onUndo={onUndo}
              onRewrite={onRewrite}
              onActiveProposalChange={activeActivity === "review" ? onActiveProposalChange : undefined}
              threads={threads}
              activeThreadId={activeThreadId}
              onOpenThread={onOpenThread}
              onChecklistDecision={onChecklistDecision ?? (async () => undefined)}
              onLocateChecklistItem={onLocateChecklistItem ?? (() => undefined)}
            />
            </div>
          ) : null}
          <div className="sidecar-activity-body chat-activity" hidden={activeActivity !== "chat"}>
          <div
            ref={messagesRef}
            className="messages"
            aria-live="polite"
            onScroll={() => {
              const node = messagesRef.current;
              if (!node) return;
              followTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
            }}
          >
            {visibleMessages.map((m) => (
              <div
                key={m.id}
                className={`turn ${m.role}`}
              >
                <div className="turn-meta">{m.role === "user" ? "你" : m.role === "system" ? "系统" : "Margin"}</div>
                <div className={`bubble ${m.role}`}>
                  {m.role === "assistant" && hasMarkdown(m.text) ? <Markdown text={m.text} /> : m.text}
                </div>
                {m.role === "assistant" && m.loadedSkills?.length ? (
                  <div className="loaded-skills">
                    已加载方法：{m.loadedSkills
                      .map((skill) => `${skill.name} · ${skill.contentHash.slice(0, 8)}`)
                      .join("、")}
                  </div>
                ) : null}
                {m.role === "assistant" && m.task ? (
                  <TaskReceipt task={m.task} onContinue={onContinueTask} />
                ) : null}
                {m.id === retryMessageId && onRetryChat ? (
                  <div className="task-receipt retry" role="status">
                    <span>请求未完成</span>
                    <button type="button" onClick={() => onRetryChat(m.id)}>
                      <RotateCcw size={12} aria-hidden />
                      重试
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            {cascadeOffer?.length && onCascadeLocalOnly && onCascadeConfirm ? (
              <CascadeCard
                candidates={cascadeOffer}
                busy={busy}
                onLocalOnly={onCascadeLocalOnly}
                onConfirm={onCascadeConfirm}
              />
            ) : null}
            <div ref={bottom} />
          </div>

          <div className="composer-wrap">
            {selectionHint || docTitle ? (
              <div
                className="attention-strip"
                title="Agent 每轮都能看到当前文档与大纲；选中文字时是优先焦点，全文仍可按需读取。"
              >
                {selectionHint && selectionBlockCount > 1 ? (
                  <span className="attention-chip focus" title={attentionHint}>
                    <AttentionIcon size={12} className="attention-chip-icon" aria-hidden />
                    {selectionBlockCount} 段选区
                  </span>
                ) : null}
                {selectionHint ? (
                  <span title={selectionBlockCount <= 1 ? attentionHint : undefined}>
                    {selectionBlockCount <= 1 ? (
                      <AttentionIcon size={12} className="attention-chip-icon" aria-hidden />
                    ) : null}
                    选区：{selectionHint}
                  </span>
                ) : null}
                {docTitle ? (
                  <span className="attention-chip" title={selectionHint ? undefined : attentionHint}>
                    {selectionHint ? null : (
                      <AttentionIcon size={12} className="attention-chip-icon" aria-hidden />
                    )}
                    {selectionHint ? "+ 全文大纲" : "全文"}
                  </span>
                ) : null}
                {sourcePaths.length ? (
                  <span className="attention-chip">资料 ×{sourcePaths.length}</span>
                ) : null}
                {onClearSelection ? (
                  <button type="button" className="linkish" onClick={onClearSelection}>
                    清除
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className={`composer-card${busy ? " busy" : ""}`}>
              {skillControls}
              <textarea
                ref={inputRef}
                value={draft}
                placeholder={
                  selectionHint
                    ? "针对选区提问，或写「重写：更克制」…"
                    : docTitle
                      ? "继续讨论，或让我改选中段落…"
                      : "继续…"
                }
                rows={draft.length > 80 ? 4 : 2}
                disabled={busy}
                onChange={(e) => updateDraft(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                onKeyDown={handleComposerKey}
              />
              <div className="composer-footer">
                <div className="composer-tools">
                  {!landing && onToggleSourcePath ? (
                    <SourcePicker
                      attachedPaths={sourcePaths}
                      busy={busy}
                      documentPath={documentPath}
                      onToggle={onToggleSourcePath}
                    />
                  ) : null}
                  <span className="composer-hint" role={busy ? "status" : undefined}>
                    {busy ? <>
                      <i className="busy-dot" aria-hidden />
                      {statusHint || "正在处理"}
                      {busyElapsedSeconds >= 10 ? ` · ${formatElapsedTime(busyElapsedSeconds)}` : ""}
                    </> : null}
                  </span>
                  {contextCopy ? (
                    <span className="context-usage" title={contextCopy.title}>{contextCopy.label}</span>
                  ) : null}
                </div>
                <button
                  className="icon-button send"
                  type="button"
                  disabled={busy ? !onCancel : !draft.trim()}
                  onClick={busy ? onCancel : submit}
                  aria-label={busy ? "停止生成" : "发送"}
                  title={busy ? "停止生成" : "发送"}
                >
                  {busy ? <Square size={15} fill="currentColor" /> : <ArrowUp size={18} strokeWidth={2} />}
                </button>
              </div>
            </div>
          </div>
          </div>
        </>
      )}
    </div>
  );
}

function TaskReceipt({ task, onContinue }: { task: AgentTask; onContinue?: () => void }) {
  const sourceCount = new Set(task.sourceRefs.map((ref) => ref.split("#", 1)[0])).size;
  const meaningful = task.status === "interrupted" || sourceCount > 0 || task.proposalCount > 0 || task.consistencyChecked;
  if (!meaningful) return null;
  if (task.status === "interrupted") {
    return (
      <div className="task-receipt interrupted">
        <span>本轮已停止</span>
        {onContinue ? <button type="button" onClick={onContinue}>继续</button> : null}
      </div>
    );
  }
  const facts = [
    sourceCount ? `读取 ${sourceCount} 份资料` : null,
    task.proposalCount ? `${task.proposalCount} 处待审` : null,
    task.consistencyChecked ? "已核对全文联动" : null,
  ].filter(Boolean);
  return <div className="task-receipt" aria-label="本轮工作">{facts.join(" · ")}</div>;
}
