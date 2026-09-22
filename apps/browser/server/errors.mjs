/** Deliberately public errors; internal exceptions are never returned verbatim. */
export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message)
    this.status = status
    this.code = code
  }
}
export function requireValue(condition, status, message, code) {
  if (!condition) throw new HttpError(status, message, code)
}
export function publicError(error) {
  if (error instanceof HttpError)
    return { status: error.status, error: error.message, code: error.code }
  const known = {
    ENOENT: [404, 'The file or folder no longer exists.'],
    EEXIST: [409, 'A file or folder with that name already exists.'],
    EACCES: [403, 'Windows denied access. Check this folder’s permissions.'],
    EPERM: [403, 'The file is locked or this operation is not permitted.'],
    EBUSY: [409, 'The file is in use. Close the other application and try again.'],
    ENOSPC: [507, 'There is not enough free disk space.'],
    ENOTDIR: [400, 'The requested parent is not a directory.'],
  }[error?.code]
  if (known) return { status: known[0], error: known[1], code: error.code }
  return {
    status: 500,
    error: 'The operation failed. See the Nawa server console.',
    code: 'INTERNAL_ERROR',
  }
}
