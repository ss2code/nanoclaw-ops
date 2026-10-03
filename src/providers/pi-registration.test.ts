import { describe, expect, it } from 'vitest';

import './index.js';
import { getProviderContainerConfig, listProviderContainerConfigNames } from './provider-container-registry.js';

describe('Pi host registration', () => {
  it('registers through the real host provider barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('pi');
    expect(getProviderContainerConfig('pi')).toBeTypeOf('function');
  });
});
