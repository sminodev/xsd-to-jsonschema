import type { Element } from '@xmldom/xmldom';
import type { JsonSchema, JsonType } from './json-schema.js';
import type { At, Problems } from './problems.js';
import { attr, type QName, type SchemaSet, XS, xsChild, xsChildren } from './schema-set.js';
import { combinePatterns, translateBody, XsdRegexError } from './xsd-regex.js';

// Lexical forms of XML Schema (Part 2, 3.2), written as XML Schema patterns and translated like any other pattern.
const TZ = '(Z|(\\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00))?';
const YEAR = '-?([1-9][0-9]{3,}|0[0-9]{3})';
const MONTH = '(0[1-9]|1[0-2])';
const DAY = '(0[1-9]|[12][0-9]|3[01])';
const TIME = '(([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?|(24:00:00(\\.0+)?))';
const NCNAME = '[\\i-[:]][\\c-[:]]*';
const LEXICAL: Record<string, string> = {
  date: `${YEAR}-${MONTH}-${DAY}${TZ}`,
  dateTime: `${YEAR}-${MONTH}-${DAY}T${TIME}${TZ}`,
  time: `${TIME}${TZ}`,
  duration:
    '-?P(([0-9]+Y)?([0-9]+M)?([0-9]+D)?(T(([0-9]+H)([0-9]+M)?([0-9]+(\\.[0-9]+)?S)?|([0-9]+M)([0-9]+(\\.[0-9]+)?S)?|([0-9]+(\\.[0-9]+)?S)))?)',
  gYear: `${YEAR}${TZ}`,
  gYearMonth: `${YEAR}-${MONTH}${TZ}`,
  gMonth: `--${MONTH}${TZ}`,
  gMonthDay: `--${MONTH}-${DAY}${TZ}`,
  gDay: `---${DAY}${TZ}`,
  language: '[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*',
  Name: '\\i\\c*',
  NCName: NCNAME,
  ID: NCNAME,
  IDREF: NCNAME,
  ENTITY: NCNAME,
  NMTOKEN: '\\c+',
  hexBinary: '([0-9a-fA-F]{2})*',
  QName: `(${NCNAME}:)?${NCNAME}`,
};
const FORMATS: Record<string, string> = { date: 'date', dateTime: 'date-time', time: 'time', duration: 'duration' };

const INTEGERS: Record<string, { minimum?: number; maximum?: number }> = {
  integer: {},
  nonPositiveInteger: { maximum: 0 },
  negativeInteger: { maximum: -1 },
  nonNegativeInteger: { minimum: 0 },
  positiveInteger: { minimum: 1 },
  long: {},
  int: { minimum: -2147483648, maximum: 2147483647 },
  short: { minimum: -32768, maximum: 32767 },
  byte: { minimum: -128, maximum: 127 },
  unsignedLong: { minimum: 0 },
  unsignedInt: { minimum: 0, maximum: 4294967295 },
  unsignedShort: { minimum: 0, maximum: 65535 },
  unsignedByte: { minimum: 0, maximum: 255 },
};
const STRINGS = ['string', 'normalizedString', 'token', 'anyURI', 'NOTATION'];
const LISTS = ['NMTOKENS', 'IDREFS', 'ENTITIES'];

export interface SimpleTypeOptions {
  dateTime: 'format' | 'pattern';
}

/** The JSON type a built-in XML Schema type maps to; undefined for anySimpleType and anyType. */
export function jsonTypeOf(builtin: string): JsonType | undefined {
  if (builtin === 'boolean') {
    return 'boolean';
  }
  if (INTEGERS[builtin]) {
    return 'integer';
  }
  if (builtin === 'decimal' || builtin === 'float' || builtin === 'double') {
    return 'number';
  }
  if (builtin === 'anySimpleType' || builtin === 'anyType') {
    return undefined;
  }
  return 'string';
}

export function isKnownBuiltin(local: string): boolean {
  return (
    ['anySimpleType', 'anyType', 'boolean', 'decimal', 'float', 'double', 'base64Binary'].includes(local) ||
    INTEGERS[local] !== undefined ||
    STRINGS.includes(local) ||
    LISTS.includes(local) ||
    LEXICAL[local] !== undefined
  );
}

/** Converts a lexical value of XML Schema to its JSON value. */
export function lexicalToJson(jsonType: JsonType | undefined, lexical: string): { value: unknown } | { error: string } {
  const text = lexical.trim();
  if (jsonType === 'integer' || jsonType === 'number') {
    if (!/^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(text)) {
      return { error: `${lexical} is no number` };
    }
    const value = Number(text);
    if (jsonType === 'integer' && !Number.isInteger(value)) {
      return { error: `${lexical} is no integer` };
    }
    return { value };
  }
  if (jsonType === 'boolean') {
    if (text === 'true' || text === '1') {
      return { value: true };
    }
    if (text === 'false' || text === '0') {
      return { value: false };
    }
    return { error: `${lexical} is no boolean` };
  }
  return { value: lexical };
}

/** A simple type given by name or as an anonymous xs:simpleType element. */
export type SimpleTypeRef = QName | Element;

const isElement = (type: SimpleTypeRef): type is Element => 'nodeType' in type;

/** The derivation of a simple type down to its built-in type, with the facets of each restriction step. */
interface Derivation {
  /** local name of the built-in type at the bottom of the chain */
  builtin: string;
  variety: 'atomic' | 'list' | 'union';
  /** restriction steps, base first */
  steps: { node: Element; facets: Element[] }[];
  /** a named type that is not defined, and the node that names it */
  missing?: { name: QName; from: Element | undefined };
}

/** Facets whose value counts something, with the smallest value they allow. */
const COUNTING_FACETS: Record<string, number> = {
  length: 0,
  minLength: 0,
  maxLength: 0,
  fractionDigits: 0,
  totalDigits: 1,
};

interface Bound {
  value: number;
  exclusive: boolean;
}

export class SimpleTypes {
  constructor(
    private readonly set: SchemaSet,
    private readonly problems: Problems,
    private readonly options: SimpleTypeOptions,
  ) {}

  private at(node: Element | undefined): At | undefined {
    return node && { file: this.set.pathOf(node), node };
  }

  /**
   * Follows a simple type down to its built-in type.
   *
   * @param from - the node that names the type, where problems with the name are reported
   */
  derive(type: SimpleTypeRef, from?: Element, seen = new Set<Element>()): Derivation {
    if (!isElement(type)) {
      if (type.ns === XS) {
        if (!isKnownBuiltin(type.local)) {
          this.problems.error('unknown-type', `xs:${type.local} is no built-in type`, this.at(from));
          return { builtin: 'string', variety: 'atomic', steps: [] };
        }
        return { builtin: type.local, variety: 'atomic', steps: [] };
      }
      const found = this.set.lookup('simpleType', type);
      if (!found) {
        return { builtin: 'anySimpleType', variety: 'atomic', steps: [], missing: { name: type, from } };
      }
      type = found.node;
    }
    if (seen.has(type)) {
      this.problems.error('circular-type', 'circular simple type derivation', this.at(type));
      return { builtin: 'string', variety: 'atomic', steps: [] };
    }
    seen.add(type);
    const restriction = xsChild(type, 'restriction');
    if (restriction) {
      const base = attr(restriction, 'base');
      const inner = xsChild(restriction, 'simpleType');
      const derivation: Derivation =
        base !== undefined
          ? this.derive(this.set.resolveQName(restriction, base), restriction, seen)
          : inner
            ? this.derive(inner, restriction, seen)
            : { builtin: 'anySimpleType', variety: 'atomic', steps: [] };
      const facets = xsChildren(restriction).filter((child) => child.localName !== 'simpleType');
      return { ...derivation, steps: [...derivation.steps, { node: restriction, facets }] };
    }
    if (xsChild(type, 'list')) {
      return { builtin: 'string', variety: 'list', steps: [] };
    }
    if (xsChild(type, 'union')) {
      return { builtin: 'string', variety: 'union', steps: [] };
    }
    return { builtin: 'anySimpleType', variety: 'atomic', steps: [] };
  }

  /** The JSON type of a simple type, used to convert fixed and default values. */
  jsonType(type: SimpleTypeRef, from?: Element): JsonType | undefined {
    const derivation = this.derive(type, from);
    if (derivation.variety !== 'atomic') {
      return 'string';
    }
    const integerOnly = derivation.steps.some((step) =>
      step.facets.some((f) => f.localName === 'fractionDigits' && Number(attr(f, 'value')) === 0),
    );
    const json = jsonTypeOf(derivation.builtin);
    return json === 'number' && integerOnly ? 'integer' : json;
  }

  /** JSON Schema of a built-in type. */
  builtinSchema(local: string): JsonSchema {
    const json = jsonTypeOf(local);
    const schema: JsonSchema = json === undefined ? {} : { type: json };
    const bounds = INTEGERS[local];
    if (bounds) {
      Object.assign(schema, bounds);
    }
    if (local === 'base64Binary') {
      schema.contentEncoding = 'base64';
    }
    const format = FORMATS[local];
    const lexical = LEXICAL[local];
    if (format !== undefined && this.options.dateTime === 'format') {
      schema.format = format;
    } else if (lexical !== undefined) {
      schema.pattern = combinePatterns([[translateBody(lexical)]]);
    }
    if (LISTS.includes(local)) {
      schema.pattern = combinePatterns([[translateBody('\\c+( \\c+)*')]]);
    }
    return schema;
  }

  /**
   * JSON Schema of a simple type: the built-in type with the facets of all restriction steps merged.
   *
   * @param from - the node that names the type, where problems with the name are reported
   */
  schema(type: SimpleTypeRef, from?: Element): JsonSchema {
    const derivation = this.derive(type, from);
    const at = isElement(type) ? this.at(type) : undefined;
    if (derivation.missing) {
      const { name, from: namedAt } = derivation.missing;
      this.problems.error('unknown-type', `simple type {${name.ns}}${name.local} is not defined`, this.at(namedAt));
      return {};
    }
    if (derivation.variety === 'list') {
      this.problems.error(
        'unsupported-list',
        'xs:list is written as a string of space-separated items without item checks',
        at,
      );
      return { type: 'string' };
    }
    if (derivation.variety === 'union') {
      this.problems.error('unsupported-union', 'xs:union accepts any string here', at);
      return { type: 'string' };
    }
    const schema = this.builtinSchema(derivation.builtin);
    const json = schema.type;
    const patternSteps: string[][] = [];
    const lexical = LEXICAL[derivation.builtin];
    if (lexical !== undefined && schema.pattern) {
      patternSteps.push([translateBody(lexical)]);
    }
    let enumeration: string[] | undefined;
    let enumAt: Element | undefined;
    let fractionDigits: number | undefined;
    let totalDigits: number | undefined;
    const lower: Bound[] = [];
    const upper: Bound[] = [];
    if (schema.minimum !== undefined) {
      lower.push({ value: schema.minimum, exclusive: false });
    }
    if (schema.maximum !== undefined) {
      upper.push({ value: schema.maximum, exclusive: false });
    }
    for (const step of derivation.steps) {
      const patterns: string[] = [];
      const values: string[] = [];
      for (const facet of step.facets) {
        const value = attr(facet, 'value') ?? '';
        const facetAt = this.at(facet);
        const least = COUNTING_FACETS[facet.localName ?? ''];
        if (least !== undefined && !(/^\s*\+?[0-9]+\s*$/.test(value) && Number(value) >= least)) {
          const expected = least === 0 ? 'a non-negative integer' : 'a positive integer';
          this.problems.error('invalid-facet', `${facet.localName} needs ${expected}, not "${value}"`, facetAt);
          continue;
        }
        switch (facet.localName) {
          case 'enumeration':
            values.push(value);
            break;
          case 'pattern':
            try {
              patterns.push(translateBody(value));
            } catch (e) {
              if (!(e instanceof XsdRegexError)) {
                throw e;
              }
              this.problems.error('untranslatable-pattern', e.message, facetAt);
            }
            break;
          case 'length':
            schema.minLength = Math.max(schema.minLength || 0, Number(value));
            schema.maxLength = Math.min(schema.maxLength ?? Infinity, Number(value));
            break;
          case 'minLength':
            schema.minLength = Math.max(schema.minLength || 0, Number(value));
            break;
          case 'maxLength':
            schema.maxLength = Math.min(schema.maxLength ?? Infinity, Number(value));
            break;
          case 'minInclusive':
          case 'minExclusive':
          case 'maxInclusive':
          case 'maxExclusive': {
            if (json !== 'integer' && json !== 'number') {
              this.problems.warning(
                'unsupported-bound',
                `${facet.localName} on xs:${derivation.builtin} has no JSON Schema keyword`,
                facetAt,
              );
              break;
            }
            const bound = lexicalToJson('number', value);
            if ('error' in bound) {
              this.problems.error('invalid-facet', bound.error, facetAt);
              break;
            }
            const exclusive = facet.localName.endsWith('Exclusive');
            (facet.localName.startsWith('min') ? lower : upper).push({ value: bound.value as number, exclusive });
            break;
          }
          case 'fractionDigits':
            fractionDigits = Math.min(fractionDigits ?? Infinity, Number(value));
            break;
          case 'totalDigits':
            totalDigits = Math.min(totalDigits ?? Infinity, Number(value));
            break;
          case 'whiteSpace':
            // Normalizes the XML text; JSON values have no surrounding markup.
            break;
          case 'assertion':
          case 'explicitTimezone':
            this.problems.error('unsupported-facet', `xs:${facet.localName} is not supported`, facetAt);
            break;
          default:
            this.problems.error('unsupported-facet', `unknown facet xs:${facet.localName}`, facetAt);
        }
      }
      if (patterns.length > 0) {
        patternSteps.push(patterns);
      }
      if (values.length > 0) {
        enumeration = values;
        enumAt = step.node;
      }
    }

    if (json === 'number' || json === 'integer') {
      if (fractionDigits === 0) {
        schema.type = 'integer';
      } else if (fractionDigits !== undefined && json === 'number') {
        schema.multipleOf = Number(`1e-${fractionDigits}`);
      }
      if (totalDigits !== undefined) {
        const limit = Number(`1e${totalDigits}`);
        lower.push({ value: -limit, exclusive: true });
        upper.push({ value: limit, exclusive: true });
        if (schema.type !== 'integer') {
          this.problems.warning(
            'approximated-total-digits',
            `totalDigits ${totalDigits} is checked as a bound only (|value| < ${limit}); the number of digits is not`,
            at,
          );
        }
      }
      delete schema.minimum;
      delete schema.maximum;
      const low = tightest(lower, true);
      const high = tightest(upper, false);
      if (low) {
        schema[low.exclusive ? 'exclusiveMinimum' : 'minimum'] = low.value;
      }
      if (high) {
        schema[high.exclusive ? 'exclusiveMaximum' : 'maximum'] = high.value;
      }
    }
    if (schema.maxLength === Infinity) {
      delete schema.maxLength;
    }
    if (schema.minLength === 0) {
      delete schema.minLength;
    }
    if (patternSteps.length > 0) {
      if (json === 'string') {
        schema.pattern = combinePatterns(patternSteps);
      } else if (enumeration === undefined) {
        delete schema.pattern;
        this.problems.warning(
          'lexical-pattern',
          `a pattern on xs:${derivation.builtin} restricts the XML text; JSON ${json} values are not checked against it`,
          at,
        );
      }
    }

    if (enumeration !== undefined && enumAt !== undefined) {
      return this.enumSchema(schema, enumeration, enumAt);
    }
    return schema;
  }

  // An enumeration next to other facets: values that break a facet can never occur, so they are left out and the
  // facets dropped. The result accepts the same values.
  private enumSchema(schema: JsonSchema, values: string[], at: Element): JsonSchema {
    const json = schema.type;
    const pattern = schema.pattern ? new RegExp(schema.pattern, 'u') : undefined;
    const kept: unknown[] = [];
    for (const lexical of values) {
      const converted = lexicalToJson(json, lexical);
      if ('error' in converted) {
        this.problems.error('invalid-facet', converted.error, this.at(at));
        continue;
      }
      const value = converted.value;
      const reason = violation(schema, pattern, value);
      if (reason) {
        this.problems.warning(
          'unreachable-enumeration',
          `enumeration value ${lexical} is left out: ${reason}`,
          this.at(at),
        );
        continue;
      }
      if (!kept.some((k) => k === value)) {
        kept.push(value);
      }
    }
    const out: JsonSchema = {};
    if (json !== undefined) {
      out.type = json;
    }
    if (schema.format !== undefined) {
      out.format = schema.format;
    }
    out.enum = kept;
    return out;
  }
}

function tightest(bounds: Bound[], isLower: boolean): Bound | undefined {
  let best: Bound | undefined;
  for (const bound of bounds) {
    if (
      best === undefined ||
      (isLower ? bound.value > best.value : bound.value < best.value) ||
      (bound.value === best.value && bound.exclusive)
    ) {
      best = bound;
    }
  }
  return best;
}

function violation(schema: JsonSchema, pattern: RegExp | undefined, value: unknown): string | undefined {
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      return `shorter than ${schema.minLength}`;
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      return `longer than ${schema.maxLength}`;
    }
    if (pattern && !pattern.test(value)) {
      return `does not match ${schema.pattern}`;
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `below ${schema.minimum}`;
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      return `not above ${schema.exclusiveMinimum}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `above ${schema.maximum}`;
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      return `not below ${schema.exclusiveMaximum}`;
    }
    if (schema.multipleOf !== undefined && !Number.isInteger(Number((value / schema.multipleOf).toFixed(9)))) {
      return 'more than the allowed fraction digits';
    }
  }
  return undefined;
}
