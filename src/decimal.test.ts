import { describe, expect, it } from 'vitest';
import { isExact, isMultipleOf } from './decimal.js';
import { float32Range } from './value-forms.js';

describe('exact decimals', () => {
  it.each([
    ['0.1', 0.1, true],
    ['-1.50', -1.5, true],
    ['123456789012345', 123456789012345, true],
    ['9007199254740991', 9007199254740991, true],
    ['9007199254740992', 9007199254740992, false],
    ['12032691129748584', 12032691129748584, false],
    ['-850796917225226100', -850796917225226100, false],
    ['-67428259604688900', -67428259604688900, false],
    ['1e20', 1e20, false],
    ['1234567890.123456', 1234567890.123456, false],
    ['0.1000000000000000055511151231257827', 0.1, false],
  ])('%s as %s: %s', (text, value, expected) => {
    expect(isExact(text, value)).toBe(expected);
  });
});

describe('decimal multiples', () => {
  it.each([
    [1.12, 0.01, true],
    [10.1, 0.1, true],
    [-1.12, 0.01, true],
    [1, 0.00001, true],
    [9999999999.99, 0.01, true],
    [0, 0.01, true],
    [1.125, 0.01, false],
    [1.1200000000000003, 0.01, false],
    [1e21, 0.01, true],
    [1e-300, 1e-301, true],
    [Number.POSITIVE_INFINITY, 0.01, false],
    [Number.NaN, 0.01, false],
    [1, 0, false],
    [1, -0.01, false],
    [1, Number.POSITIVE_INFINITY, false],
  ])('checks %s against a step of %s', (value, step, expected) => {
    expect(isMultipleOf(value, step)).toBe(expected);
  });
});

describe('the range of doubles that are one xs:float', () => {
  const inside = (range: ReturnType<typeof float32Range>, v: number) =>
    (range.minimum === undefined || v >= range.minimum) &&
    (range.exclusiveMinimum === undefined || v > range.exclusiveMinimum) &&
    (range.maximum === undefined || v <= range.maximum) &&
    (range.exclusiveMaximum === undefined || v < range.exclusiveMaximum);
  it.each([0.1, 3, -2.5, 0, 1e-45, 3.4028234663852886e38, -1e30, 16777217])(
    'holds exactly the doubles that round to %s',
    (v) => {
      const range = float32Range(v);
      const f = Math.fround(v);
      for (const probe of [f, v, f * (1 + 1e-9), f * (1 - 1e-9), f + 1e-46, f - 1e-46]) {
        expect(inside(range, probe), String(probe)).toBe(Math.fround(probe) === f);
      }
      for (const end of [range.minimum, range.maximum, range.exclusiveMinimum, range.exclusiveMaximum]) {
        if (end !== undefined && Number.isFinite(end)) {
          expect(inside(range, end), `end ${end}`).toBe(Math.fround(end) === f);
        }
      }
    },
  );
});
