import { describe, expect, it } from 'vitest';
import { WorkspaceHandleSchema, workspaceHandleFromEmail } from './index.js';

describe('workspaceHandleFromEmail', () => {
  it('uses the email local part verbatim when valid', () => {
    expect(workspaceHandleFromEmail('sami001@example.com')).toBe('sami001');
    expect(workspaceHandleFromEmail('cert@example.com')).toBe('cert');
  });
  it('lowercases and collapses separators', () => {
    expect(workspaceHandleFromEmail('Sam.I.Saba+test@x.com')).toBe('sam-i-saba-test');
  });
  it('drops the domain and cleans invalid characters', () => {
    expect(workspaceHandleFromEmail('alice--bob_2026@x.org')).toBe('alice-bob-2026');
    expect(workspaceHandleFromEmail('-lead-@x.com')).toBe('lead');
  });
  it('caps at 32 characters', () => {
    const long = `${'a'.repeat(45)}@x.com`;
    expect(workspaceHandleFromEmail(long).length).toBeLessThanOrEqual(32);
  });
  it('falls back for degenerate inputs', () => {
    const handle = workspaceHandleFromEmail('@x.com');
    expect(handle).toMatch(/^[a-z0-9-]{3,32}$/);
  });
});

describe('WorkspaceHandleSchema', () => {
  it('accepts valid handles', () => {
    for (const value of ['sami001', 'cert', 'alice-bob-2026', 'a-1']) {
      expect(WorkspaceHandleSchema.parse(value)).toBe(value.toLowerCase());
    }
  });
  it('rejects invalid handles', () => {
    for (const value of ['-lead', 'trailing-', 'a!b', 'ab', 'a'.repeat(33), 'a--b']) {
      expect(() => WorkspaceHandleSchema.parse(value)).toThrow();
    }
  });
  it('normalizes case and whitespace', () => {
    expect(WorkspaceHandleSchema.parse('  Sami001  ')).toBe('sami001');
    expect(WorkspaceHandleSchema.parse('UPPER')).toBe('upper');
  });
});
