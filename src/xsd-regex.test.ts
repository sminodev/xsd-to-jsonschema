import { describe, expect, it } from 'vitest';
import { combinePatterns, translateBody, XsdRegexError } from './xsd-regex.js';

const anchored = (xsd: string) => new RegExp(combinePatterns([[translateBody(xsd)]]), 'u');

describe('XML Schema patterns', () => {
  it('match the whole value', () => {
    expect(anchored('ab').test('ab')).toBe(true);
    expect(anchored('ab').test('xab')).toBe(false);
    expect(anchored('a|b').test('a')).toBe(true);
    expect(anchored('a|b').test('ab')).toBe(false);
  });

  it('treat ^ and $ as characters', () => {
    expect(anchored('^a$').test('^a$')).toBe(true);
    expect(anchored('^a$').test('a')).toBe(false);
    expect(anchored('[$^]').test('$')).toBe(true);
  });

  it('write \\- outside a class as a hyphen, as the u flag requires', () => {
    expect(translateBody('2\\d{3}\\-[1-4]')).toBe('2\\p{Nd}{3}-[1-4]');
    expect(anchored('2\\d{3}\\-[1-4]').test('2026-3')).toBe(true);
    expect(anchored('[a\\-z]').test('-')).toBe(true);
    expect(anchored('[a\\-z]').test('b')).toBe(false);
  });

  it('give \\i and \\c the name characters of XML 1.0, Second Edition', () => {
    const start = anchored('\\i');
    const char = anchored('\\c');
    for (const c of ['a', 'Z', '_', ':', 'é', 'ω', 'я', '中']) {
      expect(start.test(c), c).toBe(true);
    }
    // Digits, combining marks and extenders follow a name start; ARABIC-INDIC DIGIT ONE is one of them.
    for (const c of ['1', '-', '.', '\u0661', '\u0301', '\u00B7']) {
      expect([start.test(c), char.test(c)], c).toEqual([false, true]);
    }
    // Later editions added titlecase letters, letter numbers and characters beyond the BMP.
    for (const c of ['\u01C5', '\u216B', '\u{10000}', '\u2070', '\uFDF0']) {
      expect([start.test(c), char.test(c)], c).toEqual([false, false]);
    }
  });

  it('give the multi-character escapes their XML Schema meaning', () => {
    expect(anchored('\\d').test('٣')).toBe(true); // ARABIC-INDIC DIGIT THREE is \p{Nd}
    expect(anchored('\\s').test('\u00a0')).toBe(false); // \s is only space, tab, CR and LF
    expect(anchored('\\w').test('é')).toBe(true);
    expect(anchored('\\w').test('-')).toBe(false);
    expect(anchored('\\i\\c*').test('_a.b-1')).toBe(true);
    expect(anchored('\\i\\c*').test('1a')).toBe(false);
    expect(anchored('[\\d\\S]').test('x')).toBe(true);
    expect(anchored('.').test('\n')).toBe(false);
    expect(anchored('.').test('\u2028')).toBe(true);
  });

  it('turn class subtraction into a lookahead', () => {
    expect(anchored('[a-z-[aeiou]]+').test('bcd')).toBe(true);
    expect(anchored('[a-z-[aeiou]]+').test('bad')).toBe(false);
  });

  it('keep category escapes and reject block escapes', () => {
    expect(anchored('\\p{Lu}\\P{Lu}').test('Ab')).toBe(true);
    expect(() => translateBody('\\p{IsBasicLatin}')).toThrow(XsdRegexError);
    expect(() => translateBody('\\p{IsBasicLatin}')).toThrow(/block escape/);
    expect(() => translateBody('\\q')).toThrow(/unknown escape/);
    expect(() => translateBody('(?:a)')).toThrow(XsdRegexError);
  });

  it('combine patterns: alternatives within a step, all steps together', () => {
    const re = new RegExp(
      combinePatterns([[translateBody('[A-Z]{2}'), translateBody('\\d{3}')], [translateBody('A.|9..')]]),
      'u',
    );
    expect(['AB', '912'].every((v) => re.test(v))).toBe(true);
    expect(['BA', '9X', 'A1'].some((v) => re.test(v))).toBe(false);
    expect(() => combinePatterns([])).toThrow(RangeError);
  });
});
