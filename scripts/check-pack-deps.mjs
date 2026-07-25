import { readFileSync } from "node:fs";

const files = [
  "packages/agent/src/pi-tools.ts",
  "packages/agent/src/session-runner.ts",
];
const forbidden = /from\s+["']\.\/academic/;
const violations = files.filter((file) => forbidden.test(readFileSync(file, "utf8")));

if (violations.length) {
  throw new Error(`Pack dependency violation: ${violations.join(", ")}`);
}
