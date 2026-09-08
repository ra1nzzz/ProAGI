import { hashCanonical } from '../domain/canonical';
import type { Hash } from '../domain/types';

export const M2_READONLY_PURPOSE = 'insight.readonly.test-results';
export const M2_RISK_VERSION = 'local-first-risk-v1';
export const M2_ALLOWED_FIELDS = Object.freeze([
  'sourceItemKey', 'occurredAt', 'kind', 'subject.appId', 'subject.projectKey',
  'attributes.appId', 'attributes.projectKey', 'attributes.commandClass', 'attributes.testOutcome',
  'attributes.exitCode', 'attributes.durationMs', 'attributes.fileExt', 'attributes.operation',
]);

export interface RetentionPolicy {
  readonly id: string;
  readonly sourceKind: 'readonly-adapter';
  readonly eventTtlDays: number;
  readonly derivedTtlDays: number;
  readonly policyVersion: 'retention-readonly-v1';
}

export interface ConsentGrant {
  readonly id: string;
  readonly source: {
    readonly kind: 'readonly-adapter';
    readonly sourceItemKey: string;
    readonly adapterId: string;
    readonly adapterVersion: string;
  };
  readonly allowedFields: readonly string[];
  readonly purpose: typeof M2_READONLY_PURPOSE;
  readonly retentionPolicyId: string;
  readonly policyVersion: string;
  readonly grantedAt: string;
  readonly riskAccepted: true;
  readonly riskVersion: typeof M2_RISK_VERSION;
  readonly contentHash: Hash;
}

export interface ConsentRevocation {
  readonly id: string;
  readonly consentId: string;
  readonly revokedAt: string;
  readonly reason: 'user' | 'policy' | 'expiry';
  readonly privacyEpochAfter: number;
  readonly contentHash: Hash;
}

export interface ReadonlyConsentSnapshot {
  readonly grant: ConsentGrant;
  readonly policy: RetentionPolicy;
  readonly revoked: boolean;
  readonly revocation?: ConsentRevocation;
}

export function makeRetentionPolicy(id: string, eventTtlDays = 7, derivedTtlDays = 30): RetentionPolicy {
  if (!Number.isInteger(eventTtlDays) || eventTtlDays < 1 || eventTtlDays > 7 || !Number.isInteger(derivedTtlDays) || derivedTtlDays < 1 || derivedTtlDays > 30) throw new Error('ERR_RETENTION_RANGE');
  return Object.freeze({ id, sourceKind: 'readonly-adapter', eventTtlDays, derivedTtlDays, policyVersion: 'retention-readonly-v1' });
}

export function makeConsentGrant(input: {
  readonly id: string;
  readonly sourceItemKey: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly retentionPolicyId: string;
  readonly grantedAt: string;
}): ConsentGrant {
  const base = {
    id: input.id,
    source: { kind: 'readonly-adapter' as const, sourceItemKey: input.sourceItemKey, adapterId: input.adapterId, adapterVersion: input.adapterVersion },
    allowedFields: [...M2_ALLOWED_FIELDS],
    purpose: M2_READONLY_PURPOSE as typeof M2_READONLY_PURPOSE,
    retentionPolicyId: input.retentionPolicyId,
    policyVersion: 'consent-readonly-v1' as const,
    grantedAt: input.grantedAt,
    riskAccepted: true as const,
    riskVersion: M2_RISK_VERSION as typeof M2_RISK_VERSION,
  };
  return Object.freeze({ ...base, contentHash: hashCanonical(base) });
}

export function makeConsentRevocation(input: Omit<ConsentRevocation, 'contentHash'>): ConsentRevocation {
  return Object.freeze({ ...input, contentHash: hashCanonical(input) });
}

export function isConsentActive(snapshot: ReadonlyConsentSnapshot, purpose = M2_READONLY_PURPOSE): boolean {
  return !snapshot.revoked && snapshot.grant.purpose === purpose && snapshot.grant.riskAccepted === true;
}
