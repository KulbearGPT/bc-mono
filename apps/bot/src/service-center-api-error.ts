export class BotApiError extends Error {
  public readonly code: string;
  public readonly requestId: string;
  public readonly statusCode: number;
  public readonly details: unknown;

  public constructor(input: {
    code: string;
    message: string;
    requestId: string;
    statusCode: number;
    details?: unknown;
  }) {
    super(input.message);
    this.name = 'BotApiError';
    this.code = input.code;
    this.requestId = input.requestId;
    this.statusCode = input.statusCode;
    this.details = input.details;
  }
}
