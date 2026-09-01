import { MpxError } from '@mpx/core';

export interface AccountIdentity {
  readonly domain: string;
  readonly name: string;
}
export interface AccountConfiguration {
  readonly domain: string;
  readonly runtimeRoots: { readonly pi: string };
}
export interface AccountAttestationRecord {
  readonly schemaVersion: 1;
  readonly ref: string;
  readonly identity: AccountIdentity;
  readonly runtime: 'pi';
  readonly rootDigest: string;
  readonly mode: 'root-attested';
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface AccountAttestationPlan {
  readonly schemaVersion: 1;
  readonly operation: 'enroll' | 're-enroll';
  readonly identity: AccountIdentity;
  readonly runtime: 'pi';
  readonly rootDigest: string;
  readonly mode: 'root-attested';
  readonly stateDigest: string;
  readonly confirmationDigest: string;
}
export interface AccountAttestationServicePort {
  list(): Promise<readonly AccountAttestationRecord[]>;
  find(identity: AccountIdentity): Promise<AccountAttestationRecord | undefined>;
  verify(identity: AccountIdentity, root: string, ref?: string): Promise<AccountAttestationRecord>;
  plan(
    operation: 'enroll' | 're-enroll',
    identity: AccountIdentity,
    root: string,
  ): Promise<AccountAttestationPlan>;
  confirm(plan: AccountAttestationPlan): Promise<AccountAttestationRecord>;
}
export interface AccountAuthVerifier {
  verify(root: string): Promise<void>;
}
export type AccountAction = 'enroll' | 're-enroll' | 'list' | 'status' | 'verify';
export interface AccountCommandRequest {
  readonly action: AccountAction;
  readonly identityName?: string;
  readonly confirmationDigest?: string;
}
export type NativeAccountBindingVerification =
  'verified' | 'unavailable' | 'mismatch' | 'duplicate';
export interface AccountApplicationDependencies {
  readonly accounts: Readonly<Record<string, AccountConfiguration>>;
  readonly attestation: AccountAttestationServicePort;
  readonly auth: AccountAuthVerifier;
}

function accountError(code: string, message: string): MpxError {
  return new MpxError({ code, message, retryable: false });
}
function publicRecord(
  record: Pick<AccountAttestationRecord, 'identity' | 'runtime' | 'mode'>,
  status: string,
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    identity: record.identity,
    runtime: record.runtime,
    mode: record.mode,
    status,
  });
}

export class AccountApplicationService {
  constructor(readonly dependencies: AccountApplicationDependencies) {}

  async execute(input: AccountCommandRequest): Promise<Record<string, unknown>> {
    if (input.action === 'list') {
      if (input.identityName !== undefined || input.confirmationDigest !== undefined) {
        throw accountError(
          'ACCOUNT_USAGE_INVALID',
          'Account list accepts no identity or confirmation options.',
        );
      }
      await this.dependencies.attestation.list();
      const accounts = await Promise.all(
        Object.keys(this.dependencies.accounts)
          .sort()
          .map(async (name) => {
            const configured = this.dependencies.accounts[name]!;
            const identity = { domain: configured.domain, name };
            return publicRecord(
              { identity, runtime: 'pi', mode: 'root-attested' },
              await this.configuredStatus(identity, configured.runtimeRoots.pi),
            );
          }),
      );
      return { schemaVersion: 1, accounts };
    }

    const { identity, root } = this.configuredIdentity(input.identityName);
    if (input.action === 'status') {
      if (input.confirmationDigest !== undefined) {
        throw accountError('ACCOUNT_USAGE_INVALID', 'Account status does not accept confirmation.');
      }
      return publicRecord(
        { identity, runtime: 'pi', mode: 'root-attested' },
        await this.configuredStatus(identity, root),
      );
    }
    if (input.action === 'verify') {
      if (input.confirmationDigest !== undefined) {
        throw accountError('ACCOUNT_USAGE_INVALID', 'Account verify does not accept confirmation.');
      }
      const record = await this.dependencies.attestation.verify(identity, root);
      await this.dependencies.auth.verify(root);
      return publicRecord(record, 'verified');
    }

    const plan = await this.dependencies.attestation.plan(input.action, identity, root);
    if (input.confirmationDigest === undefined) {
      return {
        schemaVersion: 1,
        operation: input.action,
        identity,
        runtime: 'pi',
        mode: 'root-attested',
        confirmationDigest: plan.confirmationDigest,
        status: 'planned',
        proves: 'configured-root-and-registry-state',
        liveAuth: 'deferred-until-confirmation',
      };
    }
    if (input.confirmationDigest !== plan.confirmationDigest) {
      throw accountError(
        'ACCOUNT_PLAN_STALE',
        'The account enrollment confirmation is stale or invalid.',
      );
    }
    await this.dependencies.auth.verify(root);
    const rechecked = await this.dependencies.attestation.plan(input.action, identity, root);
    if (rechecked.confirmationDigest !== input.confirmationDigest) {
      throw accountError('ACCOUNT_PLAN_STALE', 'The account enrollment confirmation became stale.');
    }
    const record = await this.dependencies.attestation.confirm(rechecked);
    return {
      schemaVersion: 1,
      operation: input.action,
      identity: record.identity,
      runtime: 'pi',
      mode: 'root-attested',
      status: input.action === 'enroll' ? 'enrolled' : 're-enrolled',
    };
  }

  async resolveNativeBinding(
    identity: AccountIdentity,
    runtime: 'claude' | 'pi',
    root: string,
  ): Promise<string | null> {
    return runtime === 'claude'
      ? null
      : (await this.dependencies.attestation.verify(identity, root)).ref;
  }

  async verifyNativeBinding(ref: string): Promise<NativeAccountBindingVerification> {
    try {
      const matches = (await this.dependencies.attestation.list()).filter(
        (record) => record.ref === ref,
      );
      if (matches.length > 1) {
        return 'duplicate';
      }
      const record = matches[0];
      if (!record) {
        return 'unavailable';
      }
      const configured = this.dependencies.accounts[record.identity.name];
      if (!configured || configured.domain !== record.identity.domain) {
        return 'mismatch';
      }
      await this.dependencies.attestation.verify(record.identity, configured.runtimeRoots.pi, ref);
      await this.dependencies.auth.verify(configured.runtimeRoots.pi);
      return 'verified';
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return code === 'ACCOUNT_ROOT_CHANGED' || code === 'ACCOUNT_BINDING_MISMATCH'
        ? 'mismatch'
        : 'unavailable';
    }
  }

  private configuredIdentity(name: string | undefined): {
    identity: AccountIdentity;
    root: string;
  } {
    if (!name) {
      throw accountError('IDENTITY_REQUIRED', 'Account commands require --identity NAME.');
    }
    const configured = this.dependencies.accounts[name];
    if (!configured) {
      throw accountError('IDENTITY_UNKNOWN', `Unknown identity '${name}'.`);
    }
    return { identity: { domain: configured.domain, name }, root: configured.runtimeRoots.pi };
  }

  private async configuredStatus(
    identity: AccountIdentity,
    root: string,
  ): Promise<'missing' | 'enrolled' | 'root-changed'> {
    const record = await this.dependencies.attestation.find(identity);
    if (!record) {
      return 'missing';
    }
    try {
      await this.dependencies.attestation.verify(identity, root);
      return 'enrolled';
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ACCOUNT_ROOT_CHANGED' || code === 'ACCOUNT_ROOT_INVALID') {
        return 'root-changed';
      }
      throw error;
    }
  }
}
