/** Map host filesystem read/list throws to short actionable Chinese for the agent UI. */
export function mapHostFsError(message: string): string {
  const m = message.trim();
  if (/outside workspace.*unlimited read is off/i.test(m)) {
    return "外读已关闭：请在 Agent 设置中开启「外读」，或取消 MARGIN_UNLIMITED=0。";
  }
  if (/refusing to read sensitive path/i.test(m)) {
    return "拒绝读取密钥或敏感路径；请换用普通资料文件。";
  }
  if (/path is a directory.*list_workspace_files/i.test(m)) {
    return "这是目录不是文件：请用 list_workspace_files 列目录，再 read_workspace_file 读具体文件。";
  }
  if (/path is a directory/i.test(m)) {
    return "这是目录不是文件：请用 list_workspace_files 列目录，再读具体文件路径。";
  }
  if (/directory path must be absolute/i.test(m)) {
    return "列目录需要本机绝对路径；工作区资料可省略 directory。";
  }
  if (/directory not found|not a directory/i.test(m)) {
    return "目录不存在或不是文件夹；请核对绝对路径。";
  }
  if (/file not found/i.test(m)) {
    return "文件不存在；请核对路径或先用 list_workspace_files 查找。";
  }
  if (/only md\/txt\/json\/csv\/pdf\/docx can be read/i.test(m)) {
    return "仅支持 md/txt/json/csv/pdf/docx；请换支持的格式或给正确扩展名。";
  }
  if (/file too large to read/i.test(m)) {
    return "文本文件过大无法读取；请缩小文件或只读其中一段。";
  }
  if (/source file is too large/i.test(m)) {
    return "PDF/DOCX 过大（上限 25 MiB）；请换较小文件。";
  }
  if (/external directory listing is not available/i.test(m)) {
    return "当前宿主不支持外部位目录列表。";
  }
  return m;
}
