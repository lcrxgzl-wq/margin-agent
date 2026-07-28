import { useEffect, useMemo, useState } from "react";
import { Pencil, RefreshCw, Trash2, X } from "lucide-react";
import {
  discoverMcp,
  listMcpServers,
  removeMcpServer,
  saveMcpServer,
  type McpServerSummary,
} from "../../api";
import {
  applyMcpDiscovery,
  changeMcpUrl,
  editMcpServer,
  emptyMcpDraft,
  mcpDiscoverPayload,
} from "../../extensionsModel";

type Props = {
  open: boolean;
  onCloseLocked?: (locked: boolean) => void;
};

/** 外部工具（远程 HTTP MCP）配置。每次调用仍需逐次批准。 */
export function ToolsTab({ open, onCloseLocked }: Props) {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [mcpDraft, setMcpDraft] = useState(emptyMcpDraft);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedToolNames = useMemo(
    () => new Set(mcpDraft.selectedTools),
    [mcpDraft.selectedTools],
  );

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    setNotice(null);
    void listMcpServers()
      .then((result) => {
        if (active) setServers(result.servers);
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
    <div className="settings-tab-body" aria-busy={busy || loading}>
      {loading ? <p className="settings-msg" role="status">正在读取 MCP 配置…</p> : null}

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
        {mcpDraft.tools.length ? (
          <div className="settings-actions">
            <button type="button" className="btn" disabled={busy || !mcpDraft.selectedTools.length} onClick={() => void saveMcp()}>
              {mcpDraft.editingServerId ? "更新 MCP" : "保存 MCP"}
            </button>
          </div>
        ) : null}
      </section>

      {busyLabel ? <p className="settings-msg" role="status">{busyLabel}</p> : null}
      {notice ? <p className="settings-msg ok" role="status">{notice}</p> : null}
      {error ? <p className="settings-msg err" role="alert">{error}</p> : null}
    </div>
  );
}
