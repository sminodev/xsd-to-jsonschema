import { describe, expect, it } from 'vitest';
import { isMultipleOf } from './decimal.js';

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
