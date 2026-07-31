/**
 * Typed application errors. Each carries the HTTP status it maps to, so the
 * central error middleware never has to guess and a thrown error can never
 * become an accidental 200.
 */

export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bad client input. 400. */
export class ValidationError extends AppError {
  readonly status = 400;
  readonly code = 'VALIDATION_ERROR';

  constructor(message: string, readonly field?: string) {
    super(message, field ? { field } : undefined);
  }
}

/**
 * Caller is going too fast. 429.
 *
 * Used by the demo-charge endpoint, which is a public, unauthenticated write to
 * a third-party API — without a limit, one page left open in a loop would fill
 * the Stripe test account.
 */
export class RateLimitedError extends AppError {
  readonly status = 429;
  readonly code = 'RATE_LIMITED';

  constructor(retryAfterSeconds: number) {
    super(`Too many requests. Try again in ${retryAfterSeconds}s.`, { retryAfterSeconds });
  }
}

/** Client asked for a source that does not exist. 400. */
export class UnknownSourceError extends AppError {
  readonly status = 400;
  readonly code = 'UNKNOWN_SOURCE';

  constructor(requested: string, available: readonly string[]) {
    super(`Unknown source '${requested}'. Available: ${available.join(', ')}`, {
      requested,
      available,
    });
  }
}

/**
 * Upstream provider is unreachable or returned 5xx. 503 — the request may
 * succeed later, which is different from a misconfiguration.
 */
export class UpstreamUnavailableError extends AppError {
  readonly status = 503;
  readonly code = 'UPSTREAM_UNAVAILABLE';

  constructor(source: string, cause?: unknown) {
    super(`Source '${source}' is currently unavailable`, {
      source,
      cause: cause instanceof Error ? cause.message : String(cause ?? ''),
    });
  }
}

/**
 * Upstream rejected our credentials or our request. 502 — retrying will not
 * help; distinguishing this from an outage is the difference between "wait" and
 * "fix your key".
 */
export class UpstreamConfigError extends AppError {
  readonly status = 502;
  readonly code = 'UPSTREAM_CONFIG_ERROR';

  constructor(source: string, message: string) {
    super(`Source '${source}' rejected the request: ${message}`, { source });
  }
}

/** Database failure. 500. */
export class DatabaseError extends AppError {
  readonly status = 500;
  readonly code = 'DATABASE_ERROR';

  constructor(operation: string, cause?: unknown) {
    super(`Database operation failed: ${operation}`, {
      operation,
      cause: cause instanceof Error ? cause.message : String(cause ?? ''),
    });
  }
}

/** Required configuration missing at boot. */
export class ConfigError extends AppError {
  readonly status = 500;
  readonly code = 'CONFIG_ERROR';
}
