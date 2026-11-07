// #45: the container runs as a normal user. The entrypoint itself can only be exercised in Docker
// (it needs root and chown), so these tests pin the wiring a refactor could quietly break: the
// Dockerfile uses the entrypoint, the entrypoint backs up the pairing BEFORE it chowns and checks
// the pairing afterwards, and shell scripts keep their LF line endings on a Windows checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const root = path.join(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n");

test("the Dockerfile copies the entrypoint in, checks setpriv exists at build time, and starts through it", () => {
  const d = read("Dockerfile");
  assert.match(d, /COPY scripts\/docker-entrypoint\.sh \/usr\/local\/bin\/unscrypted-entrypoint/);
  assert.match(d, /setpriv --version/);
  assert.match(d, /ENTRYPOINT \["\/usr\/local\/bin\/unscrypted-entrypoint"\]/);
  assert.match(d, /CMD \["node", "dist\/index\.js"\]/);
  assert.ok(fs.existsSync(path.join(root, "scripts", "docker-entrypoint.sh")));
});

test("shell scripts are forced to LF, or a Windows checkout would build an entrypoint that can't run", () => {
  assert.match(read(".gitattributes"), /^\*\.sh text eol=lf$/m);
  const script = fs.readFileSync(path.join(root, "scripts", "docker-entrypoint.sh"), "utf8");
  assert.ok(script.startsWith("#!/bin/sh\n"), "needs a /bin/sh shebang with an LF ending");
});

test("the entrypoint backs up the pairing before chown, verifies it after, and fails loudly", () => {
  const s = read("scripts/docker-entrypoint.sh");
  const backup = s.indexOf('cp -a "$PERSIST_DIR" "$BACKUP"');
  const chown = s.indexOf('chown -h "$APP_UID:$APP_GID"');
  const verify = s.indexOf("! -readable");
  const drop = s.indexOf("exec setpriv");
  assert.ok(backup > 0 && chown > backup, "the pairing backup must come before the first chown");
  assert.ok(verify > chown, "the pairing readability check must come after the chown");
  assert.ok(drop > verify, "privileges are dropped only after the checks pass");
  assert.match(s, /die\(\)\s+\{ .*exit 1; \}/, "a failed check exits non-zero");
  assert.match(s, /was NOT started/, "a refusal says the app was not started");
  assert.match(s, /find "\$d" -xdev .*-exec chown -h/, "the chown only touches wrong files and never crosses into another mount");
});

test("compose no longer mounts secrets read-only (the entrypoint must give the app read access)", () => {
  const c = read("docker-compose.yml");
  assert.match(c, /^\s+- \.\/secrets:\/run\/secrets$/m);
  assert.doesNotMatch(c, /\.\/secrets:\/run\/secrets:ro/);
});
