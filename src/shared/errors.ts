/** Every failure the pane can show: what was tried, what happened, what changed, what to do. */
export interface UserErrorBody {
  attempted: string;
  happened: string;
  changed: string;
  next: string;
}

export class UserError extends Error {
  constructor(public readonly body: UserErrorBody, public readonly status = 400) {
    super(`${body.attempted}: ${body.happened}`);
    this.name = "UserError";
  }
}

export function toErrorJson(err: unknown, attempted: string): { status: number; body: { error: UserErrorBody } } {
  if (err instanceof UserError) return { status: err.status, body: { error: err.body } };
  const msg = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: {
      error: {
        attempted,
        happened: `Unexpected error inside unscrypted: ${msg}`,
        changed: "Unknown; check the bridge log before retrying.",
        next: "Look at `docker logs unscrypted` for the full error, then retry. If it repeats, file an issue with the log lines.",
      },
    },
  };
}
