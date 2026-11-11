import type { JsonSchema } from './json-schema.js';

// The lexical forms of one value (XML Schema Part 2, 2.3): enumeration and fixed compare values, not text. For the
// types whose JSON value is a string although several spellings mean the same value, this writes all spellings of a
// value as an ECMAScript pattern.

const TIME_ZONED = ['dateTime', 'time', 'date', 'gYearMonth', 'gYear', 'gMonthDay', 'gDay', 'gMonth'];
const INTEGER_TYPES = [
  'integer',
  'nonPositiveInteger',
  'negativeInteger',
  'long',
  'int',
  'short',
  'byte',
  'nonNegativeInteger',
  'unsignedLong',
  'unsignedInt',
  'unsignedShort',
  'unsignedByte',
  'positiveInteger',
];

/** Escapes text for an ECMAScript pattern with the `u` flag, which allows escapes of syntax characters only. */
export function escapePattern(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** Whether the spellings of a value of this built-in type can't be listed: a float or double. */
export function hasUnlistedForms(builtin: string): boolean {
  return builtin === 'float' || builtin === 'double';
}

/**
 * The pattern body (without anchors) that matches every spelling of the value of `text`, a normalized lexical form
 * of the built-in type `builtin`; undefined if every value has one spelling, as for strings.
 *
 * - dates and times: the time zone Z also as +00:00 and -00:00, and fractional seconds with or without trailing
 *   zeros; another time zone offset of the same instant is not listed
 * - hexBinary: either case of each digit
 * - boolean, decimal and integer types (as union members, whose values are strings): every spelling of the number
 */
export function equalForms(builtin: string, text: string): string | undefined {
  if (TIME_ZONED.includes(builtin)) {
    return timeForms(builtin, text);
  }
  if (builtin === 'hexBinary') {
    return /[a-fA-F]/.test(text)
      ? text.replace(/[a-fA-F]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)
      : undefined;
  }
  if (builtin === 'boolean') {
    return text === 'true' || text === '1'
      ? '(?:true|1)'
      : text === 'false' || text === '0'
        ? '(?:false|0)'
        : undefined;
  }
  if (builtin === 'decimal' || INTEGER_TYPES.includes(builtin)) {
    return numberForms(text, INTEGER_TYPES.includes(builtin));
  }
  return undefined;
}

function timeForms(builtin: string, text: string): string | undefined {
  const zone = /(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(text)?.[1];
  let body = zone === undefined ? text : text.slice(0, -zone.length);
  let fraction = '';
  if (builtin === 'dateTime' || builtin === 'time') {
    const match = /\.([0-9]+)$/.exec(body);
    if (match) {
      body = body.slice(0, match.index);
      fraction = (match[1] ?? '').replace(/0+$/, '');
    }
    fraction = fraction === '' ? '(?:\\.0+)?' : `\\.${fraction}0*`;
  }
  const utc = zone !== undefined && ['Z', '+00:00', '-00:00'].includes(zone);
  if (!utc && fraction === '') {
    return undefined;
  }
  const zones = zone === undefined ? '' : utc ? '(?:Z|[+\\-]00:00)' : escapePattern(zone);
  return `${escapePattern(body)}${fraction}${zones}`;
}

function numberForms(text: string, integer: boolean): string | undefined {
  const match = /^([+-]?)([0-9]*)(?:\.([0-9]*))?$/.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    return undefined;
  }
  const whole = (match[2] ?? '').replace(/^0+/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  if (whole === '' && fraction === '') {
    return integer ? '[+\\-]?0+' : '[+\\-]?(?:0+(?:\\.0*)?|\\.0+)';
  }
  const sign = match[1] === '-' ? '-' : '\\+?';
  if (integer && fraction !== '') {
    return undefined;
  }
  if (integer) {
    return `${sign}0*${whole}`;
  }
  return `${sign}0*${whole}${fraction === '' ? '(?:\\.0*)?' : `\\.${fraction}0*`}`;
}

/**
 * The JSON numbers that are the same xs:float as `value`: an xs:float is a 32-bit float (XML Schema Part 2, 3.2.4),
 * so every double that rounds to the same float is equal to it. The range ends halfway to the next floats; a number
 * right on an end rounds to the float with the even last bit, so the ends belong to the range when that is this one.
 */
export function float32Range(value: number): JsonSchema {
  const float = Math.fround(value);
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, float);
  const bits = view.getUint32(0);
  const at = (next: number): number => {
    view.setUint32(0, next >>> 0);
    return view.getFloat32(0);
  };
  const largest = 0x7f7fffff;
  const tiny = 2 ** -149;
  let up: number;
  let down: number;
  if (float === 0) {
    up = tiny;
    down = -tiny;
  } else if (float > 0) {
    up = bits === largest ? 2 ** 128 : at(bits + 1);
    down = at(bits - 1);
  } else {
    up = at(bits - 1);
    down = (bits & 0x7fffffff) === largest ? -(2 ** 128) : at(bits + 1);
  }
  const low = (down + float) / 2;
  const high = (float + up) / 2;
  return (bits & 1) === 0
    ? { type: 'number', minimum: low, maximum: high }
    : { type: 'number', exclusiveMinimum: low, exclusiveMaximum: high };
}
