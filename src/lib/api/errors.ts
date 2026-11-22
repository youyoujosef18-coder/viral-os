export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new ApiError(404, `${what} not found`, "not_found");
export const badRequest = (msg: string, details?: unknown) => new ApiError(400, msg, "bad_request", details);
export const conflict = (msg: string) => new ApiError(409, msg, "conflict");

/** Thrown when a feature needs an integration that is not configured. */
export class NotConfiguredError extends ApiError {
  constructor(integration: string, setup: string) {
    super(503, `${integration} is not configured. ${setup}`, "not_configured", { integration });
  }
}
