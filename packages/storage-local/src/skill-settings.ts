import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";

/**
 * Workspace-scoped persistent Skill control.
 * Only two persistent modes exist: "off" (user-disabled) and "auto" (default,
 * resolved by profile scope). Explicit one-turn use travels as structured
 * selected skill ids on each request — never persisted here.
 */
export type SkillMode = "off" | "auto";

export type SkillSettingsStore = {
  /** Absent skill name = auto. */
  skills: Record<string, SkillMode>;
};

const FILE = "skill-settings.json";
const MAX_ENTRIES = 200;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function settingsPath(root: string): string {
  return path.join(root, ".margin", FILE);
}

export function readSkillSettings(root: string): SkillSettingsStore {
  const abs = settingsPath(root);
  if (!fs.existsSync(abs)) return { skills: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
    const container =
      raw && typeof raw === "object" && !Array.isArray(raw.skills) ? raw.skills : undefined;
    const skills: Record<string, SkillMode> = {};
    if (container && typeof container === "object") {
      for (const [name, mode] of Object.entries(container).slice(0, MAX_ENTRIES)) {
        if (!NAME_RE.test(name)) continue;
        if (mode === "off" || mode === "auto") skills[name] = mode;
      }
    }
    return { skills };
  } catch {
    return { skills: {} };
  }
}

export function skillPreference(store: SkillSettingsStore, name: string): SkillMode {
  return store.skills[name] ?? "auto";
}

export function disabledSkillNames(store: SkillSettingsStore): string[] {
  return Object.entries(store.skills)
    .filter(([, mode]) => mode === "off")
    .map(([name]) => name);
}

/** Persist one skill's mode; "auto" removes the override (default state). */
export async function setSkillMode(
  root: string,
  name: string,
  mode: SkillMode,
): Promise<SkillSettingsStore> {
  if (!NAME_RE.test(name)) throw new Error(`invalid skill name: ${name}`);
  if (mode !== "off" && mode !== "auto") throw new Error(`invalid skill mode: ${String(mode)}`);
  const store = readSkillSettings(root);
  const skills = { ...store.skills };
  if (mode === "auto") delete skills[name];
  else skills[name] = mode;
  const abs = settingsPath(root);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await writeFileAtomic(abs, `${JSON.stringify({ skills }, null, 2)}\n`, "utf8");
  return { skills };
}
