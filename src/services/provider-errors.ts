export class RetryableProviderError extends Error {
  override readonly name = "RetryableProviderError";

  constructor(
    message: string,
    readonly provider: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

export class ProviderConfigurationError extends Error {
  override readonly name = "ProviderConfigurationError";

  constructor(
    message: string,
    readonly provider: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

