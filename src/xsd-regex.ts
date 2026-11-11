// Translates regular expressions of XML Schema 1.0 (Part 2, Appendix F) into JavaScript patterns for the `u` flag,
// the dialect of JSON Schema 2020-12.
//
// What differs between the two:
// - An XML Schema pattern matches the whole value, so the result is anchored with ^(?:...)$.
// - ^ and $ are ordinary characters in XML Schema.
// - . excludes only \n and \r; \d is \p{Nd}; \s is [ \t\n\r]; \w is [^\p{P}\p{Z}\p{C}]; \i and \c are the XML name
//   characters of XML 1.0, Second Edition, which XML Schema 1.0 refers to (name-chars.ts).
// - \- outside a class is a plain hyphen (an identity escape the `u` flag rejects).
// - Class subtraction [a-z-[aeiou]] becomes a negative lookahead.
// Block escapes (\p{IsBasicLatin}) have no JavaScript equivalent and are reported as untranslatable.

import { NAME_CHAR, NAME_START } from './name-chars.js';

export class XsdRegexError extends Error {
  override name = 'XsdRegexError';
}

const SPACE = ' \\t\\n\\r';
const NOT_WORD = '\\p{P}\\p{Z}\\p{C}';

/** A multi-character escape: class content, either as it is (`positive`) or negated (`negative`). */
type Multi = { positive: string } | { negative: string };

const MULTI: Record<string, Multi> = {
  d: { positive: '\\p{Nd}' },
  D: { positive: '\\P{Nd}' },
  s: { positive: SPACE },
  S: { negative: SPACE },
  i: { positive: NAME_START },
  I: { negative: NAME_START },
  c: { positive: NAME_CHAR },
  C: { negative: NAME_CHAR },
  w: { negative: NOT_WORD },
  W: { positive: NOT_WORD },
};

const SINGLE: Record<string, string> = { n: '\\n', r: '\\r', t: '\\t' };
// XML Schema 1.0 has no \$; libxml2 and others accept it as an escaped $.
const SYNTAX = new Set(['\\', '|', '.', '?', '*', '+', '(', ')', '{', '}', '-', '[', ']', '^', '$']);
const CATEGORIES = new Set([
  'L',
  'Lu',
  'Ll',
  'Lt',
  'Lm',
  'Lo',
  'M',
  'Mn',
  'Mc',
  'Me',
  'N',
  'Nd',
  'Nl',
  'No',
  'P',
  'Pc',
  'Pd',
  'Ps',
  'Pe',
  'Pi',
  'Pf',
  'Po',
  'Z',
  'Zs',
  'Zl',
  'Zp',
  'S',
  'Sm',
  'Sc',
  'Sk',
  'So',
  'C',
  'Cc',
  'Cf',
  'Co',
  'Cn',
]);

/** One escape: a single character (`char`), a category (`set`) or a multi-character escape (`multi`). */
type Escape = { char: string; literal?: string } | { set: string } | { multi: Multi };

function multiAlone(m: Multi): string {
  if ('positive' in m) {
    return /^\\[pP]\{\w+\}$/.test(m.positive) ? m.positive : `[${m.positive}]`;
  }
  return `[^${m.negative}]`;
}

/**
 * Translates the body of one XML Schema pattern, without anchors.
 *
 * @param source - the value of an xs:pattern facet
 * @throws {XsdRegexError} if the pattern cannot be translated
 */
export function translateBody(source: string): string {
  let i = 0;
  const fail = (message: string): never => {
    throw new XsdRegexError(`${message} at position ${i} of /${source}/`);
  };

  const readCategory = (letter: string): string => {
    if (source[i] !== '{') {
      fail(`\\${letter} needs {name}`);
    }
    const end = source.indexOf('}', i);
    if (end < 0) {
      fail('unterminated category escape');
    }
    const name = source.slice(i + 1, end);
    i = end + 1;
    if (CATEGORIES.has(name)) {
      return `\\${letter}{${name}}`;
    }
    if (name.startsWith('Is')) {
      fail(`block escape \\${letter}{${name}} has no JavaScript equivalent`);
    }
    return fail(`unknown category \\${letter}{${name}}`);
  };

  // Reads one escape; `i` points behind the backslash.
  const readEscape = (): Escape => {
    const c = source[i];
    i += 1;
    if (c === undefined) {
      return fail('pattern ends with a backslash');
    }
    const single = SINGLE[c];
    if (single !== undefined) {
      return { char: single };
    }
    if (SYNTAX.has(c)) {
      return { char: '\\' + c, literal: c };
    }
    const multi = MULTI[c];
    if (multi !== undefined) {
      return { multi };
    }
    if (c === 'p' || c === 'P') {
      return { set: readCategory(c) };
    }
    return fail(`unknown escape \\${c}`);
  };

  const readClassChar = (): Escape => {
    const c = source[i];
    if (c === '\\') {
      i += 1;
      return readEscape();
    }
    if (c === '[') {
      fail('unescaped [ inside a character class');
    }
    const ch = String.fromCodePoint(source.codePointAt(i) ?? 0);
    i += ch.length;
    return { char: c === '-' || c === '^' || c === ']' ? '\\' + c : ch };
  };

  const readClass = (): string => {
    i += 1; // [
    let negated = false;
    if (source[i] === '^') {
      negated = true;
      i += 1;
    }
    const positives: string[] = [];
    const negatives: string[] = [];
    let subtraction: string | undefined;
    let first = true;
    for (;;) {
      const c = source[i];
      if (c === undefined) {
        fail('unterminated character class');
      }
      if (c === ']' && !first) {
        i += 1;
        break;
      }
      if (c === '-' && source[i + 1] === '[' && !first) {
        i += 1;
        subtraction = readClass();
        if (source[i] !== ']') {
          fail('a class subtraction must end the class');
        }
        i += 1;
        break;
      }
      first = false;
      const start = readClassChar();
      if ('char' in start && source[i] === '-' && source[i + 1] !== ']' && source[i + 1] !== '[') {
        i += 1;
        const end = readClassChar();
        if (!('char' in end)) {
          fail('a range must end with a single character');
        } else {
          positives.push(`${start.char}-${end.char}`);
        }
      } else if ('char' in start) {
        positives.push(start.char);
      } else if ('set' in start) {
        positives.push(start.set);
      } else if ('positive' in start.multi) {
        positives.push(start.multi.positive);
      } else {
        negatives.push(start.multi.negative);
      }
    }
    let unit: string;
    if (negated) {
      if (negatives.length > 0) {
        fail('a negated class with \\S, \\I, \\C or \\w');
      }
      unit = `[^${positives.join('')}]`;
    } else {
      const parts: string[] = [];
      if (positives.length > 0) {
        parts.push(`[${positives.join('')}]`);
      }
      for (const negative of negatives) {
        parts.push(`[^${negative}]`);
      }
      unit = parts.length === 1 ? (parts[0] as string) : `(?:${parts.join('|')})`;
    }
    return subtraction === undefined ? unit : `(?:(?!${subtraction})${unit})`;
  };

  let out = '';
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 1;
      const escape = readEscape();
      if ('char' in escape) {
        out += escape.literal === '-' ? '-' : escape.char;
      } else if ('set' in escape) {
        out += escape.set;
      } else {
        out += multiAlone(escape.multi);
      }
    } else if (c === '[') {
      out += readClass();
    } else if (c === '.') {
      out += '[^\\n\\r]';
      i += 1;
    } else if (c === '^' || c === '$') {
      out += '\\' + c;
      i += 1;
    } else if (c === '(') {
      if (source[i + 1] === '?') {
        fail('(? is not XML Schema syntax');
      }
      out += '(?:';
      i += 1;
    } else {
      const ch = String.fromCodePoint(source.codePointAt(i) ?? 0);
      out += ch;
      i += ch.length;
    }
  }
  try {
    new RegExp(out, 'u');
  } catch (e) {
    if (!(e instanceof SyntaxError)) {
      throw e;
    }
    throw new XsdRegexError(`/${source}/ is no valid regular expression after translation: ${e.message}`);
  }
  return out;
}

/**
 * Combines the patterns of a derivation chain into one anchored pattern. The patterns of one restriction step are
 * alternatives; all steps apply (XML Schema Part 2, 4.3.4.3).
 *
 * @param steps - translated bodies, one array per restriction step, base first
 */
export function combinePatterns(steps: readonly (readonly string[])[]): string {
  const alternatives = steps.map((step) => (step.length === 1 ? step[0] : step.map((b) => `(?:${b})`).join('|')));
  const last = alternatives.at(-1);
  if (last === undefined) {
    throw new RangeError('combinePatterns needs at least one step');
  }
  const lookaheads = alternatives
    .slice(0, -1)
    .map((a) => `(?=(?:${a})$)`)
    .join('');
  return `^${lookaheads}(?:${last})$`;
}
