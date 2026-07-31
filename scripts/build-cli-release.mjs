import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "apps", "cli");

const ESM_SHIM = `import { createRequire } from "node:module";
import { fileURLToPath as __marginFileURLToPath } from "node:url";
import { dirname as __marginDirname } from "node:path";
const require = createRequire(import.meta.url);
const __filename = __marginFileURLToPath(import.meta.url);
const __dirname = __marginDirname(__filename);
`;

await build({
  entryPoints: [path.join(cli, "src", "index.ts")],
  outfile: path.join(cli, "dist", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // Bundle npm deps so `npm i -g` does not re-resolve broken transitive ranges
  // (e.g. @aws-sdk/core@^3.977.4 before that version exists on the registry).
  // Fastify/avvio still emit CJS dynamic require("node:*"); provide createRequire.
  // write-file-atomic (llm-settings save) needs __filename/__dirname in ESM.
  // pdf-parse stays external: it needs @napi-rs/canvas's native DOMMatrix polyfill.
  external: ["pdf-parse"],
  banner: { js: ESM_SHIM },
  alias: {
    "@margin/agent": path.join(root, "packages", "agent", "src", "index.ts"),
    "@margin/domain": path.join(root, "packages", "domain", "src", "index.ts"),
    "@margin/harness": path.join(root, "packages", "harness", "src", "index.ts"),
    "@margin/llm": path.join(root, "packages", "llm", "src", "index.ts"),
    "@margin/storage-local": path.join(root, "packages", "storage-local", "src", "index.ts"),
  },
});

// Keep a single shebang + ESM shims at the top (entry shebang must not remain).
const outfile = path.join(cli, "dist", "index.js");
let bundled = fs.readFileSync(outfile, "utf8");
bundled = bundled.replace(/^(?:#!\/usr\/bin\/env node\r?\n)+/, "");
bundled = bundled.replace(
  /^(?:import \{ createRequire \} from "node:module";\r?\n(?:import \{ fileURLToPath as __marginFileURLToPath \} from "node:url";\r?\n)?(?:import \{ dirname as __marginDirname \} from "node:path";\r?\n)?const require = createRequire\(import\.meta\.url\);\r?\n(?:const __filename = __marginFileURLToPath\(import\.meta\.url\);\r?\n)?(?:const __dirname = __marginDirname\(__filename\);\r?\n)?)+/,
  "",
);
fs.writeFileSync(outfile, `#!/usr/bin/env node\n${ESM_SHIM}\n${bundled}`);

const copyDirectory = (source, destination) => {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
};

copyDirectory(path.join(root, "apps", "web", "dist"), path.join(cli, "web-dist"));
copyDirectory(path.join(root, "packages", "harness", "skills"), path.join(cli, "skills"));

for (const file of ["README.md", "THIRD_PARTY_NOTICES.md", "LICENSE"]) {
  fs.copyFileSync(path.join(root, file), path.join(cli, file));
}
