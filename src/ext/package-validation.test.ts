import { describe, expect, it } from 'vitest';

import { assertSafePackages } from './package-validation.js';

describe('assertSafePackages (SEC-M8)', () => {
  it('accepts ordinary apt and npm names, scoped and versioned', () => {
    expect(() =>
      assertSafePackages(
        ['ffmpeg', 'libssl3', 'g++', 'python3.11'],
        ['lodash', '@scope/pkg', 'typescript@5.6.2', 'react@^18'],
      ),
    ).not.toThrow();
  });

  it.each([
    ['apt', ['curl; rm -rf /'], []],
    ['apt', ['$(id)'], []],
    ['apt', ['-oAPT::Update::Pre-Invoke::=x'], []],
    ['npm', [], ['left-pad && curl evil']],
    ['npm', [], ['`id`']],
    ['npm', [], ['../../etc']],
  ])('refuses a %s name that could reach the shell: %j %j', (_kind, apt, npm) => {
    expect(() => assertSafePackages(apt as string[], npm as string[])).toThrow(/package name rejected/);
  });
});
