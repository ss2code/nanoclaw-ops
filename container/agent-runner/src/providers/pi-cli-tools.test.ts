import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Pi CLI image pin', () => {
  it('installs the exact stable Pi release without build-script opt-in', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '../../../cli-tools.json'), 'utf8')) as Array<{
      name: string;
      version: string;
      onlyBuilt?: boolean;
    }>;
    expect(manifest.find((tool) => tool.name === '@earendil-works/pi-coding-agent')).toEqual({
      name: '@earendil-works/pi-coding-agent',
      version: '0.87.0',
    });
  });
});
