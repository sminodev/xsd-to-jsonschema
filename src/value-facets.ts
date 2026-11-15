// The facets of a simple type as plain data, read from the XML Schema as written: what `describeSchema()` reports for each
// value, including what the JSON Schema leaves out (bounds of dates, lengths of binary data, patterns of lists).

import type { Element } from '@xmldom/xmldom';
import { attr, type QName, type SchemaSet, XS, xsChild, xsChildren } from './schema-set.js';

/** The facets of a value; see docs/structure.md. */
export interface ValueFacets {
  /**
   * local name of the built-in type the derivation ends at, such as `decimal`; `anySimpleType` for lists and unions the
   * schema defines, while a built-in list type such as `NMTOKENS` keeps its name
   */
  builtin: string;
  variety: 'atomic' | 'list' | 'union';
  /** a list: the facets of its items; the length facets count items */
  item?: ValueFacets;
  /** a union: the facets of its member types */
  members?: ValueFacets[];
  enumeration?: string[];
  /** one array per restriction step: a value matches one pattern of each step */
  patterns?: string[][];
  length?: number;
  minLength?: number;
  maxLength?: number;
  /** bounds as written in the schema */
  minInclusive?: string;
  maxInclusive?: string;
  minExclusive?: string;
  maxExclusive?: string;
  totalDigits?: number;
  fractionDigits?: number;
  /** how XML normalizes the value before checking it; absent for a union, whose members decide */
  whiteSpace?: 'preserve' | 'replace' | 'collapse';
  /** the fixed value of the element or attribute declaration */
  fixed?: string;
}

/** The built-in list types and the types of their items. */
const BUILTIN_LISTS: Record<string, string> = { NMTOKENS: 'NMTOKEN', IDREFS: 'IDREF', ENTITIES: 'ENTITY' };

const NUMBER_FACETS = ['length', 'minLength', 'maxLength', 'totalDigits', 'fractionDigits'] as const;
const BOUND_FACETS = ['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'] as const;
const WHITESPACE = ['preserve', 'replace', 'collapse'] as const;

function builtinWhiteSpace(local: string): 'preserve' | 'replace' | 'collapse' {
  if (local === 'string' || local === 'anySimpleType') {
    return 'preserve';
  }
  return local === 'normalizedString' ? 'replace' : 'collapse';
}

/** The facets of a built-in type: none but its whitespace, and the items of a built-in list type. */
export function builtinFacets(local: string): ValueFacets {
  const item = BUILTIN_LISTS[local];
  if (item !== undefined) {
    return { builtin: local, variety: 'list', item: builtinFacets(item), whiteSpace: 'collapse' };
  }
  return { builtin: local, variety: 'atomic', whiteSpace: builtinWhiteSpace(local) };
}

/**
 * Adds the facets of one restriction step to those of its base. A valid restriction only narrows, so a facet of the
 * step replaces the one of the base, and a bound of the step replaces the base's bound on the same side, inclusive or
 * exclusive; `length` replaces `minLength` and `maxLength`. Patterns add a step, and enumerations replace the base's
 * list.
 */
export function restrict(base: ValueFacets, facets: readonly Element[]): ValueFacets {
  const out: ValueFacets = { ...base };
  const own = new Set(facets.flatMap((facet) => (attr(facet, 'value') === undefined ? [] : [facet.localName ?? ''])));
  const enumeration: string[] = [];
  const patterns: string[] = [];
  for (const facet of facets) {
    const name = facet.localName ?? '';
    const value = attr(facet, 'value');
    if (value === undefined) {
      continue;
    }
    if (name === 'enumeration') {
      enumeration.push(value);
    } else if (name === 'pattern') {
      patterns.push(value);
    } else if ((NUMBER_FACETS as readonly string[]).includes(name)) {
      const number = Number(value.trim());
      if (Number.isSafeInteger(number)) {
        out[name as (typeof NUMBER_FACETS)[number]] = number;
      }
    } else if ((BOUND_FACETS as readonly string[]).includes(name)) {
      out[name as (typeof BOUND_FACETS)[number]] = value.trim();
    } else if (name === 'whiteSpace' && (WHITESPACE as readonly string[]).includes(value.trim())) {
      out.whiteSpace = value.trim() as (typeof WHITESPACE)[number];
    }
  }
  if (enumeration.length > 0) {
    out.enumeration = enumeration;
  }
  // Only the narrowest values stay: a bound of this step replaces the other bound of the base on its side.
  for (const [mine, other] of [
    ['minInclusive', 'minExclusive'],
    ['minExclusive', 'minInclusive'],
    ['maxInclusive', 'maxExclusive'],
    ['maxExclusive', 'maxInclusive'],
  ] as const) {
    if (own.has(mine) && !own.has(other) && out[mine] !== undefined) delete out[other];
  }
  if (out.length !== undefined) {
    delete out.minLength;
    delete out.maxLength;
  }
  if (patterns.length > 0) {
    out.patterns = [...(base.patterns ?? []), patterns];
  }
  return out;
}

/** Reads the facets of simple types; a named type is read once. */
export class FacetReader {
  private readonly named = new Map<string, ValueFacets>();
  private readonly open = new Set<Element>();

  constructor(private readonly set: SchemaSet) {}

  /** The facets of a built-in or named simple type; those of `anySimpleType` for an unknown or circular one. */
  ofType(name: QName): ValueFacets {
    if (name.ns === XS) {
      return builtinFacets(name.local);
    }
    const id = `{${name.ns}}${name.local}`;
    const known = this.named.get(id);
    if (known) {
      return known;
    }
    const found = this.set.lookup('simpleType', name);
    const facets = found ? this.ofSimpleType(found.node) : builtinFacets('anySimpleType');
    this.named.set(id, facets);
    return facets;
  }

  /** The facets of an xs:simpleType element. */
  ofSimpleType(node: Element): ValueFacets {
    const derivation = xsChildren(node).find((c) => ['restriction', 'list', 'union'].includes(c.localName ?? ''));
    if (!derivation || this.open.has(node)) {
      return builtinFacets('anySimpleType');
    }
    this.open.add(node);
    try {
      return this.ofDerivation(derivation);
    } finally {
      this.open.delete(node);
    }
  }

  private ofDerivation(derivation: Element): ValueFacets {
    switch (derivation.localName) {
      case 'list': {
        const itemType = attr(derivation, 'itemType');
        const inline = xsChild(derivation, 'simpleType');
        const item =
          itemType !== undefined
            ? this.ofType(this.set.resolveQName(derivation, itemType))
            : inline
              ? this.ofSimpleType(inline)
              : builtinFacets('anySimpleType');
        return { builtin: 'anySimpleType', variety: 'list', item, whiteSpace: 'collapse' };
      }
      case 'union': {
        const named = (attr(derivation, 'memberTypes') ?? '')
          .split(/[ \t\n\r]+/)
          .filter((member) => member !== '')
          .map((member) => this.ofType(this.set.resolveQName(derivation, member)));
        const inline = xsChildren(derivation)
          .filter((c) => c.localName === 'simpleType')
          .map((c) => this.ofSimpleType(c));
        return { builtin: 'anySimpleType', variety: 'union', members: [...named, ...inline] };
      }
      default:
        return restrict(this.baseOf(derivation), facetsOf(derivation));
    }
  }

  /** The facets a restriction starts from: its base type, or the simple type written inside it. */
  baseOf(derivation: Element): ValueFacets {
    const inline = xsChild(derivation, 'simpleType');
    if (inline) {
      return this.ofSimpleType(inline);
    }
    const base = attr(derivation, 'base');
    return base === undefined ? builtinFacets('anySimpleType') : this.ofType(this.set.resolveQName(derivation, base));
  }
}

/** The facet elements of a restriction: its children apart from attributes, a simple type and annotations. */
export function facetsOf(derivation: Element): Element[] {
  const other = ['annotation', 'simpleType', 'attribute', 'attributeGroup', 'anyAttribute', 'assert', 'openContent'];
  return xsChildren(derivation).filter((c) => !other.includes(c.localName ?? ''));
}

/** Where a value comes from in ID/IDREF terms, from the built-in type its derivation ends at. */
export function idTypeOf(facets: ValueFacets): 'ID' | 'IDREF' | 'IDREFS' | 'ENTITY' | 'ENTITIES' | undefined {
  switch (facets.builtin) {
    case 'ID':
    case 'IDREF':
    case 'IDREFS':
    case 'ENTITY':
    case 'ENTITIES':
      return facets.builtin;
  }
  if (facets.variety === 'list' && facets.item?.builtin === 'IDREF') {
    return 'IDREFS';
  }
  return facets.variety === 'list' && facets.item?.builtin === 'ENTITY' ? 'ENTITIES' : undefined;
}
