export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Err = {
  unauthenticated: (m = "authentication required") => new AppError("unauthenticated", m, 401),
  unauthorized: (m = "not authorized") => new AppError("unauthorized", m, 403),
  notFound: (m = "not found") => new AppError("not_found", m, 404),
  invalidMetadata: (m: string) => new AppError("invalid_metadata", m, 400),
  browserUnavailable: (m = "browser unavailable") => new AppError("browser_unavailable", m, 409, true),
  browserStarting: (m = "browser is starting") => new AppError("browser_starting", m, 409, true),
  fleetFull: (m = "browser fleet is full") => new AppError("fleet_full", m, 429, true),
  humanControlling: (m = "browser is controlled by a human; retry later") =>
    new AppError("human_controlling_browser", m, 409, true),
  alreadyControlled: (m = "browser already has a controller") => new AppError("already_controlled", m, 409),
  credentialRevoked: (m = "credential revoked") => new AppError("credential_revoked", m, 401),
  rateLimited: (m = "rate limited") => new AppError("rate_limited", m, 429, true),
  conflict: (m: string) => new AppError("conflict", m, 409),
  invalid: (m: string) => new AppError("invalid_request", m, 400),
};

export function errorBody(err: unknown): { error: { code: string; message: string; retryable: boolean } } {
  if (err instanceof AppError) {
    return { error: { code: err.code, message: err.message, retryable: err.retryable } };
  }
  return { error: { code: "internal", message: "internal error", retryable: false } };
}

export function statusOf(err: unknown): number {
  return err instanceof AppError ? err.status : 500;
}
