import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Consistent error envelope:
 *   { success: false, message: string, errors?: Record<string,string> }
 * Validation errors (from class-validator) are flattened to field -> message.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: Record<string, string> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse() as
        | string
        | { message?: string | string[]; error?: string };

      if (typeof res === 'string') {
        message = res;
      } else if (Array.isArray(res.message)) {
        // class-validator produces an array of messages like "field must be ..."
        message = 'Validation failed';
        errors = {};
        for (const m of res.message) {
          const field = m.split(' ')[0];
          if (!errors[field]) errors[field] = m;
        }
      } else if (res.message) {
        message = res.message as string;
      }
    } else {
      this.logger.error(exception);
    }

    response.status(status).json({ success: false, message, errors });
  }
}
