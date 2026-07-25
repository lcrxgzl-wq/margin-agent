import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillScope } from "../index.js";

export type SkillMeta = {
  name: string;
  description: string;
  filePath: string;
  contentHash: string;
  /** Pack membership from frontmatter; absent = core (visible in every scope). */
  packs?: string[];
  source?: "bundled" | "workspace";
};

export type LoadedSkill = SkillMeta & {
  body: string;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

function packageSkillsRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Workspace package: ../../skills. Bundled margin-agent: ../skills.
  const candidates = [path.resolve(here, "../../skills"), path.resolve(here, "../skills")];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

export function parseSkillMarkdown(filePath: string, raw: string): LoadedSkill | null {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return null;
  const fm = m[1] ?? "";
  const body = (m[2] ?? "").trim();
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  const name = nameMatch?.[1]?.trim();
  const description = descMatch?.[1]?.trim();
  if (!name || !description) return null;
  const packsMatch = fm.match(/^packs:\s*(.+)$/m);
  const packs = packsMatch?.[1]?.split(",").map((pack) => pack.trim().toLowerCase()).filter(Boolean);
  const contentHash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return { name, description, filePath, contentHash, body, ...(packs?.length ? { packs } : {}) };
}

/** Discover bundled skills shipped with @margin/harness (not workspace skills). */
export function listBundledSkills(skillsRoot = packageSkillsRoot()): SkillMeta[] {
  if (!fs.existsSync(skillsRoot)) return [];
  const out: SkillMeta[] = [];
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(skillsRoot, entry.name, "SKILL.md");
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = parseSkillMarkdown(filePath, raw);
    if (parsed) {
      out.push({
        name: parsed.name,
        description: parsed.description,
        filePath: parsed.filePath,
        contentHash: parsed.contentHash,
        packs: parsed.packs,
        source: skillsRoot === packageSkillsRoot() ? "bundled" : "workspace",
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function listAvailableSkills(workspaceSkillsRoot?: string, scope: SkillScope = "all"): SkillMeta[] {
  if (scope === "none") return [];
  const workspace = workspaceSkillsRoot
    ? listBundledSkills(workspaceSkillsRoot).map((skill) => ({ ...skill, source: "workspace" as const }))
    : [];
  const overridden = new Set(workspace.map((skill) => skill.name));
  const merged = [
    ...listBundledSkills().filter((skill) => !overridden.has(skill.name)),
    ...workspace,
  ].sort((left, right) => left.name.localeCompare(right.name));
  if (scope === "core") {
    return merged.filter(
      (skill) => !skill.packs || skill.packs.includes("core") || skill.packs.includes("office"),
    );
  }
  return merged;
}

export function loadBundledSkill(
  name: string,
  skillsRoot = packageSkillsRoot(),
): LoadedSkill {
  const skills = listBundledSkills(skillsRoot);
  const meta = skills.find((s) => s.name === name);
  if (!meta) {
    throw new Error(`Unknown skill: ${name}`);
  }
  const raw = fs.readFileSync(meta.filePath, "utf8");
  const parsed = parseSkillMarkdown(meta.filePath, raw);
  if (!parsed) throw new Error(`Invalid skill file: ${name}`);
  return parsed;
}

export function loadAvailableSkill(
  name: string,
  workspaceSkillsRoot?: string,
  scope: SkillScope = "all",
): LoadedSkill {
  const inScope = listAvailableSkills(workspaceSkillsRoot, scope).some((skill) => skill.name === name);
  if (!inScope) {
    throw new Error(`Unknown skill: ${name}`);
  }
  if (workspaceSkillsRoot) {
    const workspace = listBundledSkills(workspaceSkillsRoot).find((skill) => skill.name === name);
    if (workspace) return loadBundledSkill(name, workspaceSkillsRoot);
  }
  return loadBundledSkill(name);
}

export async function importWorkspaceSkill(
  workspaceSkillsRoot: string,
  raw: string,
): Promise<SkillMeta> {
  if (Buffer.byteLength(raw, "utf8") > 128 * 1024) {
    throw new Error("SKILL.md exceeds 128 KiB");
  }
  const parsed = parseSkillMarkdown("SKILL.md", raw);
  if (!parsed) throw new Error("SKILL.md requires name and description frontmatter");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed.name)) {
    throw new Error("skill name must use lowercase letters, numbers, and hyphens");
  }
  if (parsed.description.length > 300) throw new Error("skill description is too long");
  if (!parsed.body) throw new Error("skill body is empty");
  fs.mkdirSync(workspaceSkillsRoot, { recursive: true });
  if (fs.lstatSync(workspaceSkillsRoot).isSymbolicLink()) {
    throw new Error("workspace skills directory cannot be a symbolic link");
  }
  const realRoot = fs.realpathSync(workspaceSkillsRoot);
  const targetDir = path.join(workspaceSkillsRoot, parsed.name);
  const targetDirExists = fs.existsSync(targetDir);
  if (targetDirExists && fs.lstatSync(targetDir).isSymbolicLink()) {
    throw new Error("skill directory cannot be a symbolic link");
  }
  if (!targetDirExists) fs.mkdirSync(targetDir);
  const realTargetDir = fs.realpathSync(targetDir);
  const relativeTarget = path.relative(realRoot, realTargetDir);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error("skill directory escapes workspace skills root");
  }
  const target = path.join(targetDir, "SKILL.md");
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || stat.nlink > 1) {
      throw new Error("existing SKILL.md must be a regular single-link file");
    }
  }
  const temporary = path.join(targetDir, `.SKILL.md.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.writeFile(temporary, raw.replace(/\r\n/g, "\n"), "utf8");
  await fs.promises.rename(temporary, target);
  return { ...parsed, filePath: target, source: "workspace" };
}

export async function removeWorkspaceSkill(
  workspaceSkillsRoot: string,
  name: string,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error("skill name must use lowercase letters, numbers, and hyphens");
  }
  if (!fs.existsSync(workspaceSkillsRoot)) throw new Error("workspace skill not found");
  const rootStat = fs.lstatSync(workspaceSkillsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("workspace skills directory must be a real directory");
  }
  const realRoot = fs.realpathSync(workspaceSkillsRoot);
  const targetDir = path.join(workspaceSkillsRoot, name);
  if (!fs.existsSync(targetDir)) throw new Error("workspace skill not found");
  const targetDirStat = fs.lstatSync(targetDir);
  if (!targetDirStat.isDirectory() || targetDirStat.isSymbolicLink()) {
    throw new Error("skill directory must be a real directory");
  }
  const realTargetDir = fs.realpathSync(targetDir);
  const relativeTarget = path.relative(realRoot, realTargetDir);
  if (!relativeTarget || relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error("skill directory escapes workspace skills root");
  }

  const target = path.join(targetDir, "SKILL.md");
  if (!fs.existsSync(target)) throw new Error("workspace skill not found");
  const targetStat = fs.lstatSync(target);
  if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) {
    throw new Error("SKILL.md must be a regular single-link file");
  }
  const parsed = parseSkillMarkdown(target, fs.readFileSync(target, "utf8"));
  if (!parsed || parsed.name !== name) {
    throw new Error("SKILL.md name does not match its workspace directory");
  }

  await fs.promises.unlink(target);
  if ((await fs.promises.readdir(targetDir)).length === 0) {
    await fs.promises.rmdir(targetDir);
  }
}

/** Pi-style skills index: names + descriptions only (full text via load_skill). */
export function formatSkillsForPrompt(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "",
    "Available skills (load with load_skill when the task matches):",
    "<available_skills>",
  ];
  for (const s of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${s.name}</name>`);
    lines.push(`    <description>${s.description}</description>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
