import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  disabledSkillNames,
  readSkillSettings,
  setSkillMode,
  skillPreference,
} from "./skill-settings.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-skill-settings-"));
  roots.push(root);
  return root;
}

describe("skill-settings", () => {
  it("defaults every skill to auto when the file is absent", () => {
    const root = tempRoot();
    const store = readSkillSettings(root);
    expect(store.skills).toEqual({});
    expect(skillPreference(store, "format-tidy-zh")).toBe("auto");
    expect(disabledSkillNames(store)).toEqual([]);
  });

  it("persists off and removes the override when reset to auto", async () => {
    const root = tempRoot();
    const off = await setSkillMode(root, "format-tidy-zh", "off");
    expect(off.skills).toEqual({ "format-tidy-zh": "off" });

    const reloaded = readSkillSettings(root);
    expect(skillPreference(reloaded, "format-tidy-zh")).toBe("off");
    expect(disabledSkillNames(reloaded)).toEqual(["format-tidy-zh"]);

    const auto = await setSkillMode(root, "format-tidy-zh", "auto");
    expect(auto.skills).toEqual({});
    expect(readSkillSettings(root).skills).toEqual({});
    expect(fs.readFileSync(path.join(root, ".margin", "skill-settings.json"), "utf8"))
      .not.toContain("format-tidy-zh");
  });

  it("drops invalid names, modes, and corrupt JSON without throwing", async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, ".margin"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".margin", "skill-settings.json"),
      JSON.stringify({
        skills: {
          "good-skill": "off",
          "Bad Name": "off",
          "another-skill": "sometimes",
          "third-skill": "auto",
        },
      }),
    );
    const store = readSkillSettings(root);
    expect(store.skills).toEqual({ "good-skill": "off", "third-skill": "auto" });

    fs.writeFileSync(path.join(root, ".margin", "skill-settings.json"), "{not json");
    expect(readSkillSettings(root).skills).toEqual({});
  });

  it("rejects invalid writes", async () => {
    const root = tempRoot();
    await expect(setSkillMode(root, "Bad Name", "off")).rejects.toThrow(/invalid skill name/);
    await expect(setSkillMode(root, "ok-skill", "on" as never)).rejects.toThrow(/invalid skill mode/);
    expect(fs.existsSync(path.join(root, ".margin", "skill-settings.json"))).toBe(false);
  });
});
