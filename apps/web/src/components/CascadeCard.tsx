import { useMemo, useState } from "react";
import type { CascadeCandidate } from "../store";

type Props = {
  candidates: CascadeCandidate[];
  busy: boolean;
  onLocalOnly: () => void;
  onConfirm: (blockIds: string[]) => void;
};

export function CascadeCard({ candidates, busy, onLocalOnly, onConfirm }: Props) {
  const allIds = useMemo(() => candidates.map((c) => c.blockId), [candidates]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allIds));

  if (!candidates.length) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="cascade-card" role="region" aria-label="全文联动确认">
      <p className="cascade-title">可能需要一并修订的相关段</p>
      <ul className="cascade-list">
        {candidates.map((c) => (
          <li key={c.blockId}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(c.blockId)}
                disabled={busy}
                onChange={() => toggle(c.blockId)}
              />
              <span className="cascade-reason">{c.reason}</span>
              <span className="cascade-id">{c.blockId.slice(0, 8)}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="cascade-actions">
        <button type="button" className="btn ghost" disabled={busy} onClick={onLocalOnly}>
          仅本地
        </button>
        <button
          type="button"
          className="btn send"
          disabled={busy || selected.size === 0}
          onClick={() => onConfirm([...selected])}
        >
          改所选（{selected.size}）
        </button>
      </div>
    </div>
  );
}
