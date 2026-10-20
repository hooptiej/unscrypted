/**
 * Temp folders for tests that are always removed when the test file finishes, so runs don't
 * leave unscr-* folders behind in the OS temp dir. A folder that can't be removed is reported
 * (the test run fails) rather than silently left.
 */

import { after } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const made: string[] = [];

after(() => {
  const failed: string[] = [];
  for (const d of made.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (err) {
      failed.push(`${d}: ${(err as Error).message}`);
    }
  }
  if (failed.length) throw new Error(`couldn't remove test temp folders:\n${failed.join("\n")}`);
});

/** A fresh empty folder under the OS temp dir, removed after this test file's tests finish. */
export function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
