import { ERROR_MESSAGES, ERROR_STATUS, ErrorCode } from '@minedesk/protocol';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/**
 * The only error type route handlers should throw.
 *
 * `message` is always safe to show a user. Anything sensitive goes in `logContext`,
 * which is written to the structured log and never serialized into the response.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly logContext?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    options: { message?: string; details?: unknown; logContext?: Record<string, unknown> } = {},
  ) {
    super(options.message ?? ERROR_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
    this.details = options.details;
    this.logContext = options.logContext;
  }
}

export const badRequest = (details?: unknown) => new AppError(ErrorCode.VALIDATION_ERROR, { details });
export const notFound = (code: ErrorCode = ErrorCode.NOT_FOUND) => new AppError(code);
export const forbidden = (code: ErrorCode = ErrorCode.PERMISSION_DENIED) => new AppError(code);
export const unauthorized = (code: ErrorCode = ErrorCode.AUTHENTICATION_FAILED) => new AppError(code);

/**
 * Global error handler. Guarantees a uniform body shape and, above all, that no
 * stack trace, SQL fragment or driver message ever leaves the process.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | ZodError, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      // Expected, already-classified failures: log at info/warn, not error.
      request.log[error.statusCode >= 500 ? 'error' : 'info'](
        { code: error.code, statusCode: error.statusCode, ...error.logContext },
        error.message,
      );
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details, requestId },
      });
    }

    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
      }));
      request.log.info({ details }, 'request validation failed');
      return reply.status(400).send({
        error: { code: ErrorCode.VALIDATION_ERROR, message: ERROR_MESSAGES.VALIDATION_ERROR, details, requestId },
      });
    }

    const fastifyError = error as FastifyError;

    if (fastifyError.statusCode === 429) {
      return reply.status(429).send({
        error: { code: ErrorCode.RATE_LIMITED, message: ERROR_MESSAGES.RATE_LIMITED, requestId },
      });
    }

    if (fastifyError.validation) {
      return reply.status(400).send({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: ERROR_MESSAGES.VALIDATION_ERROR,
          details: fastifyError.validation.map((v) => ({ field: v.instancePath || '(root)', message: v.message })),
          requestId,
        },
      });
    }

    if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({
        error: { code: ErrorCode.VALIDATION_ERROR, message: fastifyError.message, requestId },
      });
    }

    // Anything reaching here is a bug. Log everything, tell the user nothing.
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: ErrorCode.INTERNAL_ERROR, message: ERROR_MESSAGES.INTERNAL_ERROR, requestId },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: ErrorCode.NOT_FOUND, message: ERROR_MESSAGES.NOT_FOUND, requestId: request.id },
    });
  });
}
