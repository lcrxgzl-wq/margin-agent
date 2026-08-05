type Chip = { label: string; send: string };

const CHIPS: Chip[] = [
  { label: "打开样章", send: "打开样章" },
  { label: "介绍一下你自己", send: "介绍一下你自己" },
];

type Props = {
  busy: boolean;
  visible: boolean;
  onSend: (text: string) => void;
  /** Direct .docx picker (no model involved); rendered as the first chip. */
  onOpenDocx?: () => void;
};

export function PromptChips({ busy, visible, onSend, onOpenDocx }: Props) {
  if (!visible) return null;
  return (
    <div className="prompt-chips" aria-label="快捷开始">
      {onOpenDocx ? (
        <button
          type="button"
          className="chip"
          disabled={busy}
          onClick={onOpenDocx}
        >
          打开 DOCX
        </button>
      ) : null}
      {CHIPS.map((c) => (
        <button
          key={c.label}
          type="button"
          className="chip"
          disabled={busy}
          onClick={() => onSend(c.send)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
