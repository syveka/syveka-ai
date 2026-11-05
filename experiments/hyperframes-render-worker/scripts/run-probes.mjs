/**
 * Runs container-probes.mjs inside the image, under the same flags as a real render.
 * Usage: node scripts/run-probes.mjs <emptyInputDir>
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDockerArgs, IMAGE } from "./run-worker.mjs";

const [inputDir] = process.argv.slice(2);
if (!inputDir) {
  process.stderr.write("usage: run-probes.mjs <emptyInputDir>\n");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const args = buildDockerArgs({ inputDir: resolve(inputDir) });
// The same flags, with only the entry point changed and the probe script mounted read-only.
args.splice(
  args.indexOf(IMAGE),
  1,
  `--mount=type=bind,source=${here},target=/probes,readonly`,
  "--entrypoint=node",
  IMAGE,
  "/probes/container-probes.mjs",
);
const run = spawnSync("docker", args, { stdio: "inherit" });
process.exit(run.status ?? 1);
