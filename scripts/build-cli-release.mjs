import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "apps", "cli");

await build({
  entryPoints: [path.join(cli, "src", "index.ts")],
  outfile: path.join(cli, "dist", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  packages: "external",
  alias: {
    "@margin/agent": path.join(root, "packages", "agent", "src", "index.ts"),
    "@margin/domain": path.join(root, "packages", "domain", "src", "index.ts"),
    "@margin/harness": path.join(root, "packages", "harness", "src", "index.ts"),
    "@margin/llm": path.join(root, "packages", "llm", "src", "index.ts"),
    "@margin/storage-local": path.join(root, "packages", "storage-local", "src", "index.ts"),
  },
});

const copyDirectory = (source, destination) => {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
};

copyDirectory(path.join(root, "apps", "web", "dist"), path.join(cli, "web-dist"));
copyDirectory(path.join(root, "packages", "harness", "skills"), path.join(cli, "skills"));

for (const file of ["README.md", "THIRD_PARTY_NOTICES.md", "LICENSE"]) {
  fs.copyFileSync(path.join(root, file), path.join(cli, file));
}
