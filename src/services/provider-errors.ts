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

export class ProviderRequestError extends Error {
  override readonly name = "ProviderRequestError";

  constructor(
    message: string,
    readonly provider: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type FailedModelResult = Omit<ModelResult<unknown>, "value">;

export class ModelOutputError extends Error {
  override readonly name = "ModelOutputError";

  constructor(
    message: string,
    readonly provider: string,
    readonly model: string,
    readonly result: FailedModelResult,
  ) {
    super(message);
  }
}
import type { ModelResult } from "../types/worker.js";
