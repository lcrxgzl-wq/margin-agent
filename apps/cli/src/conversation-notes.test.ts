import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BlockSnapshot, Decision, DocumentMeta, Proposal } from "@margin/domain";
import {
  getLatestDecision,
  listBlocks,
  openDocument,
  openWorkspace,
  saveDecision,
  saveProposal,
  type PersistedAgentSession,
  type Workspace,
} from "@margin/storage-local";
import {
  applyConversationNote,
  buildDomainSnapshot,
  buildProposalHint,
  buildSessionSummaryNote,
  decisionConversationNote,
} from "./conversation-notes.js";

const dirs: string[] = [];
const workspaces: Workspace[] = [];
let proposalSequence = 0;

afterEach(async () => {
  for (const ws of workspaces.splice(0)) {
    try { ws.db.close(); } catch { /* ignore */ }
    try { await ws.releaseLock(); } catch { /* ignore */ }
  }
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function testWorkspace(markdown = "first paragraph\n\nsecond paragraph\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-notes-"));
  dirs.push(root);
  fs.writeFileSync(path.join(root, "paper.md"), markdown, "utf8");
  const ws = await openWorkspace(root);
  workspaces.push(ws);
  const document = openDocument(ws, "paper.md");
  return { ws, document, blocks: listBlocks(ws, document.id) };
}

function proposalFor(
  document: DocumentMeta,
  block: BlockSnapshot,
  overrides: Partial<Proposal> = {},
): Proposal {
  proposalSequence += 1;
  return {
    schemaVersion: 1,
    id: `proposal-${proposalSequence}`,
    documentId: document.id,
    blockId: block.id,
    baseRevision: document.revision,
    baseHash: block.contentHash,
    before: block.text,
    after: `${block.text} revised`,
    rationale: "test revision",
    risk: "language",
    evidence: [],
    status: "proposed",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, proposalSequence)).toISOString(),
    ...overrides,
  };
}

function decisionFor(proposalId: string, overrides: Partial<Decision> = {}): Decision {
  return {
    schemaVersion: 1,
    id: `decision-${proposalId}`,
    proposalId,
    kind: "Y",
    createdAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

const docMeta: DocumentMeta = {
  id: "doc-1",
  relativePath: "paper.md",
  revision: 0,
  contentHash: "hash",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

const block: BlockSnapshot = {
  id: "block-1",
  kind: "paragraph",
  text: "first paragraph",
  order: 0,
  contentHash: "bh",
};

describe("decisionConversationNote", () => {
  it("records an accept with the proposal target summary", () => {
    const proposal = proposalFor(docMeta, block, { id: "prop-accept" });
    const note = decisionConversationNote(proposal, decisionFor(proposal.id));
    expect(note).toBe(
      '[Margin 记录] 用户裁决：提案 prop-accept（"first paragraph"）= 接受。',
    );
  });

  it("records a rejection with its reason", () => {
    const proposal = proposalFor(docMeta, block, { id: "prop-reject" });
    const note = decisionConversationNote(
      proposal,
      decisionFor(proposal.id, { kind: "N", reason: "改得太生硬" }),
    );
    expect(note).toContain("= 拒绝");
    expect(note).toContain("理由：改得太生硬");
    expect(note.startsWith("[Margin 记录] ")).toBe(true);
  });

  it("records an edited accept with the edited text bounded to 200 chars", () => {
    const proposal = proposalFor(docMeta, block, { id: "prop-edit" });
    const editedText = "改".repeat(300);
    const note = decisionConversationNote(
      proposal,
      decisionFor(proposal.id, { kind: "E", editedText }),
    );
    expect(note).toContain("= 编辑后接受");
    expect(note).toContain(`编辑后文本："${"改".repeat(200)}"`);
    expect(note).not.toContain("改".repeat(201));
  });

  it("bounds the proposal target summary to 60 chars", () => {
    const longBefore = "长".repeat(100);
    const proposal = proposalFor(docMeta, { ...block, text: longBefore }, { before: longBefore });
    const note = decisionConversationNote(proposal, decisionFor(proposal.id));
    expect(note).toContain(`（"${"长".repeat(60)}"）`);
    expect(note).not.toContain("长".repeat(61));
  });
});

describe("applyConversationNote", () => {
  it("records the count and target summaries of written proposals", () => {
    const first = proposalFor(docMeta, block, { id: "prop-1" });
    const second = proposalFor(
      docMeta,
      { ...block, id: "block-2", text: "second paragraph" },
      { id: "prop-2", blockId: "block-2", before: "second paragraph" },
    );
    expect(applyConversationNote([first, second])).toBe(
      '[Margin 记录] 已写入 2 条已接受提案："first paragraph"；"second paragraph"。',
    );
  });

  it("bounds the listing to 5 summaries", () => {
    const proposals = Array.from({ length: 6 }, (_, index) =>
      proposalFor(docMeta, block, { id: `prop-${index}`, before: `段落${index}` }));
    const note = applyConversationNote(proposals);
    expect(note).toContain("已写入 6 条已接受提案");
    expect(note).toContain("段落4");
    expect(note).not.toContain("段落5");
  });
});

describe("buildProposalHint", () => {
  it("is empty when the document has no proposals and no decisions", async () => {
    const { ws, document } = await testWorkspace();
    expect(buildProposalHint(ws, document.id)).toBe("");
  });

  it("lists pending proposals with ids and summaries plus decision counts", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const pendingA = proposalFor(document, blocks[0]!);
    const pendingB = proposalFor(document, blocks[1]!);
    const decided = proposalFor(document, blocks[0]!, { before: "decided target" });
    saveProposal(ws, pendingA);
    saveProposal(ws, pendingB);
    saveProposal(ws, decided);
    saveDecision(ws, decided.id, "Y");

    const hint = buildProposalHint(ws, document.id);

    expect(hint).toContain("[提案状态]");
    expect(hint).toContain("待裁决提案 2 条");
    expect(hint).toContain(`- ${pendingA.id}：「first paragraph」`);
    expect(hint).toContain(`- ${pendingB.id}：「second paragraph」`);
    expect(hint).toContain("已裁决：接受 1、拒绝 0、编辑 0。");
    expect(hint).not.toContain("decided target」\n");
  });

  it("keeps only decision counts when nothing is pending", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const decided = proposalFor(document, blocks[0]!);
    saveProposal(ws, decided);
    saveDecision(ws, decided.id, "N", undefined, "不合适");

    const hint = buildProposalHint(ws, document.id);

    expect(hint).not.toContain("待裁决提案");
    expect(hint).toContain("已裁决：接受 0、拒绝 1、编辑 0。");
  });

  it("lists at most 8 pending proposals", async () => {
    const { ws, document, blocks } = await testWorkspace();
    for (let index = 0; index < 9; index += 1) {
      saveProposal(ws, proposalFor(document, blocks[0]!, { before: `候选${index}` }));
    }

    const hint = buildProposalHint(ws, document.id);

    expect(hint).toContain("待裁决提案 9 条");
    expect(hint).toContain("候选7");
    expect(hint).not.toContain("候选8」");
  });
});

describe("buildSessionSummaryNote", () => {
  function envelopeFor(overrides: Partial<PersistedAgentSession> = {}): PersistedAgentSession {
    return {
      sessionId: "s-old",
      messages: [],
      updatedAt: "2026-07-28T00:00:00.000Z",
      clarificationRounds: 0,
      chatTurns: [],
      threads: [],
      sourcePaths: [],
      ...overrides,
    };
  }

  it("summarizes topic, decision stats and pending count from the archived envelope", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const accepted = proposalFor(document, blocks[0]!, { before: "accepted target" });
    const rejected = proposalFor(document, blocks[1]!, { before: "rejected target" });
    const pending = proposalFor(document, blocks[0]!);
    saveProposal(ws, accepted);
    saveProposal(ws, rejected);
    saveProposal(ws, pending);
    saveDecision(ws, accepted.id, "Y");
    saveDecision(ws, rejected.id, "N", undefined, "太生硬");

    const note = buildSessionSummaryNote(ws, envelopeFor({
      documentId: document.id,
      chatTurns: [{ role: "user", text: "帮我润色引言部分" }],
    }));

    expect(note).toBeDefined();
    expect(note).toContain("[Margin 记录] 上一会话摘要");
    expect(note).toContain("主题「帮我润色引言部分」");
    expect(note).toContain("已接受 1、已拒绝 1、已编辑 0");
    expect(note).toContain("「accepted target」=接受");
    expect(note).toContain("「rejected target」=拒绝");
    expect(note).toContain("待裁决提案 1 条");
  });

  it("prefers the persisted task objective over the first chat turn", async () => {
    const { ws } = await testWorkspace();
    const note = buildSessionSummaryNote(ws, envelopeFor({
      chatTurns: [{ role: "user", text: "第一条消息" }],
      task: {
        objective: "重写第三章",
        status: "completed",
        sourcePaths: [],
        sourceRefs: [],
        proposalCount: 0,
        inspectedDocument: false,
        consistencyChecked: false,
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    }));
    expect(note).toContain("主题「重写第三章」");
    expect(note).not.toContain("第一条消息");
  });

  it("bounds the topic to 200 chars", async () => {
    const { ws } = await testWorkspace();
    const objective = "题".repeat(300);
    const note = buildSessionSummaryNote(ws, envelopeFor({
      chatTurns: [{ role: "user", text: objective }],
    }));
    expect(note).toContain(`主题「${"题".repeat(200)}」`);
    expect(note).not.toContain("题".repeat(201));
  });

  it("returns undefined when the archived session has no usable record", async () => {
    const { ws } = await testWorkspace();
    expect(buildSessionSummaryNote(ws, envelopeFor())).toBeUndefined();
  });

  it("injects proposal stats even without a topic", async () => {
    const { ws, document, blocks } = await testWorkspace();
    saveProposal(ws, proposalFor(document, blocks[0]!));
    const note = buildSessionSummaryNote(ws, envelopeFor({ documentId: document.id }));
    expect(note).toBeDefined();
    expect(note).not.toContain("主题「");
    expect(note).toContain("待裁决提案 1 条");
  });

  it("exposes the latest stored decision per proposal", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const proposal = proposalFor(document, blocks[0]!);
    saveProposal(ws, proposal);
    saveDecision(ws, proposal.id, "Y");
    expect(getLatestDecision(ws, proposal.id)?.kind).toBe("Y");
  });
});

describe("buildDomainSnapshot", () => {
  it("returns empty when the document has no proposals", async () => {
    const { ws, document } = await testWorkspace();
    expect(buildDomainSnapshot(ws, document.id)).toBe("");
  });

  it("lists decided proposals with ids, verdicts and edited text plus pending ids", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const accepted = proposalFor(document, blocks[0]!, { before: "accepted target" });
    const rejected = proposalFor(document, blocks[1]!, { before: "rejected target" });
    const edited = proposalFor(document, blocks[0]!, { before: "edited target" });
    const pending = proposalFor(document, blocks[1]!, { before: "pending target" });
    saveProposal(ws, accepted);
    saveProposal(ws, rejected);
    saveProposal(ws, edited);
    saveProposal(ws, pending);
    saveDecision(ws, accepted.id, "Y");
    saveDecision(ws, rejected.id, "N", undefined, "太生硬");
    saveDecision(ws, edited.id, "E", "编辑后的定稿文本");

    const snapshot = buildDomainSnapshot(ws, document.id);

    expect(snapshot).toContain("[Margin 裁决状态快照]");
    expect(snapshot).toContain(`${accepted.id}：「accepted target」= 接受`);
    expect(snapshot).toContain(`${rejected.id}：「rejected target」= 拒绝`);
    expect(snapshot).toContain("理由：太生硬");
    expect(snapshot).toContain(`${edited.id}：「edited target」= 编辑后接受`);
    expect(snapshot).toContain('编辑后文本："编辑后的定稿文本"');
    expect(snapshot).toContain("待裁决提案 1 条");
    expect(snapshot).toContain(`${pending.id}：「pending target」`);
  });

  it("bounds the E edited text to 200 chars", async () => {
    const { ws, document, blocks } = await testWorkspace();
    const edited = proposalFor(document, blocks[0]!);
    saveProposal(ws, edited);
    saveDecision(ws, edited.id, "E", "文".repeat(400));

    const snapshot = buildDomainSnapshot(ws, document.id);

    expect(snapshot).toContain("文".repeat(200));
    expect(snapshot).not.toContain("文".repeat(201));
  });
});
