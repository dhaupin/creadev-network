import { describe, it, expect } from 'vitest';
import { isDomainAllowed, isOnline } from '../src/index';

describe('network utilities', () => {
  it('isDomainAllowed exists', () => {
    expect(typeof isDomainAllowed).toBe('function');
  });
  it('isOnline exists', () => {
    expect(typeof isOnline).toBe('function');
  });
});
