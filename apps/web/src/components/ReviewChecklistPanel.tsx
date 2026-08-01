import { CheckCircle2, EyeOff, LocateFixed } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReviewChecklistItem, ReviewChecklistRun } from "@margin/domain";
import type { ReviewChecklistBundle } from "../api";
import {
  fixedChecklistDisclosure,
  groupChecklistItems,
} from "../reviewChecklists";

type Props = {
  runs: ReviewChecklistBundle[];
  onDecision: (
    runId: string,
    itemIds: string[],
    kind: "resolve" | "dismiss",
  ) => Promise<void>;
  onLocate: (item: ReviewChecklistItem) => void;
};

const checkerMeta: Record<ReviewChecklistRun["checker"], { title: string; empty: string }> = {
  cite_check: { title: "引用形态", empty: "未发现引用形态项。" },
  style_lint: { title: "语体词表", empty: "未发现词表启发项。" },
};

function statusText(status: ReviewChecklistItem["status"]): string {
  if (status === "resolved") return "已处理";
  if (status === "dismissed") return "已忽略";
  return "待处理";
}

function ChecklistRunSection({
  checker,
  bundle,
  onDecision,
  onLocate,
}: {
  checker: ReviewChecklistRun["checker"];
  bundle?: ReviewChecklistBundle;
  onDecision: Props["onDecision"];
  onLocate: Props["onLocate"];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = bundle?.items;
  const groups = useMemo(() => groupChecklistItems(items ?? []), [items]);
  const openIds = useMemo(
    () => new Set((items ?? []).filter((item) => item.status === "open").map((item) => item.id)),
    [items],
  );

  useEffect(() => {
    setSelected((current) => new Set([...current].filter((id) => openIds.has(id))));
  }, [bundle?.run.id, openIds]);

  const toggleItems = (ids: string[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) checked ? next.add(id) : next.delete(id);
      return next;
    });
  };

  const decide = async (kind: "resolve" | "dismiss") => {
    if (!bundle || !selected.size || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onDecision(bundle.run.id, [...selected], kind);
      setSelected(new Set());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="checklist-run" aria-label={checkerMeta[checker].title}>
      <header className="checklist-run-heading">
        <div>
          <strong>{checkerMeta[checker].title}</strong>
          <span>{openIds.size} 条待处理</span>
        </div>
        {bundle ? <time>{new Date(bundle.run.createdAt).toLocaleString()}</time> : null}
      </header>
      <p className={`checklist-disclosure ${checker === "cite_check" ? "citation" : "style"}`}>
        {fixedChecklistDisclosure(checker)}
      </p>
      {!bundle ? <p className="checklist-empty">尚未运行此项检查。</p> : (
        <>
          <div className="checklist-batch" aria-label="批量处理检查项">
            <span>{selected.size ? `已选 ${selected.size} 条` : "选择检查项后批量处理"}</span>
            <div>
              <button
                type="button"
                disabled={!selected.size || submitting}
                onClick={() => void decide("resolve")}
              ><CheckCircle2 />标为已处理</button>
              <button
                type="button"
                disabled={!selected.size || submitting}
                onClick={() => void decide("dismiss")}
              ><EyeOff />忽略</button>
            </div>
          </div>
          {error ? <p className="review-error" role="alert">{error}</p> : null}
          {!items?.length ? <p className="checklist-empty">{checkerMeta[checker].empty}</p> : null}
          {groups.map((group) => {
            const groupOpenIds = group.blocks
              .flatMap((block) => block.items)
              .filter((item) => item.status === "open")
              .map((item) => item.id);
            const groupSelected = groupOpenIds.filter((id) => selected.has(id)).length;
            return (
              <section className="checklist-group" key={group.issueType}>
                <header>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!groupOpenIds.length || submitting}
                      checked={groupOpenIds.length > 0 && groupSelected === groupOpenIds.length}
                      onChange={(event) => toggleItems(groupOpenIds, event.target.checked)}
                    />
                    <strong>{group.label}</strong>
                  </label>
                  <span>{groupOpenIds.length} 条待处理</span>
                </header>
                {group.blocks.map((block) => (
                  <div className="checklist-block" key={`${group.issueType}:${block.blockId}`}>
                    <div className="checklist-block-heading">
                      <span>段落 {block.blockId}</span>
                      <button
                        type="button"
                        aria-label={`定位段落 ${block.blockId}`}
                        title="定位段落"
                        onClick={() => onLocate(block.items[0]!)}
                      ><LocateFixed /></button>
                    </div>
                    {block.items.map((item) => (
                      <label className={`checklist-item status-${item.status}`} key={item.id}>
                        <input
                          type="checkbox"
                          disabled={item.status !== "open" || submitting}
                          checked={selected.has(item.id)}
                          onChange={(event) => toggleItems([item.id], event.target.checked)}
                        />
                        <span>
                          <strong>{item.excerpt || item.label}</strong>
                          <small>{item.detail}</small>
                        </span>
                        <i>{statusText(item.status)}</i>
                      </label>
                    ))}
                  </div>
                ))}
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}

export function ReviewChecklistPanel({ runs, onDecision, onLocate }: Props) {
  return (
    <div className="review-checklists">
      {(["cite_check", "style_lint"] as const).map((checker) => (
        <ChecklistRunSection
          key={checker}
          checker={checker}
          bundle={runs.find((entry) => entry.run.checker === checker)}
          onDecision={onDecision}
          onLocate={onLocate}
        />
      ))}
    </div>
  );
}
