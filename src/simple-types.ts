import type { Element } from '@xmldom/xmldom';
import type { JsonSchema, JsonType } from './json-schema.js';
import { applyNumericFacets, type NumericFacets } from './numeric-facets.js';
import type { At, Problems } from './problems.js';
import { attr, type QName, type SchemaSet, XS, xsChild, xsChildren } from './schema-set.js';
import { enumSchema, lexicalToJson } from './simple-values.js';
import { combinePatterns, translateBody, XsdRegexError } from './xsd-regex.js';

export { lexicalToJson } from './simple-values.js';

// Lexical forms of XML Schema (Part 2, 3.2), written as XML Schema patterns and translated like any other pattern.
const TZ = '(Z|(\\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00))?';
// Four digits or more, without leading zeros beyond four digits; XML Schema 1.0 has no year 0000.
const YEAR = '-?([1-9][0-9]{3,}|0[0-9]{2}[1-9]|0[0-9][1-9][0-9]|0[1-9][0-9]{2})';
// Years divisible by 4, except centuries that are not divisible by 400.
const LEAP_YEAR =
  '-?([1-9][0-9]*([0-9]{2}(0[48]|[2468][048]|[13579][26])|([02468][048]|[13579][26])00)' +
  '|[0-9]{2}(0[48]|[2468][048]|[13579][26])|(0[48]|[2468][048]|[13579][26])00)';
const MONTH = '(0[1-9]|1[0-2])';
const DAY = '(0[1-9]|[12][0-9]|3[01])';
// The days each month has, apart from 29 February.
const MONTH_DAY =
  '((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-8]))';
const DATE = `(${YEAR}-${MONTH_DAY}|${LEAP_YEAR}-02-29)`;
const TIME = '(([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?|(24:00:00(\\.0+)?))';
// A duration has at least one part; seconds may be written as `1.5`, `1.` or `.5`.
const SECONDS = '([0-9]+(\\.[0-9]*)?|\\.[0-9]+)S';
const DURATION_TIME = `T([0-9]+H([0-9]+M)?(${SECONDS})?|[0-9]+M(${SECONDS})?|${SECONDS})`;
const DURATION =
  `-?P([0-9]+Y([0-9]+M)?([0-9]+D)?(${DURATION_TIME})?|[0-9]+M([0-9]+D)?(${DURATION_TIME})?` +
  `|[0-9]+D(${DURATION_TIME})?|${DURATION_TIME})`;
const NCNAME = '[\\i-[:]][\\c-[:]]*';
const LEXICAL: Record<string, string> = {
  date: `${DATE}${TZ}`,
  dateTime: `${DATE}T${TIME}${TZ}`,
  time: `${TIME}${TZ}`,
  duration: DURATION,
  gYear: `${YEAR}${TZ}`,
  gYearMonth: `${YEAR}-${MONTH}${TZ}`,
  gMonth: `--${MONTH}${TZ}`,
  gMonthDay: `--(${MONTH_DAY}|02-29)${TZ}`,
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
  /** the xs:union element and its member types, for a union */
  union?: { node: Element; members: SimpleTypeRef[] };
}

/** Facets whose value counts something, with the smallest value they allow. */
const COUNTING_FACETS: Record<string, number> = {
  length: 0,
  minLength: 0,
  maxLength: 0,
  fractionDigits: 0,
  totalDigits: 1,
};

export class SimpleTypes {
  /** the unions whose members are being written, to stop a union that contains itself */
  private readonly openUnions = new Set<Element>();

  constructor(
    private readonly set: SchemaSet,
    private readonly problems: Problems,
    private readonly options: SimpleTypeOptions,
  ) {}

  private at(node: Element | undefined): At | undefined {
    return node && this.set.at(node);
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
    const union = xsChild(type, 'union');
    if (union) {
      const named = (attr(union, 'memberTypes') ?? '')
        .split(/\s+/)
        .filter((qname) => qname.length > 0)
        .map((qname) => this.set.resolveQName(union, qname));
      const members: SimpleTypeRef[] = [...named, ...xsChildren(union).filter((c) => c.localName === 'simpleType')];
      return { builtin: 'string', variety: 'union', steps: [], union: { node: union, members } };
    }
    return { builtin: 'anySimpleType', variety: 'atomic', steps: [] };
  }

  /** The JSON type of a simple type, used to convert fixed and default values. */
  jsonType(type: SimpleTypeRef, from?: Element): JsonType | undefined {
    const derivation = this.derive(type, from);
    if (derivation.union) {
      const { node, members } = derivation.union;
      if (this.openUnions.has(node)) {
        return 'string';
      }
      this.openUnions.add(node);
      const json = sharedJsonType(members.map((member) => this.jsonType(member, node)));
      this.openUnions.delete(node);
      return json ?? 'string';
    }
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
    if (derivation.union) {
      return this.unionSchema(derivation, derivation.union, at);
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
    const numeric: NumericFacets = { lower: [], upper: [] };
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
          case 'minLength':
          case 'maxLength': {
            // The length of binary data counts octets, that of a list its items.
            if (derivation.builtin === 'base64Binary' || LISTS.includes(derivation.builtin)) {
              const unit = LISTS.includes(derivation.builtin) ? 'items' : 'octets';
              this.problems.warning(
                'unsupported-length',
                `${facet.localName} on xs:${derivation.builtin} counts ${unit}, not characters; it is left out`,
                facetAt,
              );
              break;
            }
            const characters = Number(value) * (derivation.builtin === 'hexBinary' ? 2 : 1);
            if (facet.localName !== 'maxLength') {
              schema.minLength = Math.max(schema.minLength || 0, characters);
            }
            if (facet.localName !== 'minLength') {
              schema.maxLength = Math.min(schema.maxLength ?? Infinity, characters);
            }
            break;
          }
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
            (facet.localName.startsWith('min') ? numeric.lower : numeric.upper).push({
              value: bound.value as number,
              exclusive,
            });
            break;
          }
          case 'fractionDigits':
            numeric.fractionDigits = Math.min(numeric.fractionDigits ?? Infinity, Number(value));
            break;
          case 'totalDigits':
            numeric.totalDigits = Math.min(numeric.totalDigits ?? Infinity, Number(value));
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

    applyNumericFacets(schema, numeric, this.problems, at);
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
      return enumSchema(schema, enumeration, this.problems, this.at(enumAt));
    }
    return schema;
  }

  /**
   * An xs:union gets the JSON type its members share and becomes an `anyOf` of the member types. Patterns and
   * enumerations of restrictions on the union apply to the whole value. If the members have different JSON types,
   * the value is a string and is checked as a string only.
   */
  private unionSchema(derivation: Derivation, union: NonNullable<Derivation['union']>, at: At | undefined): JsonSchema {
    if (this.openUnions.has(union.node)) {
      this.problems.error('circular-type', 'a union that contains itself', this.at(union.node));
      return { type: 'string' };
    }
    this.openUnions.add(union.node);
    const members = union.members.map((member) => this.schema(member, union.node));
    this.openUnions.delete(union.node);
    const json = sharedJsonType(members.map((m) => m.type));
    const schema: JsonSchema = { type: json ?? 'string' };
    // A member without facets of that very type accepts every value, and so does the union then.
    const acceptsAll = (m: JsonSchema) =>
      (m.type ?? 'string') === schema.type && Object.keys(m).every((k) => k === 'type' || k === 'description');
    if (json === undefined) {
      this.problems.warning(
        'unsupported-union',
        'xs:union whose members have different JSON types: the value is checked as a string only',
        at,
      );
    } else if (members.length > 0 && !members.some(acceptsAll)) {
      schema.anyOf = members.map((member) => {
        const copy: JsonSchema = { ...member };
        delete copy.description;
        return copy;
      });
    }
    const patternSteps: string[][] = [];
    let enumeration: { values: string[]; at: Element } | undefined;
    for (const step of derivation.steps) {
      const patterns: string[] = [];
      const values: string[] = [];
      for (const facet of step.facets) {
        if (facet.localName === 'pattern') {
          try {
            patterns.push(translateBody(attr(facet, 'value') ?? ''));
          } catch (e) {
            if (!(e instanceof XsdRegexError)) {
              throw e;
            }
            this.problems.error('untranslatable-pattern', e.message, this.at(facet));
          }
        } else if (facet.localName === 'enumeration') {
          values.push(attr(facet, 'value') ?? '');
        } else if (facet.localName !== 'whiteSpace') {
          this.problems.error('unsupported-facet', `xs:${facet.localName} on a union is not supported`, this.at(facet));
        }
      }
      if (patterns.length > 0) {
        patternSteps.push(patterns);
      }
      if (values.length > 0) {
        enumeration = { values, at: step.node };
      }
    }
    if (patternSteps.length > 0 && schema.type === 'string') {
      schema.pattern = combinePatterns(patternSteps);
    } else if (patternSteps.length > 0 && enumeration === undefined) {
      this.problems.warning(
        'lexical-pattern',
        `a pattern on a union of ${schema.type ?? ''} types restricts the XML text; JSON values are not checked against it`,
        at,
      );
    }
    return enumeration ? enumSchema(schema, enumeration.values, this.problems, this.at(enumeration.at)) : schema;
  }
}

/** The JSON type all members of a union share, with integer and number counted as number; undefined if they differ. */
function sharedJsonType(types: (JsonType | undefined)[]): JsonType | undefined {
  const distinct = new Set(types.map((type) => type ?? 'string'));
  if (distinct.size === 1) {
    return [...distinct][0];
  }
  return [...distinct].every((type) => type === 'integer' || type === 'number') ? 'number' : undefined;
}
