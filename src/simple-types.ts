import type { Element } from '@xmldom/xmldom';
import type { JsonSchema, JsonType } from './json-schema.js';
import { applyNumericFacets, type NumericFacets } from './numeric-facets.js';
import { type At, Problems } from './problems.js';
import { attr, type QName, type SchemaSet, XS, xsChild, xsChildren } from './schema-set.js';
import { enumSchema, lexicalToJson, primaryType, violation } from './simple-values.js';
import { equalForms, escapePattern, hasUnlistedForms } from './value-forms.js';
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
// base64Binary (Part 2, 3.2.16): quartets of the base64 alphabet, the last one padded with `=`; the character before
// the padding may only use the bits the decoded octets fill. Single spaces may separate the characters, as collapse
// leaves them. Each full quartet but the last may end with a space, so the value never ends with one.
const B64 = '[A-Za-z0-9+/]';
const B64S = `${B64} ?`;
const BASE64 = `((${B64S}){4})*(${B64S}${B64S}${B64S}${B64}|${B64S}${B64S}[AEIMQUYcgkosw048] ?=|${B64S}[AQgw] ?= ?=)`;
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
  base64Binary: `(${BASE64})?`,
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
/** The built-in types whose pattern consists of XML name characters. */
const NAME_TYPES = ['Name', 'NCName', 'ID', 'IDREF', 'ENTITY', 'NMTOKEN', 'QName'];
/** The values of xs:float and xs:double that JSON numbers can't hold, written as strings. */
const SPECIAL_VALUES = ['INF', '-INF', 'NaN'];

/**
 * Which of INF, -INF and NaN, and whether numbers, the bounds of an xs:float or xs:double allow (XML Schema Part 2,
 * 3.2.4, 3.2.5): an inclusive NaN bound allows exactly NaN, an exclusive one nothing, and every other bound rules NaN
 * out; a finite minimum rules out -INF, a finite maximum INF; a bound of INF or -INF limits the numbers.
 */
class SpecialValues {
  numbers = true;
  private values = new Set(SPECIAL_VALUES);

  get allowed(): string[] {
    return SPECIAL_VALUES.filter((value) => this.values.has(value));
  }

  /** Takes a bound into account; true if its value is INF, -INF or NaN and needs no numeric keyword. */
  bound(value: string, lower: boolean, exclusive: boolean): boolean {
    const keep = (...values: string[]) => {
      this.values = new Set([...this.values].filter((v) => values.includes(v)));
    };
    if (value === 'NaN') {
      this.numbers = false;
      keep(...(exclusive ? [] : ['NaN']));
      return true;
    }
    this.values.delete('NaN');
    const far = lower ? '-INF' : 'INF';
    const near = lower ? 'INF' : '-INF';
    if (value === far) {
      if (exclusive) {
        this.values.delete(far);
      }
      return true;
    }
    if (value === near) {
      // min INF or max -INF: only that value, if inclusive; nothing else.
      this.numbers = false;
      keep(...(exclusive ? [] : [near]));
      return true;
    }
    this.values.delete(far);
    return false;
  }

  /** Keeps the values the patterns of the type accept. */
  match(pattern: RegExp): void {
    this.values = new Set([...this.values].filter((value) => pattern.test(value)));
  }
}

/** The built-in list types and their item types; they need at least one item. */
const LIST_ITEMS: Record<string, string> = { NMTOKENS: 'NMTOKEN', IDREFS: 'IDREF', ENTITIES: 'ENTITY' };
const LISTS = Object.keys(LIST_ITEMS);

// The lexical forms of the types that become JSON numbers and booleans, for a union that checks its members as text.
const SIGNED = '[+\\-]?[0-9]+';
const UNSIGNED = '\\+?[0-9]+|-0+';
const DECIMAL = '[+\\-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)';
const FLOAT = `(${DECIMAL})([Ee][+\\-]?[0-9]+)?|-?INF|NaN`;
const TEXT_FORMS: Record<string, string> = {
  boolean: 'true|false|1|0',
  decimal: DECIMAL,
  float: FLOAT,
  double: FLOAT,
  integer: SIGNED,
  long: SIGNED,
  nonNegativeInteger: UNSIGNED,
  unsignedLong: UNSIGNED,
  positiveInteger: '\\+?0*[1-9][0-9]*',
  nonPositiveInteger: '-[0-9]+|\\+?0+',
  negativeInteger: '-0*[1-9][0-9]*',
};
// Integer types whose range the text form cannot check: only their sign is.
const RANGED_TEXT_FORMS: Record<string, string> = {
  int: SIGNED,
  short: SIGNED,
  byte: SIGNED,
  unsignedInt: UNSIGNED,
  unsignedShort: UNSIGNED,
  unsignedByte: UNSIGNED,
};

export interface SimpleTypeOptions {
  dateTime: 'format' | 'pattern';
  /** write `xml.whiteSpace` on string values that XML normalizes; default true */
  xml?: boolean | undefined;
}

export type WhiteSpace = 'preserve' | 'replace' | 'collapse';
const WHITESPACE_ORDER: WhiteSpace[] = ['preserve', 'replace', 'collapse'];

/**
 * The whiteSpace a built-in type fixes (XML Schema Part 2, 4.3.6): `string` preserves, `normalizedString` replaces,
 * every other type collapses, including `token` and its derivations, the list types and the non-string primitives.
 * anySimpleType has no whiteSpace facet; its text is kept as written.
 */
function builtinWhiteSpace(builtin: string): WhiteSpace {
  if (builtin === 'string' || builtin === 'anySimpleType' || builtin === 'anyType') {
    return 'preserve';
  }
  return builtin === 'normalizedString' ? 'replace' : 'collapse';
}

const stricter = (a: WhiteSpace, b: WhiteSpace): WhiteSpace =>
  WHITESPACE_ORDER.indexOf(a) >= WHITESPACE_ORDER.indexOf(b) ? a : b;

/** The whiteSpace facet of one restriction step, if it has one. */
function stepWhiteSpace(facets: Element[]): WhiteSpace | undefined {
  const facet = facets.find((f) => f.localName === 'whiteSpace');
  const value = facet && attr(facet, 'value')?.trim();
  return value === 'preserve' || value === 'replace' || value === 'collapse' ? value : undefined;
}

/**
 * Normalizes text as XML does before checking it: replace turns tab, line feed and carriage return into spaces,
 * collapse also joins runs of spaces and drops them at both ends.
 */
export function normalizeWhiteSpace(text: string, whiteSpace: WhiteSpace | undefined): string {
  if (whiteSpace === undefined || whiteSpace === 'preserve') {
    return text;
  }
  const replaced = text.replace(/[\t\n\r]/g, ' ');
  return whiteSpace === 'collapse' ? replaced.replace(/ {2,}/g, ' ').trim() : replaced;
}

/** The JSON type a built-in XML Schema type maps to: anySimpleType is text; undefined for anyType. */
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
  if (builtin === 'anyType') {
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

/** A restriction step: the element that holds the facets, and the facets. */
export interface RestrictionStep {
  node: Element;
  facets: Element[];
}

/** A simple type with further restriction steps written elsewhere, such as the text of a simpleContent restriction. */
export interface RestrictedType {
  base: SimpleTypeRef;
  steps: RestrictionStep[];
}

/** A simple type given by name, as an anonymous xs:simpleType element, or restricted further. */
export type SimpleTypeRef = QName | Element | RestrictedType;

const isElement = (type: SimpleTypeRef): type is Element => 'nodeType' in type;
const isRestricted = (type: SimpleTypeRef): type is RestrictedType => 'steps' in type;

/** The derivation of a simple type down to its built-in type, with the facets of each restriction step. */
interface Derivation {
  /** local name of the built-in type at the bottom of the chain */
  builtin: string;
  variety: 'atomic' | 'list' | 'union';
  /** restriction steps, base first */
  steps: RestrictionStep[];
  /** a named type that is not defined, and the node that names it */
  missing?: { name: QName; from: Element | undefined };
  /** the xs:union element and its member types, for a union */
  union?: { node: Element; members: SimpleTypeRef[] };
  /** the xs:list element (none for a built-in list) and its item type, for a list */
  list?: { node: Element | undefined; item: SimpleTypeRef; nonEmpty: boolean };
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
  /** the same types with patterns for dates and times, to pick the member of a union that takes a value */
  private patternTypes: SimpleTypes | undefined;
  /** whether the schema has been reported to use xs:ID or xs:IDREF */
  private idReported = false;

  /**
   * @param nameRef - a `$ref` to one definition of a built-in name type (`Name`, `NCName`, `QName` and those derived
   * from them, `NMTOKEN`), built by `build` the first time; their patterns are long, so they are written once
   */
  constructor(
    private readonly set: SchemaSet,
    private readonly problems: Problems,
    private readonly options: SimpleTypeOptions,
    private readonly nameRef?: (local: string, build: () => JsonSchema) => JsonSchema,
  ) {}

  /** The same types with patterns in place and for dates and times, to check values against members and items. */
  private checker(): SimpleTypes {
    if (this.options.dateTime === 'pattern' && this.nameRef === undefined) {
      return this;
    }
    return (this.patternTypes ??= new SimpleTypes(this.set, new Problems(), { ...this.options, dateTime: 'pattern' }));
  }

  private at(node: Element | undefined): At | undefined {
    return node && this.set.at(node);
  }

  /** The element that defines a simple type: the xs:simpleType, or the node of the last further restriction step. */
  private definitionNode(type: SimpleTypeRef): Element | undefined {
    if (isRestricted(type)) {
      return type.steps.at(-1)?.node ?? this.definitionNode(type.base);
    }
    return isElement(type) ? type : this.set.lookup('simpleType', type)?.node;
  }

  /**
   * Follows a simple type down to its built-in type.
   *
   * @param from - the node that names the type, where problems with the name are reported
   */
  derive(type: SimpleTypeRef, from?: Element, seen = new Set<Element>()): Derivation {
    if (isRestricted(type)) {
      const base = this.derive(type.base, from, seen);
      return { ...base, steps: [...base.steps, ...type.steps] };
    }
    if (!isElement(type)) {
      if (type.ns === XS) {
        if (!isKnownBuiltin(type.local)) {
          this.problems.error('unknown-type', `xs:${type.local} is no built-in type`, this.at(from));
          return { builtin: 'string', variety: 'atomic', steps: [] };
        }
        const item = LIST_ITEMS[type.local];
        if (item !== undefined) {
          return {
            builtin: type.local,
            variety: 'list',
            steps: [],
            list: { node: undefined, item: { ns: XS, local: item }, nonEmpty: true },
          };
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
    const list = xsChild(type, 'list');
    if (list) {
      const itemType = attr(list, 'itemType');
      const inner = xsChild(list, 'simpleType');
      const item: SimpleTypeRef =
        itemType !== undefined ? this.set.resolveQName(list, itemType) : (inner ?? { ns: XS, local: 'anySimpleType' });
      return { builtin: 'string', variety: 'list', steps: [], list: { node: list, item, nonEmpty: false } };
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
  jsonType(type: SimpleTypeRef, from?: Element): JsonType | JsonType[] | undefined {
    const derivation = this.derive(type, from);
    if (derivation.union) {
      const { node, members } = derivation.union;
      if (this.openUnions.has(node) || members.some((member) => this.containsList(member, node))) {
        return 'string';
      }
      this.openUnions.add(node);
      const types = members.map((member) => this.jsonType(member, node));
      this.openUnions.delete(node);
      return withSpecials(sharedJsonType(types), types) ?? 'string';
    }
    if (derivation.variety === 'list') {
      return 'array';
    }
    const integerOnly = derivation.steps.some((step) =>
      step.facets.some((f) => f.localName === 'fractionDigits' && Number(attr(f, 'value')) === 0),
    );
    if (derivation.builtin === 'float' || derivation.builtin === 'double') {
      return ['number', 'string'];
    }
    const json = jsonTypeOf(derivation.builtin);
    return json === 'number' && integerOnly ? 'integer' : json;
  }

  /**
   * How XML normalizes the text of a simple type before checking it: the whiteSpace of the built-in type, tightened
   * by whiteSpace facets of the restriction steps. A list collapses. A union normalizes with each member's own
   * whiteSpace; it has one only when all members agree, otherwise the result is undefined.
   */
  whiteSpace(type: SimpleTypeRef, from?: Element, open = new Set<Element>()): WhiteSpace | undefined {
    const derivation = this.derive(type, from);
    if (derivation.missing) {
      return undefined;
    }
    if (derivation.variety === 'list') {
      return 'collapse';
    }
    if (derivation.union) {
      const { node, members } = derivation.union;
      if (open.has(node)) {
        return undefined;
      }
      open.add(node);
      const own = new Set(members.map((member) => this.whiteSpace(member, node, open)));
      open.delete(node);
      return own.size === 1 ? [...own][0] : undefined;
    }
    return derivation.steps.reduce(
      (result, step) => stricter(result, stepWhiteSpace(step.facets) ?? result),
      builtinWhiteSpace(derivation.builtin),
    );
  }

  /** Records the whiteSpace of a string value in `xml`, so that a reader of XML can normalize it first. */
  private withWhiteSpace(schema: JsonSchema, type: SimpleTypeRef, from: Element | undefined): JsonSchema {
    if (this.options.xml === false || schema.type !== 'string') {
      return schema;
    }
    const whiteSpace = this.whiteSpace(type, from);
    if (whiteSpace === undefined || whiteSpace === 'preserve') {
      return schema;
    }
    return { ...schema, xml: { ...schema.xml, whiteSpace } };
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
    return schema;
  }

  /**
   * JSON Schema of a simple type: the built-in type with the facets of all restriction steps merged, and
   * `xml.whiteSpace` on a string value that XML normalizes.
   *
   * @param from - the node that names the type, where problems with the name are reported
   */
  schema(type: SimpleTypeRef, from?: Element): JsonSchema {
    return this.withWhiteSpace(this.facetSchema(type, from), type, from);
  }

  /** The schema of a simple type without its `xml` annotation. */
  private facetSchema(type: SimpleTypeRef, from?: Element): JsonSchema {
    const derivation = this.derive(type, from);
    const at = this.at(this.definitionNode(type) ?? from);
    if (derivation.missing) {
      const { name, from: namedAt } = derivation.missing;
      this.problems.error('unknown-type', `simple type {${name.ns}}${name.local} is not defined`, this.at(namedAt));
      return {};
    }
    if (derivation.list) {
      return this.listSchema(derivation, derivation.list);
    }
    if (derivation.union) {
      return this.unionSchema(derivation, derivation.union, at);
    }
    const schema = this.builtinSchema(derivation.builtin);
    const json = schema.type;
    if (derivation.builtin === 'QName') {
      this.problems.warning(
        'unchecked-qname-prefix',
        'xs:QName is checked as prefix:local; whether the prefix is bound to a namespace is not checked',
        at,
      );
    }
    const patternSteps: string[][] = [];
    const lexical = LEXICAL[derivation.builtin];
    if (lexical !== undefined && schema.pattern) {
      patternSteps.push([translateBody(lexical)]);
    }
    // A name type refers to its definition for its lexical pattern, instead of repeating it.
    const nameRef = NAME_TYPES.includes(derivation.builtin) ? this.nameRef : undefined;
    let enumeration: string[] | undefined;
    let enumAt: Element | undefined;
    const numeric: NumericFacets = { lower: [], upper: [] };
    // xs:float and xs:double also have the values INF, -INF and NaN, which bounds can rule out or name.
    const floating = derivation.builtin === 'float' || derivation.builtin === 'double';
    const specials = new SpecialValues();
    // Enumeration values are values of the base type of their step, normalized with its whiteSpace.
    let baseWhiteSpace = builtinWhiteSpace(derivation.builtin);
    for (const step of derivation.steps) {
      const patterns: string[] = [];
      const values: string[] = [];
      const whiteSpace = baseWhiteSpace;
      baseWhiteSpace = stricter(baseWhiteSpace, stepWhiteSpace(step.facets) ?? baseWhiteSpace);
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
            values.push(json === 'string' ? normalizeWhiteSpace(value, whiteSpace) : value);
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
            // The length of binary data counts octets.
            if (derivation.builtin === 'base64Binary') {
              this.problems.warning(
                'unsupported-length',
                `${facet.localName} on xs:base64Binary counts octets, not characters; it is left out`,
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
            const lower = facet.localName.startsWith('min');
            const exclusive = facet.localName.endsWith('Exclusive');
            if (floating && specials.bound(value.trim(), lower, exclusive)) {
              break;
            }
            const bound = lexicalToJson(floating ? ['number', 'string'] : 'number', value);
            if ('error' in bound) {
              this.problems.error('invalid-facet', bound.error, facetAt);
              break;
            }
            if (bound.rounded) {
              this.problems.warning(
                'rounded-number',
                `${facet.localName} ${value} is rounded to ${String(bound.value)}`,
                facetAt,
              );
            }
            (lower ? numeric.lower : numeric.upper).push({
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
          case 'whiteSpace': {
            // Normalizes the XML text, no JSON constraint; whiteSpace() records it in `xml`.
            const own = stepWhiteSpace([facet]);
            if (own === undefined) {
              this.problems.error(
                'invalid-facet',
                `whiteSpace needs preserve, replace or collapse, not "${value}"`,
                facetAt,
              );
            } else if (stricter(own, whiteSpace) !== own) {
              this.problems.error(
                'invalid-facet',
                `whiteSpace ${own} cannot relax the ${whiteSpace} of its base`,
                facetAt,
              );
            }
            break;
          }
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
        enumeration = this.withinBase(values, enumeration, json, step.node);
        enumAt = step.node;
      }
    }

    this.checkPrecision(derivation.builtin, numeric, enumeration !== undefined, at);
    if (derivation.builtin === 'ID' || derivation.builtin === 'IDREF') {
      this.idUsed(at);
    }
    applyNumericFacets(schema, numeric, this.problems, at);
    if (schema.maxLength === Infinity) {
      delete schema.maxLength;
    }
    if (schema.minLength === 0) {
      delete schema.minLength;
    }
    if (nameRef && enumeration === undefined) {
      const builtin = derivation.builtin;
      patternSteps.shift();
      delete schema.pattern;
      const ref = nameRef(builtin, () =>
        this.withWhiteSpace(this.builtinSchema(builtin), { ns: XS, local: builtin }, undefined),
      );
      return this.nameSchema(ref, schema, patternSteps);
    }
    if (floating && patternSteps.length > 0) {
      specials.match(new RegExp(combinePatterns(patternSteps), 'u'));
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

    if (floating) {
      return this.floatingSchema(schema, specials, enumeration, enumAt);
    }
    if (enumeration !== undefined && enumAt !== undefined) {
      const out = enumSchema(schema, enumeration, this.problems, this.at(enumAt));
      return json === 'string' ? this.byValue(out, (lexical) => this.valueOf(type, lexical, from)).schema : out;
    }
    return schema;
  }

  /**
   * An xs:float or xs:double: a JSON number, or one of the strings INF, -INF and NaN that the facets allow. With both,
   * it is an `anyOf` of the number schema and an `enum` of the strings; with an enumeration, one `enum` of numbers and
   * strings. Without any value, the schema accepts nothing.
   */
  private floatingSchema(
    numbers: JsonSchema,
    specials: SpecialValues,
    enumeration: string[] | undefined,
    enumAt: Element | undefined,
  ): JsonSchema {
    let numeric: JsonSchema | undefined = specials.numbers ? numbers : undefined;
    let allowed = specials.allowed;
    if (enumeration !== undefined) {
      const named = enumeration.map((lexical) => lexical.trim());
      allowed = allowed.filter((value) => named.includes(value));
      for (const value of named.filter((v) => SPECIAL_VALUES.includes(v) && !allowed.includes(v))) {
        this.problems.warning(
          'unreachable-enumeration',
          `enumeration value ${value} is left out: another facet rules it out`,
          this.at(enumAt),
        );
      }
      const finite = enumeration.filter((lexical) => !SPECIAL_VALUES.includes(lexical.trim()));
      numeric =
        numeric && finite.length > 0
          ? enumSchema(numbers, finite, this.problems, this.at(enumAt), ['number', 'string'])
          : undefined;
      if (numeric?.not) {
        numeric = undefined;
      }
      if (numeric && allowed.length > 0) {
        return { enum: [...(numeric.enum ?? []), ...allowed] };
      }
    }
    if (numeric && allowed.length > 0) {
      return { anyOf: [numeric, { enum: allowed }] };
    }
    if (numeric) {
      return numeric;
    }
    return allowed.length > 0 ? { type: 'string', enum: allowed } : { not: {} };
  }

  /**
   * An enumeration of string values compared by value: a pattern with all spellings of the values, where a value has
   * more than one. Unchanged where each value has one spelling, or where the spellings can't be listed (a float or
   * double member of a union); `unlisted` then names the type.
   */
  private byValue(
    schema: JsonSchema,
    valueOf: (lexical: string) => { builtin: string; text: string },
  ): { schema: JsonSchema; unlisted?: string } {
    if (!schema.enum) {
      return { schema };
    }
    const forms = this.valueForms(schema.enum.map(String), valueOf);
    if ('unlisted' in forms) {
      return { schema, unlisted: forms.unlisted };
    }
    if (forms.pattern === undefined) {
      return { schema };
    }
    const out: JsonSchema = { ...schema, pattern: forms.pattern };
    delete out.enum;
    return { schema: out };
  }

  /** The pattern of all spellings of these values, see `byValue`; undefined if each value has one spelling. */
  private valueForms(
    lexicals: string[],
    valueOf: (lexical: string) => { builtin: string; text: string },
  ): { pattern?: string } | { unlisted: string } {
    let needed = false;
    const forms: string[] = [];
    for (const lexical of lexicals) {
      const { builtin, text } = valueOf(lexical);
      if (hasUnlistedForms(builtin)) {
        return { unlisted: `xs:${builtin}` };
      }
      const own = equalForms(builtin, text);
      needed ||= own !== undefined;
      forms.push(own ?? escapePattern(text));
    }
    return needed ? { pattern: `^(?:${forms.join('|')})$` } : {};
  }

  /**
   * The pattern for a fixed value of a type whose JSON value is a string, compared by value as for `byValue`;
   * undefined if the value has one spelling, `unlisted` if its spellings can't be listed.
   */
  fixedForms(type: SimpleTypeRef, lexical: string, from?: Element): { pattern?: string } | { unlisted: string } {
    if (this.jsonType(type, from) !== 'string') {
      return {};
    }
    return this.valueForms([lexical], (value) => this.valueOf(type, value, from));
  }

  /**
   * The built-in type that compares a value and the value as it normalizes it: for a union, those of the member
   * that accepts the value first.
   */
  private valueOf(type: SimpleTypeRef, lexical: string, from?: Element, depth = 0): { builtin: string; text: string } {
    const derivation = this.derive(type, from);
    if (derivation.union && depth < 20) {
      return this.unionValueOf(derivation.union, lexical, depth);
    }
    return { builtin: derivation.builtin, text: normalizeWhiteSpace(lexical, this.whiteSpace(type, from)) };
  }

  private unionValueOf(
    union: NonNullable<Derivation['union']>,
    lexical: string,
    depth = 0,
  ): { builtin: string; text: string } {
    const member = union.members[Math.max(0, this.memberIndex(union, lexical))];
    return member ? this.valueOf(member, lexical, union.node, depth + 1) : { builtin: 'string', text: lexical };
  }

  /**
   * Reports what JSON numbers can't check of a decimal type: the range of xs:long and xs:unsignedLong beyond 2^53,
   * and fractionDigits where values may have more than 15 significant digits, which a JSON number rounds away.
   */
  private checkPrecision(builtin: string, numeric: NumericFacets, enumerated: boolean, at: At | undefined): void {
    const safe = 2 ** 53;
    const lower = numeric.lower.some((b) => b.value >= -safe);
    const upper = numeric.upper.some((b) => b.value <= safe);
    if (!enumerated && ((builtin === 'long' && !(lower && upper)) || (builtin === 'unsignedLong' && !upper))) {
      this.problems.warning(
        'unsupported-bound',
        `the range of xs:${builtin} reaches beyond 2^53, which JSON numbers can't hold exactly; it isn't checked`,
        at,
      );
    }
    // How many digits a value can have before the point: from totalDigits, else from bounds on both sides.
    const fraction = numeric.fractionDigits;
    const extent = Math.max(...[...numeric.lower, ...numeric.upper].map((b) => Math.abs(b.value)));
    const bounded = numeric.lower.length > 0 && numeric.upper.length > 0 && Number.isFinite(extent);
    const whole =
      numeric.totalDigits !== undefined
        ? Math.max(0, numeric.totalDigits - (fraction ?? 0))
        : bounded
          ? String(Math.trunc(extent)).length
          : Infinity;
    if (!enumerated && fraction !== undefined && whole + fraction > 15) {
      this.problems.warning(
        'rounded-number',
        `fractionDigits ${numeric.fractionDigits} is checked on JSON numbers, which keep 15 significant digits; ` +
          'a value with more digits is rounded before the check',
        at,
      );
    }
  }

  /** Reports once per schema that IDs and references to them aren't checked. */
  private idUsed(at: At | undefined): void {
    if (!this.idReported) {
      this.idReported = true;
      this.problems.warning(
        'unchecked-id',
        "xs:ID and xs:IDREF values are checked as names; that IDs are unique and references point to one isn't checked",
        at,
      );
    }
  }

  /** A name type: the `$ref` to the definition of its built-in type, then its own facets and patterns. */
  private nameSchema(ref: JsonSchema, schema: JsonSchema, patternSteps: string[][]): JsonSchema {
    const out: JsonSchema = { ...ref, ...schema };
    if (patternSteps.length > 0) {
      out.pattern = combinePatterns(patternSteps);
    }
    return out;
  }

  /**
   * An xs:union gets the JSON type its members share and becomes an `anyOf` of the member types, in member order. Each
   * branch keeps the `xml.whiteSpace` of its member, as XML normalizes the text for each member on its own. Patterns
   * and enumerations of restrictions on the union apply to the whole value. If the members have different JSON
   * types, the value is a string and each member is checked in its lexical form.
   */
  private unionSchema(derivation: Derivation, union: NonNullable<Derivation['union']>, at: At | undefined): JsonSchema {
    if (this.openUnions.has(union.node)) {
      this.problems.error('circular-type', 'a union that contains itself', this.at(union.node));
      return { type: 'string' };
    }
    this.openUnions.add(union.node);
    let members = union.members.map((member) => this.schema(member, union.node));
    const memberTypes = union.members.map((member) => this.jsonType(member, union.node));
    const json = sharedJsonType(memberTypes);
    // A float or double member adds INF, -INF and NaN: the union then has no single JSON type.
    const specialValues = Array.isArray(withSpecials(json, memberTypes));
    const withList = union.members.some((member) => this.containsList(member, union.node));
    const unchecked: string[] = [];
    if (json === undefined && !withList) {
      members = union.members.map((member) => this.textForm(member, union.node, unchecked));
    }
    this.openUnions.delete(union.node);
    const schema: JsonSchema = specialValues && !withList ? {} : { type: withList ? 'string' : (json ?? 'string') };
    // A member without facets of that very type accepts every value, and so does the union then.
    const acceptsAll = (m: JsonSchema) =>
      (m.type ?? 'string') === schema.type &&
      Object.keys(m).every((k) => k === 'type' || k === 'description' || k === 'xml');
    // Members that normalize differently need their branches even then: a reader picks the member by them.
    const whiteSpaces = new Set(union.members.map((member) => this.whiteSpace(member, union.node)));
    const branchesNeeded = this.options.xml !== false && schema.type === 'string' && whiteSpaces.size > 1;
    if (withList) {
      this.problems.warning(
        'unsupported-union',
        'xs:union with a list member: the value is a string and is checked as a string only',
        at,
      );
    }
    if (!withList && members.length > 0 && (json === undefined || branchesNeeded || !members.some(acceptsAll))) {
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
          // An enumeration value is a value of the member that accepts it first, normalized as that member does.
          const lexical = attr(facet, 'value') ?? '';
          values.push(schema.type === 'string' ? this.memberText(union, lexical) : lexical);
        } else if (facet.localName !== 'whiteSpace') {
          this.problems.error('unsupported-facet', `xs:${facet.localName} on a union is not supported`, this.at(facet));
        }
      }
      if (patterns.length > 0) {
        patternSteps.push(patterns);
      }
      if (values.length > 0) {
        enumeration = { values: this.withinBase(values, enumeration?.values, schema.type, step.node), at: step.node };
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
    let out = schema;
    let unlisted: string | undefined;
    if (enumeration) {
      // The enumeration lists values; the branches stay, so that a reader still knows how each member normalizes.
      const types = specialValues ? withSpecials(json, memberTypes) : schema.type;
      out = enumSchema(schema, enumeration.values, this.problems, this.at(enumeration.at), types);
      if (schema.type === 'string') {
        ({ schema: out, unlisted } = this.byValue(out, (lexical) => this.unionValueOf(union, lexical)));
      }
      out = branchesNeeded && schema.anyOf ? { ...out, anyOf: schema.anyOf } : out;
    }
    if (!withList && json === undefined && (unchecked.length > 0 || unlisted !== undefined)) {
      const parts = [...new Set(unchecked)];
      if (unlisted !== undefined) {
        parts.push(`the enumeration of the union, which compares ${unlisted} values as text`);
      }
      this.problems.warning(
        'unsupported-union',
        `xs:union whose members have different JSON types is checked as text; not checked: ${parts.join(', ')}`,
        at,
      );
    }
    return out;
  }

  /**
   * An xs:list becomes an array of its items, typed like any simple value, marked with `xml.list`. Lengths count
   * items; an enumeration lists arrays of item values. A pattern restricts the text of the whole list and can't be
   * checked on the array.
   */
  private listSchema(derivation: Derivation, list: NonNullable<Derivation['list']>): JsonSchema {
    const items: JsonSchema = { ...this.schema(list.item, list.node) };
    delete items.description;
    const checkItems = this.checker() === this ? items : this.checker().schema(list.item, list.node);
    let min = list.nonEmpty ? 1 : 0;
    let max = Infinity;
    let enumeration: { values: unknown[][]; at: Element } | undefined;
    for (const step of derivation.steps) {
      const values: unknown[][] = [];
      for (const facet of step.facets) {
        const value = attr(facet, 'value') ?? '';
        const facetAt = this.at(facet);
        switch (facet.localName) {
          case 'length':
          case 'minLength':
          case 'maxLength': {
            if (!/^\s*\+?[0-9]+\s*$/.test(value)) {
              this.problems.error(
                'invalid-facet',
                `${facet.localName} needs a non-negative integer, not "${value}"`,
                facetAt,
              );
              break;
            }
            if (facet.localName !== 'maxLength') {
              min = Math.max(min, Number(value));
            }
            if (facet.localName !== 'minLength') {
              max = Math.min(max, Number(value));
            }
            break;
          }
          case 'pattern':
            this.problems.warning(
              'unsupported-list-pattern',
              'a pattern on a list restricts the text of the whole list; the JSON array is not checked against it',
              facetAt,
            );
            break;
          case 'enumeration': {
            const converted = this.listToJson(list, value);
            if ('error' in converted) {
              this.problems.error('invalid-facet', converted.error, facetAt);
            } else {
              values.push(converted.value);
            }
            break;
          }
          case 'whiteSpace':
            if (value.trim() !== 'collapse') {
              this.problems.error('invalid-facet', `whiteSpace ${value} cannot relax the collapse of a list`, facetAt);
            }
            break;
          default:
            this.problems.error('unsupported-facet', `xs:${facet.localName} does not apply to a list`, facetAt);
        }
      }
      if (values.length > 0) {
        // A further enumeration may only keep values of the one before.
        const allowed = enumeration && new Set(enumeration.values.map((v) => JSON.stringify(v)));
        const kept = values.filter((v) => {
          if (allowed && !allowed.has(JSON.stringify(v))) {
            this.problems.error(
              'invalid-facet',
              `enumeration value ${JSON.stringify(v)} is not in the base enumeration`,
              this.at(step.node),
            );
            return false;
          }
          return true;
        });
        enumeration = { values: kept, at: step.node };
      }
    }
    const schema: JsonSchema = { type: 'array', items };
    if (min > 0) {
      schema.minItems = min;
    }
    if (max !== Infinity) {
      schema.maxItems = max;
    }
    if (enumeration) {
      const kept = enumeration.values.filter((v) => {
        const reason =
          v.length < min
            ? `fewer than ${min} items`
            : v.length > max
              ? `more than ${max} items`
              : itemViolation(checkItems, v);
        if (reason) {
          this.problems.warning(
            'unreachable-enumeration',
            `enumeration value ${JSON.stringify(v)} is left out: ${reason}`,
            this.at(enumeration?.at),
          );
        }
        return !reason;
      });
      const distinct = kept.filter((v, i) => kept.findIndex((w) => JSON.stringify(w) === JSON.stringify(v)) === i);
      if (distinct.length > 0) {
        schema.enum = distinct;
      } else {
        schema.not = {};
      }
    }
    if (this.options.xml !== false) {
      schema.xml = { list: true };
    }
    return schema;
  }

  /** The items of a lexical list value as JSON: collapsed, split at spaces, each converted like a simple value. */
  private listToJson(
    list: NonNullable<Derivation['list']>,
    lexical: string,
  ): { value: unknown[]; rounded?: true } | { error: string } {
    const text = normalizeWhiteSpace(lexical, 'collapse');
    const parts = text === '' ? [] : text.split(' ');
    const json = this.jsonType(list.item, list.node);
    const out: unknown[] = [];
    let rounded = false;
    for (const part of parts) {
      const converted = lexicalToJson(json, json === 'string' ? this.normalizeValue(list.item, part, list.node) : part);
      if ('error' in converted) {
        return { error: `list item ${converted.error}` };
      }
      rounded ||= converted.rounded === true;
      out.push(converted.value);
    }
    return rounded ? { value: out, rounded: true } : { value: out };
  }

  /**
   * A fixed, default or enumeration value of a simple type as JSON: normalized as XML does and converted to the JSON
   * type; a list becomes an array of item values.
   */
  valueToJson(
    type: SimpleTypeRef,
    lexical: string,
    from?: Element,
  ): { value: unknown; rounded?: true } | { error: string } {
    const derivation = this.derive(type, from);
    if (derivation.list && this.jsonType(type, from) === 'array') {
      return this.listToJson(derivation.list, lexical);
    }
    const json = this.jsonType(type, from);
    return lexicalToJson(json, json === 'string' ? this.normalizeValue(type, lexical, from) : lexical);
  }

  /** Whether a simple type is a list or a union with a list among its members. */
  private containsList(type: SimpleTypeRef, from: Element, open = new Set<Element>()): boolean {
    const derivation = this.derive(type, from);
    if (derivation.variety === 'list') {
      return true;
    }
    if (!derivation.union || open.has(derivation.union.node)) {
      return false;
    }
    open.add(derivation.union.node);
    const { node, members } = derivation.union;
    return members.some((member) => this.containsList(member, node, open));
  }

  /**
   * A member of a union whose members have different JSON types, checked as text: string members as they are, the
   * others by their lexical form and their patterns.
   *
   * @param unchecked - collects what the text form leaves out
   */
  /**
   * A member of a union whose members have different JSON types, checked as text: string members as they are, the
   * others by their lexical form and their patterns.
   *
   * @param unchecked - collects what the text form leaves out
   */
  private textForm(member: SimpleTypeRef, from: Element, unchecked: string[]): JsonSchema {
    const schema = this.schema(member, from);
    if ((schema.type ?? 'string') === 'string' && this.jsonType(member, from) === 'string') {
      return schema;
    }
    const derivation = this.derive(member, from);
    const patternSteps: string[][] = [];
    let out: JsonSchema = { type: 'string' };
    if (derivation.union) {
      const { node, members } = derivation.union;
      out.anyOf = members.map((inner) => {
        const copy = { ...this.textForm(inner, node, unchecked) };
        delete copy.description;
        return copy;
      });
    } else {
      const form = TEXT_FORMS[derivation.builtin] ?? RANGED_TEXT_FORMS[derivation.builtin];
      if (form === undefined) {
        unchecked.push(`xs:${derivation.builtin}`);
        return { type: 'string' };
      }
      if (RANGED_TEXT_FORMS[derivation.builtin] !== undefined) {
        unchecked.push(`the range of xs:${derivation.builtin}`);
      }
      patternSteps.push([translateBody(form)]);
    }
    for (const step of derivation.steps) {
      const patterns: string[] = [];
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
        } else if (facet.localName !== 'whiteSpace') {
          unchecked.push(`xs:${facet.localName}`);
        }
      }
      if (patterns.length > 0) {
        patternSteps.push(patterns);
      }
    }
    if (patternSteps.length > 0) {
      out.pattern = combinePatterns(patternSteps);
    }
    out = this.withWhiteSpace(out, member, from);
    return out;
  }

  /**
   * A lexical value of a union as the member that accepts it first normalizes it; the value with the whiteSpace of
   * the first member if none does. The members are checked by their patterns, also in `format` mode, as `format`
   * is not checked here.
   */
  private memberText(union: NonNullable<Derivation['union']>, lexical: string): string {
    const index = this.memberIndex(union, lexical);
    const member = union.members[index < 0 ? 0 : index];
    return member ? normalizeWhiteSpace(lexical, this.whiteSpace(member, union.node)) : lexical;
  }

  /** The index of the member of a union that accepts a lexical value first; -1 if none does. */
  private memberIndex(union: NonNullable<Derivation['union']>, lexical: string): number {
    const types = this.checker();
    const { node, members } = union;
    const opened = !types.openUnions.has(node);
    types.openUnions.add(node);
    const schemas = members.map((member) => types.textForm(member, node, []));
    if (opened) {
      types.openUnions.delete(node);
    }
    const normalized = members.map((member) => normalizeWhiteSpace(lexical, this.whiteSpace(member, node)));
    return schemas.findIndex((schema, i) => violation(schema, normalized[i]) === undefined);
  }

  /**
   * A fixed or default value as XML normalizes it for a simple type. For a union of string values, the member that
   * accepts the value first decides.
   */
  normalizeValue(type: SimpleTypeRef, lexical: string, from?: Element): string {
    const derivation = this.derive(type, from);
    if (derivation.union && this.jsonType(type, from) === 'string' && !this.openUnions.has(derivation.union.node)) {
      return this.memberText(derivation.union, lexical);
    }
    return normalizeWhiteSpace(lexical, this.whiteSpace(type, from));
  }

  /** The values of a further enumeration its base enumeration allows; XML Schema forbids the others. */
  private withinBase(
    values: string[],
    base: string[] | undefined,
    json: JsonType | JsonType[] | undefined,
    node: Element,
  ): string[] {
    if (base === undefined) {
      return values;
    }
    const valueOf = (lexical: string) => {
      const converted = lexicalToJson(json, lexical);
      return 'value' in converted ? converted.value : lexical;
    };
    const allowed = new Set(base.map(valueOf));
    return values.filter((value) => {
      if (!allowed.has(valueOf(value))) {
        this.problems.error(
          'invalid-facet',
          `enumeration value ${value} is not in the base enumeration`,
          this.at(node),
        );
        return false;
      }
      return true;
    });
  }
}

/** The shared number type of a union, with the strings INF, -INF and NaN if a float or double member has them. */
function withSpecials(
  json: JsonType | undefined,
  types: (JsonType | JsonType[] | undefined)[],
): JsonType | JsonType[] | undefined {
  const special = types.some((type) => Array.isArray(type) && type.includes('string'));
  return special && (json === 'number' || json === 'integer') ? ['number', 'string'] : json;
}

/** Why the items of an array value break the item schema, if they do. */
function itemViolation(items: JsonSchema, value: unknown[]): string | undefined {
  for (const item of value) {
    const reason = violation(items, item);
    if (reason) {
      return `item ${JSON.stringify(item)} ${reason}`;
    }
  }
  return undefined;
}

/** The JSON type all members of a union share, with integer and number counted as number; undefined if they differ. */
function sharedJsonType(types: (JsonType | JsonType[] | undefined)[]): JsonType | undefined {
  const distinct = new Set(types.map((type) => (Array.isArray(type) ? primaryType(type) : type) ?? 'string'));
  if (distinct.size === 1) {
    return [...distinct][0];
  }
  return [...distinct].every((type) => type === 'integer' || type === 'number') ? 'number' : undefined;
}
