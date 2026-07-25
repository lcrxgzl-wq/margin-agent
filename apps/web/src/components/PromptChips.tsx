type Chip = { label: string; send: string };

const CHIPS: Chip[] = [
  { label: "打开样章", send: "打开样章" },
  { label: "先聊问题意识", send: "先别改文，用苏格拉底方式帮我澄清问题意识" },
];

type Props = {
  busy: boolean;
  visible: boolean;
  onSend: (text: string) => void;
};

export function PromptChips({ busy, visible, onSend }: Props) {
  if (!visible) return null;
  return (
    <div className="prompt-chips" aria-label="快捷开始">
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
