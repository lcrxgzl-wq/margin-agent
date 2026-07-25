import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Network,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  discoverMcp,
  importSkill,
  listMcpServers,
  listSkills,
  removeMcpServer,
  removeSkill,
  saveMcpServer,
  type McpServerSummary,
  type SkillSummary,
} from "../api";
import {
  applyMcpDiscovery,
  changeMcpUrl,
  editMcpServer,
  emptyMcpDraft,
  findWorkspaceSkillOverwrite,
  groupSkills,
  mcpDiscoverPayload,
} from "../extensionsModel";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function Extensions({ open, onClose }: Props) {
  const [tab, setTab] = useState<"skills" | "mcp">("skills");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [content, setContent] = useState("");
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [mcpDraft, setMcpDraft] = useState(emptyMcpDraft);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const skillGroups = useMemo(() => groupSkills(skills), [skills]);
  const selectedToolNames = useMemo(
    () => new Set(mcpDraft.selectedTools),
    [mcpDraft.selectedTools],
  );

  useEffect(() => {
    if (!open) return;
    let active = true;
    setError(null);
    setNotice(null);
    void Promise.all([listSkills(), listMcpServers()])
      .then(([skillResult, mcpResult]) => {
        if (!active) return;
        setSkills(skillResult.skills);
        setServers(mcpResult.servers);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose, open]);

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

  const discover = async () => {
    const input = mcpDiscoverPayload(mcpDraft);
    if (!input.url) return;
    setBusy(true);
    setBusyLabel("正在读取 MCP 工具…");
    setError(null);
    setNotice(null);
    try {
      const result = await discoverMcp(input.url, input.token, input.serverId);
      setMcpDraft((current) => applyMcpDiscovery(current, result));
      setNotice(`已读取 ${result.tools.length} 个工具。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  };

  const saveMcp = async () => {
    if (!mcpDraft.url.trim() || !mcpDraft.selectedTools.length) return;
    setBusy(true);
    setBusyLabel("正在保存 MCP…");
    setError(null);
    setNotice(null);
    try {
      const result = await saveMcpServer({
        name: mcpDraft.name.trim() || undefined,
        url: mcpDraft.url.trim(),
        token: mcpDraft.token.trim() || undefined,
        clearToken: mcpDraft.clearToken,
        enabledTools: mcpDraft.selectedTools,
      });
      setMcpDraft(emptyMcpDraft());
      const refreshed = await listMcpServers();
      setServers(refreshed.servers);
      setNotice(`已保存 ${result.server.name}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  };

  const uninstallMcp = async (server: McpServerSummary) => {
    if (!window.confirm(`移除 MCP“${server.name}”？`)) return;
    setBusy(true);
    setBusyLabel("正在移除 MCP…");
    setError(null);
    setNotice(null);
    try {
      await removeMcpServer(server.id);
      setServers((current) => current.filter((candidate) => candidate.id !== server.id));
      if (mcpDraft.editingServerId === server.id) setMcpDraft(emptyMcpDraft());
      setNotice(`已移除 ${server.name}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  };

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="扩展模块">
      <div className="settings-panel extensions-panel" aria-busy={busy}>
        <header className="settings-head">
          <h2>扩展模块</h2>
          <button type="button" className="settings-close" disabled={busy} onClick={onClose} aria-label="关闭扩展" title="关闭">
            <X />
          </button>
        </header>

        <nav className="extensions-tabs" role="tablist" aria-label="扩展类型">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "skills"}
            aria-controls="extensions-skills"
            className={tab === "skills" ? "active" : ""}
            onClick={() => setTab("skills")}
          ><BookOpen />Skills</button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "mcp"}
            aria-controls="extensions-mcp"
            className={tab === "mcp" ? "active" : ""}
            onClick={() => setTab("mcp")}
          ><Network />MCP</button>
        </nav>

        <div className="extensions-body">
          <div id="extensions-skills" role="tabpanel" hidden={tab !== "skills"}>
            <section className="extensions-section">
              <div className="settings-field-head">
                <span>内置</span>
                <small>{skillGroups.bundled.length}</small>
              </div>
              <SkillList skills={skillGroups.bundled} busy={busy} />
            </section>

            <section className="extensions-section">
              <div className="settings-field-head">
                <span>工作区</span>
                <small>{skillGroups.workspace.length}</small>
              </div>
              <SkillList skills={skillGroups.workspace} busy={busy} onRemove={uninstallSkill} />
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
            </section>
          </div>

          <div id="extensions-mcp" role="tabpanel" hidden={tab !== "mcp"}>
            <section className="extensions-section">
              <div className="settings-field-head">
                <span>已配置</span>
                <small>{servers.length}</small>
              </div>
              {servers.length ? (
                <ul className="extensions-list mcp-server-list">
                  {servers.map((server) => (
                    <li key={server.id}>
                      <div className="extensions-row-head">
                        <div><strong>{server.name}</strong><span>{server.enabledTools.length} 个工具</span></div>
                        <div className="extensions-row-actions">
                          <button
                            type="button"
                            className="icon-button"
                            disabled={busy}
                            aria-label={`编辑 ${server.name}`}
                            title="编辑并重新读取"
                            onClick={() => {
                              setMcpDraft(editMcpServer(server));
                              setError(null);
                              setNotice(null);
                            }}
                          ><Pencil /></button>
                          <button
                            type="button"
                            className="icon-button danger"
                            disabled={busy}
                            aria-label={`移除 ${server.name}`}
                            title="移除"
                            onClick={() => void uninstallMcp(server)}
                          ><Trash2 /></button>
                        </div>
                      </div>
                      <p>{server.url}</p>
                    </li>
                  ))}
                </ul>
              ) : <p className="extensions-empty">尚未配置 MCP。</p>}
            </section>

            <section className="extensions-section mcp-section">
              <div className="settings-field-head">
                <span>{mcpDraft.editingServerId ? "编辑 MCP" : "添加 MCP"}</span>
                {(mcpDraft.name || mcpDraft.url) ? (
                  <button type="button" className="icon-button" disabled={busy} onClick={() => setMcpDraft(emptyMcpDraft())} aria-label="清空 MCP 表单" title="清空">
                    <X />
                  </button>
                ) : null}
              </div>
              <div className="mcp-fields">
                <label><span>名称</span><input value={mcpDraft.name} disabled={busy} onChange={(event) => setMcpDraft((current) => ({ ...current, name: event.target.value }))} placeholder="资料库" /></label>
                <label><span>URL</span><input value={mcpDraft.url} disabled={busy} onChange={(event) => { setMcpDraft((current) => changeMcpUrl(current, event.target.value)); setNotice(null); }} placeholder="https://…/mcp" spellCheck={false} /></label>
                <label>
                  <span className="settings-field-head">
                    <span>Token</span>
                    {mcpDraft.editingServerId && mcpDraft.storedTokenAvailable && !mcpDraft.token.trim() ? (
                      <button
                        type="button"
                        className="linkish"
                        disabled={busy}
                        onClick={() => setMcpDraft((current) => ({ ...current, clearToken: !current.clearToken }))}
                      >{mcpDraft.clearToken ? "撤销移除" : "保存时移除"}</button>
                    ) : null}
                  </span>
                  <input
                    type="password"
                    value={mcpDraft.token}
                    disabled={busy}
                    onChange={(event) => setMcpDraft((current) => ({ ...current, token: event.target.value, clearToken: false }))}
                    placeholder={mcpDraft.clearToken ? "保存后不再使用 Token" : mcpDraft.editingServerId && mcpDraft.storedTokenAvailable ? "留空沿用已存 Token" : "Bearer Token（可选）"}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <div className="settings-discover-row">
                <button type="button" className="btn ghost" disabled={busy || !mcpDraft.url.trim()} onClick={() => void discover()}>
                  <RefreshCw />{mcpDraft.editingServerId ? "重新读取" : "读取工具"}
                </button>
                {mcpDraft.latencyMs != null ? <span>{mcpDraft.latencyMs} ms</span> : null}
              </div>
              {mcpDraft.tools.length ? (
                <ul className="mcp-tool-list">
                  {mcpDraft.tools.map((tool) => (
                    <li key={tool.name}>
                      <label title={tool.description}>
                        <input
                          type="checkbox"
                          disabled={busy || !tool.readOnly}
                          checked={selectedToolNames.has(tool.name)}
                          onChange={() => setMcpDraft((current) => ({
                            ...current,
                            selectedTools: current.selectedTools.includes(tool.name)
                              ? current.selectedTools.filter((name) => name !== tool.name)
                              : [...current.selectedTools, tool.name],
                          }))}
                        />
                        <span>{tool.name}</span>
                      </label>
                      <small>{tool.readOnly ? tool.description : "服务器未声明只读，已禁用"}</small>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </div>
        </div>

        {busyLabel ? <p className="settings-msg" role="status">{busyLabel}</p> : null}
        {notice ? <p className="settings-msg ok" role="status">{notice}</p> : null}
        {error ? <p className="settings-msg err" role="alert">{error}</p> : null}
        <footer className="settings-actions extensions-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>关闭</button>
          {tab === "skills" ? (
            <button type="button" className="btn" disabled={busy || !content.trim()} onClick={() => void install()}>
              <Upload />{busyLabel === "正在导入 Skill…" ? "导入中…" : "导入 Skill"}
            </button>
          ) : mcpDraft.tools.length ? (
            <button type="button" className="btn" disabled={busy || !mcpDraft.selectedTools.length} onClick={() => void saveMcp()}>
              {mcpDraft.editingServerId ? "更新 MCP" : "保存 MCP"}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

function SkillList({
  skills,
  busy,
  onRemove,
}: {
  skills: SkillSummary[];
  busy: boolean;
  onRemove?: (skill: SkillSummary) => void;
}) {
  if (!skills.length) return <p className="extensions-empty">暂无。</p>;
  return (
    <ul className="extensions-list">
      {skills.map((skill) => (
        <li key={`${skill.source}:${skill.name}`}>
          <div className="extensions-row-head">
            <strong>{skill.name}</strong>
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
