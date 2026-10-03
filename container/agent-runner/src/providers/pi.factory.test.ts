import { describe, expect, it } from 'bun:test';

import { createProvider } from './factory.js';
import { PiProvider } from './pi.js';
import './index.js';

describe('createProvider (pi)', () => {
  it('returns PiProvider for pi through the real registration barrel', () => {
    expect(createProvider('pi')).toBeInstanceOf(PiProvider);
  });
});
