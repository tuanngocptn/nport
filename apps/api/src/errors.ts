/**
 * The one way this Worker fails.
 *
 * **Never `throw new Error()`** (rule 2 in `apps/api/CLAUDE.md`). Throw [`ApiError`] with a code
 * from `@nport/contract`, and the error handler turns it into the documented envelope with the
 * right status.
 *
 * v2 threw plain `Error`s whose messages carried a `PREFIX:` convention, returned them all as
 * HTTP 500, and the CLI matched substrings like `'currently in use'`. Every part of that is
 * closed here: the status comes from the registry, the code is an enum, and the message is never
 * load-bearing (ADR-0018).
 */

import { docsUrl, ERRORS, type ErrorCode, type ServerErrorCode } from "@nport/contract"

/** Extra, code-specific context. Documented per code in `docs/ERRORS.md`. */
export type ErrorDetails = Record<string, unknown>

export class ApiError extends Error {
  readonly code: ServerErrorCode
  readonly details: ErrorDetails | undefined

  /**
   * `message` is deliberately not a parameter. It comes from the registry, so every occurrence of
   * a code reads identically and translation has exactly one source. Ad-hoc messages are how a
   * code's meaning drifts between call sites.
   */
  constructor(code: ServerErrorCode, details?: ErrorDetails) {
    super(ERRORS[code].message)
    this.name = "ApiError"
    this.code = code
    this.details = details
  }

  get status(): number {
    const status = ERRORS[this.code].status
    // Unreachable via ServerErrorCode, but this runs at the boundary where a value may have come
    // from somewhere the type system does not reach.
    return status ?? 500
  }

  get retryable(): boolean {
    return ERRORS[this.code].retryable
  }
}

/** The wire envelope. Shape is fixed by `docs/ERRORS.md` § Response shape. */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode
    message: string
    details?: ErrorDetails
    requestId: string
    docsUrl: string
  }
}

export function envelope(error: ApiError, requestId: string, origin?: string): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      requestId,
      docsUrl: docsUrl(error.code, origin),
    },
  }
}
