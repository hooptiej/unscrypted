/**
 * Read config.json as-is (secrets and all). Shared by the admin pane's config store and the
 * dashboard's one-shot Homedash import CLI, so the CLI doesn't import the admin pane (#46).
 */

import * as fs from "fs";
import { Config } from "../config";
import { UserError } from "./errors";

export function readRawConfig(file: string): Config {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new UserError({
      attempted: `Read ${file}`,
      happened: `The config file couldn't be read: ${(err as Error).message}`,
      changed: "Nothing was changed.",
      next: "Check the ./config folder is mounted and readable by the container, then reload.",
    }, 500);
  }
  try {
    return JSON.parse(text) as Config;
  } catch (err) {
    throw new UserError({
      attempted: `Read ${file}`,
      happened: `config.json isn't valid JSON: ${(err as Error).message}`,
      changed: "Nothing was changed.",
      next: "Fix the file by hand (or restore the newest copy from ./config/backups), then reload.",
    }, 500);
  }
}
