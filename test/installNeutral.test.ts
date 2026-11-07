// #44: nothing about one house's network ships in the image. This reads the shipped code, the image
// and compose files, the default config and the docs, and fails if a home address, a home path or a
// "the NAS" hint creeps back. The household's real values belong in .env / config / the saved
// ./data/dash/settings.json, never here. (Tests may use any addresses; they aren't shipped.)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");

function files(dir: string, keep: (f: string) => boolean, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

const shipped: string[] = [
  ...files(path.join(root, "src"), () => true),
  ...files(path.join(root, "web"), () => true),
  ...files(path.join(root, "scripts", "mac-kiosk"), () => true),
  ...["Dockerfile", "docker-compose.yml", "docker-compose.test.yml", "config.example.json", ".env.example", "README.md",
    path.join("scripts", "deploy.sh"), path.join("scripts", "docker-entrypoint.sh")].map((f) => path.join(root, f)),
];

// scripts/nas/ipvlan-shim.sh is deliberately NOT here: it's a per-install helper whose first lines
// (parent interface, shim address, app list) the README tells you to edit before use.
const FORBIDDEN: [RegExp, string][] = [
  [/\b10\.0\.1\.\d/, "a 10.0.1.x home address"],
  [/Storage Pool/i, "the NAS's dataset path"],
  [/\bhoop\b/i, "the owner's login name"],
  [/~\/unscrypted(?![-\w])/, "the prod checkout path ~/unscrypted"],
  [/\bon the NAS\b/i, "'on the NAS' (say 'on the host')"],
];

test("no home address, path or 'on the NAS' hint ships in code, image, compose files, default config or docs (#44)", () => {
  assert.ok(shipped.length > 50, "found the shipped files");
  const hits: string[] = [];
  for (const f of shipped) {
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [re, what] of FORBIDDEN) if (re.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}: ${what}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, [], `home-specific values found; move them to .env/config or reword:\n${hits.join("\n")}`);
});

test("the checker itself catches what it should", () => {
  for (const bad of ["http://10.0.1.78:8190", "/mnt/Storage Pool/x", "ssh hoop@host", "put it in ~/unscrypted/secrets", "Check it on the NAS."]) {
    assert.ok(FORBIDDEN.some(([re]) => re.test(bad)), bad);
  }
  for (const ok of ["hooptiej/unscrypted#11", "http://192.168.1.20", "on the host", "secrets/admin_password next to docker-compose.yml"]) {
    assert.ok(!FORBIDDEN.some(([re]) => re.test(ok)), ok);
  }
});
