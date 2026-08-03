import { describe, expect, test } from 'bun:test';
import { createCrtActivityRegistry } from '../src/lib/client/crt-activity.js';
import { bitcrushTerminalSamples } from '../src/lib/client/crt-terminal.js';

describe('CRT activity registry', () => {
  test('keeps concurrent AI work active until the last token is released', () => {
    const snapshots: Array<{ counts: Record<string, number>; total: number }> = [];
    const registry = createCrtActivityRegistry((snapshot: { counts: Record<string, number>; total: number }) =>
      snapshots.push(snapshot),
    );
    const stopFirst = registry.begin('ai');
    const stopSecond = registry.begin('ai');
    expect(registry.snapshot()).toEqual({ counts: { ai: 2 }, total: 2 });
    stopFirst();
    expect(registry.snapshot()).toEqual({ counts: { ai: 1 }, total: 1 });
    stopFirst();
    expect(registry.snapshot()).toEqual({ counts: { ai: 1 }, total: 1 });
    stopSecond();
    expect(registry.snapshot()).toEqual({ counts: {}, total: 0 });
    expect(snapshots.at(-1)).toEqual({ counts: {}, total: 0 });
  });
});

describe('terminal sound synthesis', () => {
  test('quantizes and sample-holds filtered terminal tones', () => {
    const source = Float32Array.from({ length: 32 }, (_, index) => Math.sin(index * 0.37) * 0.83);
    const processed = bitcrushTerminalSamples(source, 22_050, 8, 16_000);
    expect(processed).toHaveLength(source.length);
    expect([...processed]).not.toEqual([...source]);
    expect(processed.some((sample, index) => index > 0 && sample === processed[index - 1])).toBe(true);
    expect(processed.every((sample) => Math.abs(sample * 128 - Math.round(sample * 128)) < 0.000001)).toBe(true);
  });
});
