/** Build a human-readable AI disclosure draft from a revision packet. */
export function buildDisclosureText(packet: unknown): string {
  const data = packet as {
    document?: { relativePath?: string };
    proposals?: Array<{
      id?: string;
      status?: string;
      risk?: string;
      rationale?: string;
      blockId?: string;
      decision?: { kind?: string };
    }>;
    decisions?: Array<{ kind?: string; proposalId?: string }>;
  };
  const proposals = data.proposals ?? [];
  const decisionsByProposal = new Map(
    (data.decisions ?? [])
      .filter((decision) => decision.proposalId && decision.kind)
      .map((decision) => [decision.proposalId!, decision]),
  );
  const decided = proposals
    .map((proposal) => ({
      proposal,
      decision:
        proposal.decision?.kind
          ? proposal.decision
          : proposal.id
            ? decisionsByProposal.get(proposal.id)
            : undefined,
    }))
    .filter((item) => item.decision?.kind);
  const accepted = decided.filter(
    (item) => item.decision?.kind === "Y" || item.decision?.kind === "E",
  );
  const rejected = decided.filter((item) => item.decision?.kind === "N");
  const path = data.document?.relativePath?.replace(/^.*[\\/]/, "") || "本文";
  const lines = [
    `【AI 使用披露草稿】`,
    ``,
    `文稿《${path}》在修订过程中使用了本地 AI 辅助工具（Margin）。`,
    `AI 仅提出修改建议；是否接受由作者本人逐条审阅决定，AI 无权直接定稿。`,
    ``,
    `统计：提案 ${proposals.length} 处；接受/编辑后接受 ${accepted.length} 处；拒绝 ${rejected.length} 处；其余待决或未记录。`,
    ``,
  ];
  if (accepted.length) {
    lines.push(`已接受或编辑后接受的条目：`);
    accepted.slice(0, 40).forEach(({ proposal, decision }, i) => {
      lines.push(
        `${i + 1}. [${proposal.risk || "language"}] ${proposal.rationale || "（无理由）"}${
          decision?.kind === "E" ? "（作者编辑后接受）" : ""
        }`,
      );
    });
    lines.push("");
  }
  lines.push(
    `声明：引用形态检查（如有）仅为启发式核对，未验证文献真实性；文责由作者承担。`,
  );
  return lines.join("\n");
}

export function summarizeRisks(
  proposals: Array<{ risk?: string }>,
): string {
  if (!proposals.length) return "";
  const counts = new Map<string, number>();
  for (const p of proposals) {
    const key = p.risk || "language";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([k, n]) => `${k}:${n}`)
    .join(" ");
}
