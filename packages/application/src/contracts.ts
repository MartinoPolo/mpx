export interface ApplicationOperationResult<T> {
  readonly data: T;
  readonly exitCode?: number;
}
