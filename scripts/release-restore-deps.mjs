import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/cli");
const pkgPath = path.join(cli, "package.json");
const backupPath = path.join(cli, ".package.json.release-backup");
if (!fs.existsSync(backupPath)) {
  console.log("release-restore-deps: no backup; skip");
  process.exit(0);
}
fs.copyFileSync(backupPath, pkgPath);
fs.unlinkSync(backupPath);
console.log("release-restore-deps: restored package.json");
