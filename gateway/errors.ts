export class GatewayError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'GatewayError';
  }
}

export const configurationError = (name: string) =>
  new GatewayError(503, 'configuration_error', `Missing or invalid configuration: ${name}`);
