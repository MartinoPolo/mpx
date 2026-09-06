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
export interface AccountAttestationServicePort {
  list(): Promise<readonly AccountAttestationRecord[]>;
  verify(identity: AccountIdentity, root: string, ref?: string): Promise<AccountAttestationRecord>;
}
export interface AccountAuthVerifier {
  verify(root: string): Promise<void>;
}
export type NativeAccountBindingVerification =
  'verified' | 'unavailable' | 'mismatch' | 'duplicate';
export interface AccountApplicationDependencies {
  readonly accounts: Readonly<Record<string, AccountConfiguration>>;
  readonly attestation: AccountAttestationServicePort;
  readonly auth: AccountAuthVerifier;
}

/** Native account binding resolution and verification used by launch and session resume. */
export class AccountApplicationService {
  constructor(readonly dependencies: AccountApplicationDependencies) {}

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
}
