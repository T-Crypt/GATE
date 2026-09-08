export class AppError extends Error {
  constructor(code, message, { status = 400, details = undefined } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function notFound(resource, id) {
  return new AppError('NOT_FOUND', `${resource} ${id} was not found`, { status: 404 });
}

export function validation(message, details) {
  return new AppError('VALIDATION_FAILED', message, { status: 422, details });
}
