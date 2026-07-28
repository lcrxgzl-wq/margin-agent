import { useEffect, useMemo, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import {
  importSkill,
  listSkills,
  removeSkill,
  setSkillMode,
  type SkillSummary,
} from "../../api";
import {
  findWorkspaceSkillOverwrite,
  groupSkills,
  skillStateLabel,
  skillToggleTarget,
} from "../../extensionsModel";

type Props = {
  open: boolean;
  onCloseLocked?: (locked: boolean) => void;
};

/** 方法（Skills）检视与启停。工作区覆盖内置 Skill 需确认，可移除以还原。 */
export function MethodsTab({ open, onCloseLocked }: Props) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const skillGroups = useMemo(() => groupSkills(skills), [skills]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    setNotice(null);
    void listSkills()
      .then((result) => {
        if (active) setSkills(result.skills);
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
    onCloseLocked?.(busy);
  }, [busy, onCloseLocked]);

  if (!open) return null;

  const install = async () => {
    if (!content.trim()) return;
    const overwrite = findWorkspaceSkillOverwrite(skills, content);
    if (overwrite && !window.confirm(`工作区 Skill“${overwrite.name}”已存在。用当前内容覆盖？`)) {
      return;
    }
    setBusy(true);
    setBusyLabel("正在导入 Skill…");
    setError(null);
    setNotice(null);
    try {
      const result = await importSkill(content);
      setContent("");
      const refreshed = await listSkills();
      setSkills(refreshed.skills);
      setNotice(`已导入 ${result.skill.name}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  };

  const uninstallSkill = async (skill: SkillSummary) => {
    if (skill.source !== "workspace") return;
    if (!window.confirm(`移除工作区 Skill“${skill.name}”？`)) return;
    setBusy(true);
    setBusyLabel("正在移除 Skill…");
    setError(null);
    setNotice(null);
    try {
      await removeSkill(skill.name);
      setSkills((current) => current.filter(
        (candidate) => candidate.source !== "workspace" || candidate.name !== skill.name,
      ));
      setNotice(`已移除 ${skill.name}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  };

  const toggleSkill = async (skill: SkillSummary) => {
    if (skill.state === "blocked_by_profile") return;
    const mode = skillToggleTarget(skill.preference);
    setBusy(true);
    setBusyLabel(mode === "off" ? "正在关闭 Skill…" : "正在启用 Skill…");
    setError(null);
    setNotice(null);
    try {
      const result = await setSkillMode(skill.name, mode);
      setSkills((current) => current.map((candidate) =>
        candidate.source === skill.source && candidate.name === skill.name
          ? { ...candidate, preference: result.skill.preference, state: result.skill.state }
          : candidate,
      ));
      setNotice(mode === "off" ? `已关闭 ${skill.name}。` : `已启用 ${skill.name}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  };

  return (
    <div className="settings-tab-body" aria-busy={busy || loading}>
      {loading ? <p className="settings-msg" role="status">正在读取 Skills…</p> : null}

      <section className="extensions-section">
        <div className="settings-field-head">
          <span>内置</span>
          <small>{skillGroups.bundled.length}</small>
        </div>
        <SkillList skills={skillGroups.bundled} busy={busy} onToggle={toggleSkill} />
      </section>

      <section className="extensions-section">
        <div className="settings-field-head">
          <span>工作区</span>
          <small>{skillGroups.workspace.length}</small>
        </div>
        <SkillList skills={skillGroups.workspace} busy={busy} onRemove={uninstallSkill} onToggle={toggleSkill} />
      </section>

      <section className="extensions-section extensions-import">
        <div className="settings-field-head"><span>导入 SKILL.md</span></div>
        <input
          className="extensions-file"
          type="file"
          accept=".md,text/markdown,text/plain"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 128 * 1024) {
              setError("SKILL.md 超过 128 KiB");
              return;
            }
            void file.text().then(setContent).catch((reason) => {
              setError(reason instanceof Error ? reason.message : String(reason));
            });
          }}
        />
        <textarea
          value={content}
          disabled={busy}
          onChange={(event) => setContent(event.target.value)}
          placeholder={'---\nname: my-skill\ndescription: …\n---\n\n方法正文'}
          spellCheck={false}
          aria-label="Skill 内容"
        />
        <div className="settings-actions">
          <button type="button" className="btn" disabled={busy || !content.trim()} onClick={() => void install()}>
            <Upload />{busyLabel === "正在导入 Skill…" ? "导入中…" : "导入 Skill"}
          </button>
        </div>
      </section>

      {busyLabel ? <p className="settings-msg" role="status">{busyLabel}</p> : null}
      {notice ? <p className="settings-msg ok" role="status">{notice}</p> : null}
      {error ? <p className="settings-msg err" role="alert">{error}</p> : null}
    </div>
  );
}

function SkillList({
  skills,
  busy,
  onRemove,
  onToggle,
}: {
  skills: SkillSummary[];
  busy: boolean;
  onRemove?: (skill: SkillSummary) => void;
  onToggle?: (skill: SkillSummary) => void;
}) {
  if (!skills.length) return <p className="extensions-empty">暂无。</p>;
  return (
    <ul className="extensions-list">
      {skills.map((skill) => (
        <li key={`${skill.source}:${skill.name}`}>
          <div className="extensions-row-head">
            <strong>{skill.name}</strong>
            <div className="extensions-row-actions">
              <span
                className={`skill-state ${skill.state}`}
                title={skill.state === "blocked_by_profile" ? "当前 Agent 模式不包含此 Skill" : undefined}
              >{skillStateLabel(skill.state)}</span>
              {onToggle && skill.state !== "blocked_by_profile" ? (
                <button
                  type="button"
                  className="linkish"
                  disabled={busy}
                  aria-label={`${skill.preference === "off" ? "启用" : "关闭"} ${skill.name}`}
                  onClick={() => void onToggle(skill)}
                >{skill.preference === "off" ? "启用" : "关闭"}</button>
              ) : null}
            </div>
            {onRemove ? (
              <button type="button" className="icon-button danger" disabled={busy} onClick={() => onRemove(skill)} aria-label={`移除 ${skill.name}`} title="移除">
                <Trash2 />
              </button>
            ) : null}
          </div>
          <p>{skill.description}</p>
        </li>
      ))}
    </ul>
  );
}
