import { describe, expect, it } from 'vitest';

import { containerBuildCard } from '../ui.js';
import { readImageBuildManifest } from './container-build.js';

describe('Ops Center container build manifest', () => {
  it('surfaces the exact Pi CLI pin installed into the shared image', () => {
    const manifest = readImageBuildManifest();

    expect(manifest.bakedTools).toContainEqual({ name: 'pi', version: '0.87.0' });
    expect(
      containerBuildCard(manifest, undefined, {
        settingsPath: '',
        exists: false,
        preToolUse: [],
        rtkActive: false,
      }),
    ).toContain('<td>pi</td>');
    expect(
      containerBuildCard(manifest, undefined, {
        settingsPath: '',
        exists: false,
        preToolUse: [],
        rtkActive: false,
      }),
    ).toContain('0.87.0');
  });
});
