/** Map paper-tool names to short Chinese status labels. */
export function toolPhaseLabel(toolName: string): string {
  switch (toolName) {
    case "get_document_outline":
      return "正在阅读大纲…";
    case "list_blocks":
      return "正在浏览段落…";
    case "read_document_blocks":
      return "正在通读文稿…";
    case "get_block":
      return "正在阅读选中段落…";
    case "search_blocks":
      return "正在检索段落…";
    case "offer_cascade":
      return "正在整理联动候选…";
    case "propose_block_edit":
    case "propose_text_patch":
      return "正在起草修订…";
    case "propose_table_cell_edit":
      return "正在起草表格单元格修订…";
    case "propose_block_comment":
      return "正在写侧注…";
    case "cite_check":
      return "正在检查引用形态…";
    case "style_lint":
      return "正在做文风检查…";
    case "finish_scan":
    case "finish_turn":
      return ""; // lifecycle — hide from UI
    case "list_workspace_files":
      return "正在列出工作区文稿…";
    case "read_workspace_file":
      return "正在读取文件…";
    case "write_workspace_file":
      return "正在写入文件…";
    case "open_document":
      return "正在打开文稿…";
    case "load_skill":
      return "正在加载写作技能…";
    case "inspect_tabular_file":
      return "正在检查数据表…";
    case "run_table_analysis":
      return "正在运行数据分析…";
    case "get_analysis_result":
      return "正在读取分析结果…";
    case "propose_block_edit_from_results":
      return "正在把结果写入修订提案…";
    default:
      return toolName ? `正在${toolName}…` : "";
  }
}

/** Hide internal lifecycle noise from status stream / UI. */
export function isUserFacingPhase(phase: string): boolean {
  const t = phase.trim();
  if (!t) return false;
  if (
    /^(启动 Agent|离线 Agent|本轮完成|结束本轮|形成回复|回复|工具环)/i.test(t)
  ) {
    return false;
  }
  if (/启动|完成（/i.test(t) && t.length < 24) {
    return !/起草|打开|列出|读取|写入|修订|侧注|检查/.test(t);
  }
  return true;
}
