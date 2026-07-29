import type { Decision, DecisionKind, Proposal } from "@margin/domain";
import {
  getLatestDecision,
  listProposals,
  type PersistedAgentSession,
  type Workspace,
} from "@margin/storage-local";

const NOTE_PREFIX = "[Margin 记录]";
const MAX_TARGET_SUMMARY_CHARS = 60;
const MAX_DECISION_DETAIL_CHARS = 200;
const MAX_TOPIC_CHARS = 200;
const MAX_APPLY_SUMMARIES = 5;
const MAX_PENDING_IN_HINT = 8;
const MAX_RECENT_DECISIONS = 5;

const DECISION_LABELS: Record<DecisionKind, string> = {
  Y: "接受",
  N: "拒绝",
  E: "编辑后接受",
};

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Short target summary identifying a proposal to the model. */
function targetSummary(proposal: Proposal): string {
  return collapse(proposal.before).slice(0, MAX_TARGET_SUMMARY_CHARS);
}

/** Decision recorded back into the pi transcript so later turns see the verdict. */
export function decisionConversationNote(proposal: Proposal, decision: Decision): string {
  let note = `${NOTE_PREFIX} 用户裁决：提案 ${proposal.id}（"${targetSummary(proposal)}"）= ${DECISION_LABELS[decision.kind]}`;
  if (decision.kind === "E" && decision.editedText) {
    note += `；编辑后文本："${collapse(decision.editedText).slice(0, MAX_DECISION_DETAIL_CHARS)}"`;
  }
  if (decision.kind === "N" && decision.reason?.trim()) {
    note += `；理由：${collapse(decision.reason).slice(0, MAX_DECISION_DETAIL_CHARS)}`;
  }
  return `${note}。`;
}

/** Apply write-back note: which accepted proposals landed in the document. */
export function applyConversationNote(proposals: Proposal[]): string {
  const shown = proposals
    .slice(0, MAX_APPLY_SUMMARIES)
    .map((proposal) => `"${targetSummary(proposal)}"`)
    .join("；");
  const remaining = proposals.length > MAX_APPLY_SUMMARIES
    ? `；…共 ${proposals.length} 条`
    : "";
  return `${NOTE_PREFIX} 已写入 ${proposals.length} 条已接受提案：${shown}${remaining}。`;
}

type DecisionCounts = Record<DecisionKind, number>;

function latestDecisions(
  ws: Workspace,
  proposals: Proposal[],
): { counts: DecisionCounts; decided: Array<{ proposal: Proposal; decision: Decision }> } {
  const counts: DecisionCounts = { Y: 0, N: 0, E: 0 };
  const decided: Array<{ proposal: Proposal; decision: Decision }> = [];
  for (const proposal of proposals) {
    const decision = getLatestDecision(ws, proposal.id);
    if (!decision) continue;
    counts[decision.kind] += 1;
    decided.push({ proposal, decision });
  }
  return { counts, decided };
}

/** Per-turn prompt section: pending proposals + decision tallies (read-only, no LLM). */
export function buildProposalHint(ws: Workspace, documentId: string): string {
  const proposals = listProposals(ws, documentId);
  const pending = proposals.filter((proposal) => proposal.status === "proposed");
  const { counts } = latestDecisions(ws, proposals);
  const decidedTotal = counts.Y + counts.N + counts.E;
  if (!pending.length && !decidedTotal) return "";
  const lines = ["[提案状态]"];
  if (pending.length) {
    lines.push(`待裁决提案 ${pending.length} 条：`);
    for (const proposal of pending.slice(0, MAX_PENDING_IN_HINT)) {
      lines.push(`- ${proposal.id}：「${targetSummary(proposal)}」`);
    }
    if (pending.length > MAX_PENDING_IN_HINT) {
      lines.push(`- …其余 ${pending.length - MAX_PENDING_IN_HINT} 条略`);
    }
  }
  if (decidedTotal) {
    lines.push(`已裁决：接受 ${counts.Y}、拒绝 ${counts.N}、编辑 ${counts.E}。`);
  }
  return lines.join("\n");
}

/**
 * First note of a fresh session: topic + decision stats from the archived
 * envelope and the proposals/decisions tables. Undefined when nothing to say.
 */
export function buildSessionSummaryNote(
  ws: Workspace,
  envelope: PersistedAgentSession,
): string | undefined {
  const segments: string[] = [];
  const topicSource =
    envelope.task?.objective?.trim() ||
    envelope.chatTurns.find((turn) => turn.role === "user")?.text.trim() ||
    "";
  const topic = collapse(topicSource).slice(0, MAX_TOPIC_CHARS);
  if (topic) segments.push(`主题「${topic}」`);
  if (envelope.documentId) {
    const proposals = listProposals(ws, envelope.documentId);
    const { counts, decided } = latestDecisions(ws, proposals);
    const decidedTotal = counts.Y + counts.N + counts.E;
    if (decidedTotal) {
      segments.push(`当前文档裁决：已接受 ${counts.Y}、已拒绝 ${counts.N}、已编辑 ${counts.E}`);
      const recent = decided
        .sort((a, b) => b.decision.createdAt.localeCompare(a.decision.createdAt))
        .slice(0, MAX_RECENT_DECISIONS)
        .map(({ proposal, decision }) =>
          `「${targetSummary(proposal)}」=${DECISION_LABELS[decision.kind]}`);
      segments.push(`最近裁决：${recent.join("、")}`);
    }
    const pending = proposals.filter((proposal) => proposal.status === "proposed").length;
    if (pending) segments.push(`待裁决提案 ${pending} 条`);
  }
  if (!segments.length) return undefined;
  return `${NOTE_PREFIX} 上一会话摘要：${segments.join("；")}。`;
}

const MAX_SNAPSHOT_PER_SECTION = 8;

/**
 * Domain snapshot appended to the compaction summarizer input: proposal ids
 * with their Y/N/E verdicts (E carries the edited text), plus the pending
 * queue — the facts a summary must not lose. Empty when nothing to preserve.
 */
export function buildDomainSnapshot(ws: Workspace, documentId: string): string {
  const proposals = listProposals(ws, documentId);
  if (!proposals.length) return "";
  const pending = proposals.filter((proposal) => proposal.status === "proposed");
  const { decided } = latestDecisions(ws, proposals);
  if (!pending.length && !decided.length) return "";

  const lines = ["[Margin 裁决状态快照]"];
  const byKind = (kind: DecisionKind) =>
    decided.filter(({ decision }) => decision.kind === kind);
  for (const kind of ["Y", "N", "E"] as const) {
    const group = byKind(kind);
    if (!group.length) continue;
    for (const { proposal, decision } of group.slice(0, MAX_SNAPSHOT_PER_SECTION)) {
      let line = `- ${proposal.id}：「${targetSummary(proposal)}」= ${DECISION_LABELS[kind]}`;
      if (kind === "E" && decision.editedText) {
        line += `；编辑后文本："${collapse(decision.editedText).slice(0, MAX_DECISION_DETAIL_CHARS)}"`;
      }
      if (kind === "N" && decision.reason?.trim()) {
        line += `；理由：${collapse(decision.reason).slice(0, MAX_DECISION_DETAIL_CHARS)}`;
      }
      lines.push(line);
    }
    if (group.length > MAX_SNAPSHOT_PER_SECTION) {
      lines.push(`- …其余 ${group.length - MAX_SNAPSHOT_PER_SECTION} 条${DECISION_LABELS[kind]}略`);
    }
  }
  if (pending.length) {
    lines.push(`待裁决提案 ${pending.length} 条：`);
    for (const proposal of pending.slice(0, MAX_SNAPSHOT_PER_SECTION)) {
      lines.push(`- ${proposal.id}：「${targetSummary(proposal)}」`);
    }
    if (pending.length > MAX_SNAPSHOT_PER_SECTION) {
      lines.push(`- …其余 ${pending.length - MAX_SNAPSHOT_PER_SECTION} 条略`);
    }
  }
  return lines.join("\n");
}
