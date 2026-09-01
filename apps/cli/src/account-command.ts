import type { AccountApplicationService, AccountCommandRequest } from '@mpx/application';

/** CLI grammar adapter; account policy and sequencing live in the application package. */
export function executeAccountCommand(
  input: AccountCommandRequest,
  service: Pick<AccountApplicationService, 'execute'>,
): Promise<Record<string, unknown>> {
  return service.execute(input);
}
