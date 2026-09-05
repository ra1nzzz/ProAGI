import { describe, expect, it } from 'vitest';
import { canonicalJson, semanticId, sha256 } from '../../src/domain/canonical';

describe('canonical JSON and hash', () => {
  it('orders keys, normalizes strings and omits undefined', () => {
    expect(canonicalJson({ z: undefined, b: 'e\u0301  \r\n', a: -0 })).toBe('{"a":0,"b":"é\\n"}');
  });

  it('rejects object keys that collide after NFC normalization', () => {
    expect(() => canonicalJson({ 'é': 1, 'e\u0301': 2 })).toThrow('ERR_CANONICALIZATION');
  });

  it('emits deterministic RFC 4122 version-5 semantic UUIDs', () => {
    const id = semanticId('claim-v1', { b: 2, a: 1 });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).toBe(semanticId('claim-v1', { a: 1, b: 2 }));
  });

  it('implements SHA-256 rather than a placeholder hash', () => {
    expect(sha256('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
