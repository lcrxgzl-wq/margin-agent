import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/cli");
const pkgPath = path.join(cli, "package.json");
const backupPath = path.join(cli, ".package.json.release-backup");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, `${JSON.stringify(pkg, null, 2)}\n`);
}
// Keep packages that must load from node_modules (native bindings / DOM polyfills).
const keep = {};
for (const name of ["pdf-parse"]) {
  if (pkg.dependencies?.[name]) keep[name] = pkg.dependencies[name];
}
pkg.dependencies = keep;
delete pkg.devDependencies;
delete pkg.overrides;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`release-strip-deps: kept ${Object.keys(keep).join(", ") || "(none)"}`);
