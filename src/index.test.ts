import { describe, it, expect } from 'vitest';
import { network, online, fetch, sse } from '../src/index';

describe('network', () => {
  it('is defined', () => { expect(network).toBeDefined(); });
  it('has fetch', () => { expect(network.fetch).toBeDefined(); });
});

describe('online', () => {
  it('is defined', () => { expect(online).toBeDefined(); });
});
