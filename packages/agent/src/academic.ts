import { randomUUID } from "node:crypto";
import {
  ReviewChecklistRunDraftSchema,
  type BlockSnapshot,
  type ReviewChecklistChecker,
  type ReviewChecklistRunDraft,
} from "@margin/domain";

export const CITE_CHECK_DISCLAIMER =
  "形态学通过 ≠ 文献真实存在。此检查不验证文献真实性、存在性，也不验证引文是否支持正文主张。";
export const STYLE_LINT_DISCLAIMER = "词表启发，不是全面语体审校。";

export type CiteFinding = {
  blockId: string;
  kind:
    | "author_year"
    | "bracket_num"
    | "doi_like"
    | "quoted_speech"
    | "insert_placeholder";
  excerpt: string;
  /** Machine-readable: never claims bibliographic truth. */
  heuristic_only: true;
  verification: "not_verified";
  note: string;
};

const AUTHOR_YEAR =
  /[（(]\s*[\u4e00-\u9fffA-Za-z·\s]{1,40}[,，]\s*(?:19|20)\d{2}[a-z]?\s*[）)]/g;
const BRACKET_NUM = /\[\d{1,3}\]/g;
const DOI_LIKE = /\b10\.\d{4,9}\/[^\s]+/gi;
const QUOTED = /[「『“"]([^」』”"]{8,})[」』”"]/g;
const PLACEHOLDER = /\[需插入引文[^\]]*\]/g;

/**
 * Morphological citation heuristics only.
 * Does NOT verify existence, authenticity, or support relation of sources.
 */
export function citeCheck(blocks: BlockSnapshot[]): {
  disclaimer: string;
  findings: CiteFinding[];
} {
  const disclaimer = CITE_CHECK_DISCLAIMER;
  const findings: CiteFinding[] = [];

  const push = (
    blockId: string,
    kind: CiteFinding["kind"],
    excerpt: string,
    note: string,
  ) => {
    findings.push({
      blockId,
      kind,
      excerpt: excerpt.slice(0, 120),
      heuristic_only: true,
      verification: "not_verified",
      note,
    });
  };

  for (const b of blocks) {
    for (const m of b.text.matchAll(AUTHOR_YEAR)) {
      push(b.id, "author_year", m[0], "疑似作者—年份引用形态");
    }
    for (const m of b.text.matchAll(BRACKET_NUM)) {
      push(b.id, "bracket_num", m[0], "疑似编号引用形态");
    }
    for (const m of b.text.matchAll(DOI_LIKE)) {
      push(b.id, "doi_like", m[0], "疑似 DOI 形态（未解析校验）");
    }
    for (const m of b.text.matchAll(QUOTED)) {
      push(b.id, "quoted_speech", m[0], "较长引语：勿编造访谈原话");
    }
    for (const m of b.text.matchAll(PLACEHOLDER)) {
      push(b.id, "insert_placeholder", m[0], "已有引文占位");
    }
  }

  return { disclaimer, findings };
}

const STYLE_PATTERNS: Array<{
  re: RegExp;
  kind: "cliche" | "empty_evaluation" | "template_closure";
  label: string;
}> = [
  { re: /赋能/g, kind: "cliche", label: "套话：赋能" },
  { re: /困境与路径/g, kind: "cliche", label: "套话：困境与路径" },
  { re: /深度融合/g, kind: "cliche", label: "套话：深度融合" },
  { re: /新时代背景下/g, kind: "cliche", label: "套话：新时代背景下" },
  { re: /行之有效的/g, kind: "empty_evaluation", label: "空泛评价：行之有效的" },
  { re: /具有重要的(?:现实|理论)意义/g, kind: "empty_evaluation", label: "空泛意义句" },
  { re: /综上所述[，,]\s*本文认为/g, kind: "template_closure", label: "模板收束句" },
];

export type StyleFinding = {
  blockId: string;
  kind: "cliche" | "empty_evaluation" | "template_closure";
  label: string;
  excerpt: string;
  risk: "language";
};

export function styleLint(blocks: BlockSnapshot[]): {
  disclaimer: string;
  findings: StyleFinding[];
} {
  const findings: StyleFinding[] = [];
  for (const b of blocks) {
    for (const { re, kind, label } of STYLE_PATTERNS) {
      re.lastIndex = 0;
      for (const m of b.text.matchAll(re)) {
        findings.push({
          blockId: b.id,
          kind,
          label,
          excerpt: m[0],
          risk: "language",
        });
      }
    }
  }
  return {
    disclaimer: STYLE_LINT_DISCLAIMER,
    findings,
  };
}

const CITE_LABELS: Record<CiteFinding["kind"], string> = {
  author_year: "作者—年份引用",
  bracket_num: "编号引用",
  doi_like: "DOI 形态",
  quoted_speech: "较长引语",
  insert_placeholder: "引文占位",
};

const STYLE_LABELS: Record<StyleFinding["kind"], string> = {
  cliche: "套话",
  empty_evaluation: "空泛评价",
  template_closure: "模板收束",
};

export function createReviewChecklistRun(
  checker: ReviewChecklistChecker,
  documentId: string,
  blocks: BlockSnapshot[],
): ReviewChecklistRunDraft {
  if (!documentId) throw new Error("document id is required for a review checklist");
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const draft: ReviewChecklistRunDraft = checker === "cite_check"
    ? (() => {
        const result = citeCheck(blocks);
        return {
          run: {
            schemaVersion: 1,
            id: runId,
            documentId,
            checker,
            disclaimer: result.disclaimer,
            status: "active",
            createdAt,
          },
          items: result.findings.map((finding) => ({
            schemaVersion: 1 as const,
            id: randomUUID(),
            runId,
            documentId,
            blockId: finding.blockId,
            issueType: `citation.${finding.kind}`,
            label: CITE_LABELS[finding.kind],
            excerpt: finding.excerpt,
            detail: finding.note,
            severity: finding.kind === "quoted_speech" || finding.kind === "insert_placeholder"
              ? "warn" as const
              : "info" as const,
            status: "open" as const,
            heuristicOnly: true,
            verification: "not_verified" as const,
            createdAt,
          })),
        };
      })()
    : (() => {
        const result = styleLint(blocks);
        return {
          run: {
            schemaVersion: 1,
            id: runId,
            documentId,
            checker,
            disclaimer: result.disclaimer,
            status: "active",
            createdAt,
          },
          items: result.findings.map((finding) => ({
            schemaVersion: 1 as const,
            id: randomUUID(),
            runId,
            documentId,
            blockId: finding.blockId,
            issueType: `style.${finding.kind}`,
            label: STYLE_LABELS[finding.kind],
            excerpt: finding.excerpt,
            detail: finding.label,
            severity: "warn" as const,
            status: "open" as const,
            heuristicOnly: true,
            createdAt,
          })),
        };
      })();
  return ReviewChecklistRunDraftSchema.parse(draft);
}

export function createReviewChecklistRuns(
  documentId: string,
  blocks: BlockSnapshot[],
): ReviewChecklistRunDraft[] {
  return [
    createReviewChecklistRun("cite_check", documentId, blocks),
    createReviewChecklistRun("style_lint", documentId, blocks),
  ];
}

/** Build legacy session comments from cite/style heuristics. */
export function heuristicComments(
  blocks: BlockSnapshot[],
  opts?: { max?: number },
): Array<{
  id: string;
  blockId: string;
  text: string;
  severity: "info" | "warn";
  source: "heuristic";
  origin: "cite_check" | "style_lint";
  ephemeral: true;
}> {
  const max = opts?.max ?? 12;
  const out: Array<{
    id: string;
    blockId: string;
    text: string;
    severity: "info" | "warn";
    source: "heuristic";
    origin: "cite_check" | "style_lint";
    ephemeral: true;
  }> = [];
  const cite = citeCheck(blocks);
  for (const f of cite.findings) {
    if (out.length >= max) break;
    out.push({
      id: randomUUID(),
      blockId: f.blockId,
      text: `[cite_check·未验证真伪] ${f.note}: ${f.excerpt}`,
      severity: f.kind === "quoted_speech" ? "warn" : "info",
      source: "heuristic",
      origin: "cite_check",
      ephemeral: true,
    });
  }
  const style = styleLint(blocks);
  for (const f of style.findings) {
    if (out.length >= max) break;
    out.push({
      id: randomUUID(),
      blockId: f.blockId,
      text: `[style_lint] ${f.label}: ${f.excerpt}`,
      severity: "warn",
      source: "heuristic",
      origin: "style_lint",
      ephemeral: true,
    });
  }
  return out;
}
