import { RootAttestationService, RootAttestationStore } from '@mpx/sessions';
import {
  AccountApplicationService,
  type AccountAttestationServicePort,
  type AccountAuthVerifier,
  type AccountConfiguration,
} from '../account-application-service.js';
import { createPiAuthAvailabilityProbe, type TrustedExecutable } from './pi-auth-availability.js';

export interface NodeAccountApplicationDependencies {
  readonly accounts: Readonly<Record<string, AccountConfiguration>>;
  readonly stateRoot: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly rootAttestationService?: RootAttestationService;
  readonly accountAuthVerifier?: AccountAuthVerifier;
  readonly resolveTrustedExecutable: () => Promise<TrustedExecutable>;
}

function attestationPort(service: RootAttestationService): AccountAttestationServicePort {
  return {
    list: () => service.store.list(),
    verify: (identity, root, ref) => service.verify(identity, root, ref),
  };
}

/** Composes the Node-backed account registry and bounded Pi authentication probe once. */
export function createNodeAccountApplicationService(
  dependencies: NodeAccountApplicationDependencies,
): AccountApplicationService {
  const service =
    dependencies.rootAttestationService ??
    new RootAttestationService(new RootAttestationStore(dependencies.stateRoot));
  const auth =
    dependencies.accountAuthVerifier ??
    createPiAuthAvailabilityProbe({
      cwd: dependencies.cwd,
      environment: dependencies.environment,
      resolveTrustedExecutable: dependencies.resolveTrustedExecutable,
    });
  return new AccountApplicationService({
    accounts: dependencies.accounts,
    attestation: attestationPort(service),
    auth,
  });
}
