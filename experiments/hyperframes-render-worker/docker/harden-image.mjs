/**
 * Runs once during the image build. The worker only ever calls `check` and `render`, so the
 * commands that read agent credentials, reach HeyGen or publish are deleted from the pinned
 * package, along with the copy of GSAP it vendors. Environment variables alone would leave
 * them one flag away. Fails the build if a listed target has moved, because a silently missed
 * deletion would look the same as a successful one.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const DIST = "/app/node_modules/hyperframes/dist";

/** Command modules, matched by name because their chunk hashes are fixed by the pinned version. */
const COMMAND_CHUNKS = [
  "auth",
  "billing",
  "cloud",
  "cloudrun",
  "lambda",
  "login",
  "publish",
  "usage",
  "upgrade",
  "skills",
  "tts",
  "transcribe",
  "remove-background",
  "preview",
  "init",
];
const DIRECTORIES = ["skills", "studio", "vendor"];

const files = readdirSync(DIST);
for (const name of COMMAND_CHUNKS) {
  const matches = files.filter((file) => new RegExp(`^${name}-[A-Z0-9]{8}\\.js$`).test(file));
  if (matches.length === 0) throw new Error(`harden-image: no chunk for "${name}"`);
  for (const match of matches) rmSync(join(DIST, match));
}
for (const directory of DIRECTORIES) {
  const path = join(DIST, directory);
  if (!existsSync(path)) throw new Error(`harden-image: missing ${directory}`);
  rmSync(path, { recursive: true });
}
