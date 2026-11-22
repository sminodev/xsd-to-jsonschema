// Which types a document may give an element with xsi:type, and which elements may stand in for another one in a
// substitution group. Both follow the derivations between named types: complex types derived by extension or
// restriction, simple types derived by restriction, and the built-in type hierarchy of XML Schema Part 2.

import type { Element } from '@xmldom/xmldom';
import {
  attr,
  booleanOf,
  clark,
  type Component,
  type QName,
  type SchemaDocument,
  type SchemaSet,
  XS,
  xsChild,
  xsChildren,
} from './schema-set.js';

const ANY_TYPE = clark(XS, 'anyType');
const ANY_SIMPLE_TYPE = { ns: XS, local: 'anySimpleType' };

/** The built-in simple types derived by restriction from another built-in type (XML Schema Part 2, 3.3). */
const BUILTIN_BASE: Record<string, string> = {
  anySimpleType: 'anyType',
  string: 'anySimpleType',
  boolean: 'anySimpleType',
  decimal: 'anySimpleType',
  float: 'anySimpleType',
  double: 'anySimpleType',
  duration: 'anySimpleType',
  dateTime: 'anySimpleType',
  time: 'anySimpleType',
  date: 'anySimpleType',
  gYearMonth: 'anySimpleType',
  gYear: 'anySimpleType',
  gMonthDay: 'anySimpleType',
  gDay: 'anySimpleType',
  gMonth: 'anySimpleType',
  hexBinary: 'anySimpleType',
  base64Binary: 'anySimpleType',
  anyURI: 'anySimpleType',
  QName: 'anySimpleType',
  NOTATION: 'anySimpleType',
  NMTOKENS: 'anySimpleType',
  IDREFS: 'anySimpleType',
  ENTITIES: 'anySimpleType',
  normalizedString: 'string',
  token: 'normalizedString',
  language: 'token',
  Name: 'token',
  NCName: 'Name',
  ID: 'NCName',
  IDREF: 'NCName',
  ENTITY: 'NCName',
  NMTOKEN: 'token',
  integer: 'decimal',
  nonPositiveInteger: 'integer',
  negativeInteger: 'nonPositiveInteger',
  long: 'integer',
  int: 'long',
  short: 'int',
  byte: 'short',
  nonNegativeInteger: 'integer',
  unsignedLong: 'nonNegativeInteger',
  unsignedInt: 'unsignedLong',
  unsignedShort: 'unsignedInt',
  unsignedByte: 'unsignedShort',
  positiveInteger: 'nonNegativeInteger',
};

/** A type that xsi:type may select. */
export interface TypeAlternative {
  /** expanded name, `{namespace}local` */
  id: string;
  name: QName;
  /** a complex type; otherwise a named or built-in simple type */
  complex: boolean;
}

interface Derivation {
  id: string;
  method: string;
}

export class Polymorphism {
  /** base type -> types derived directly from it */
  private derived: Map<string, Derivation[]> | undefined;
  /** type -> its base type and the derivation method */
  private bases: Map<string, Derivation> | undefined;
  /** head -> global elements that name it in substitutionGroup */
  private members: Map<string, Component[]> | undefined;

  constructor(private readonly set: SchemaSet) {}

  /**
   * The types xsi:type may select for an element of `type`: the type itself unless it is abstract, and the types
   * derived from it whose derivation methods `blocked` doesn't list, in breadth-first order. For a union, also its
   * member types and what derives from them.
   */
  alternatives(type: QName, blocked: Set<string>): TypeAlternative[] {
    this.build();
    const start = clark(type.ns, type.local);
    const out: TypeAlternative[] = [];
    const seen = new Set<string>();
    const queue = [start, ...this.unionMembers(start)];
    while (queue.length > 0) {
      const id = queue.shift() ?? '';
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const alternative = this.alternative(id);
      if (alternative && !this.isAbstract(id)) {
        out.push(alternative);
      }
      for (const derivation of this.derived?.get(id) ?? []) {
        if (!blocked.has(derivation.method)) {
          queue.push(derivation.id, ...this.unionMembers(derivation.id));
        }
      }
    }
    return out;
  }

  /**
   * The global elements that may appear where a particle refers to `head`: the head unless it is abstract, and the
   * members of its substitution group, also those of members, whose derivation from the head's type neither the head
   * nor that type blocks (XML Schema Part 1, 3.3.6). Undefined if the head has no members and isn't abstract.
   */
  substitutes(head: Component): Component[] | undefined {
    this.build();
    const headId = clark(head.doc.targetNamespace, attr(head.node, 'name') ?? '');
    if (!this.members?.has(headId)) {
      // An abstract element without members can't occur at all.
      return booleanOf(attr(head.node, 'abstract')) === true ? [] : undefined;
    }
    const blocked = new Set(blockedBy(head.node, head.doc));
    const out: Component[] = booleanOf(attr(head.node, 'abstract')) === true ? [] : [head];
    if (blocked.has('substitution')) {
      return out;
    }
    const headOwner = this.typeOwner(head.node);
    const headType = this.typeOf(headOwner);
    // The block of the head's complex type, or the blockDefault of its schema, applies to its derived types.
    const headComplex = headType === undefined ? undefined : this.set.components.complexType.get(headType);
    for (const method of headComplex ? blockedBy(headComplex.node, headComplex.doc) : []) {
      if (method === 'extension' || method === 'restriction') {
        blocked.add(method);
      }
    }
    const seen = new Set<string>([headId]);
    const visit = (id: string): void => {
      for (const member of this.members?.get(id) ?? []) {
        const memberId = clark(member.doc.targetNamespace, attr(member.node, 'name') ?? '');
        if (seen.has(memberId)) {
          continue;
        }
        seen.add(memberId);
        const owner = this.typeOwner(member.node);
        const methods = owner === headOwner ? [] : this.memberMethods(owner, headType);
        if (
          methods &&
          !methods.some((method) => blocked.has(method)) &&
          booleanOf(attr(member.node, 'abstract')) !== true
        ) {
          out.push(member);
        }
        visit(memberId);
      }
    };
    visit(headId);
    return out;
  }

  /** The type an element declaration names, or takes from the head of its substitution group; undefined if anonymous. */
  typeName(node: Element): QName | undefined {
    return this.namedType(this.typeOwner(node));
  }

  private namedType(owner: Element): QName | undefined {
    const type = attr(owner, 'type');
    return type === undefined ? undefined : this.set.resolveQName(owner, type);
  }

  /** The element that supplies the type, either directly or through substitution-group affiliation. */
  typeOwner(node: Element): Element {
    const seen = new Set<Element>();
    while (!seen.has(node)) {
      seen.add(node);
      if (attr(node, 'type') !== undefined || xsChild(node, 'complexType') || xsChild(node, 'simpleType')) {
        break;
      }
      const head = (attr(node, 'substitutionGroup') ?? '').split(/[ \t\n\r]+/).find((q) => q.length > 0);
      const found = head === undefined ? undefined : this.set.lookup('element', this.set.resolveQName(node, head));
      if (!found) {
        break;
      }
      node = found.node;
    }
    return node;
  }

  private build(): void {
    if (this.derived !== undefined) {
      return;
    }
    const derived = (this.derived = new Map<string, Derivation[]>());
    const bases = (this.bases = new Map<string, Derivation>());
    this.members = new Map();
    const add = (base: string, id: string, method: string): void => {
      const alternatives = derived.get(base);
      if (alternatives) {
        alternatives.push({ id, method });
      } else {
        derived.set(base, [{ id, method }]);
      }
      bases.set(id, { id: base, method });
    };
    for (const [id, { node }] of this.set.components.complexType) {
      const content = xsChild(node, 'complexContent') ?? xsChild(node, 'simpleContent');
      const derivation = content && xsChildren(content)[0];
      const base = derivation && attr(derivation, 'base');
      if (derivation && base !== undefined) {
        const name = this.set.resolveQName(derivation, base);
        add(clark(name.ns, name.local), id, derivation.localName ?? '');
      } else {
        add(ANY_TYPE, id, 'restriction');
      }
    }
    for (const [id, { node }] of this.set.components.simpleType) {
      const base = this.simpleBase(node);
      add(clark(base.ns, base.local), id, 'restriction');
    }
    for (const [local, base] of Object.entries(BUILTIN_BASE)) {
      add(clark(XS, base), clark(XS, local), 'restriction');
    }
    for (const member of this.set.components.element.values()) {
      for (const head of (attr(member.node, 'substitutionGroup') ?? '')
        .split(/[ \t\n\r]+/)
        .filter((q) => q.length > 0)) {
        const name = this.set.resolveQName(member.node, head);
        const id = clark(name.ns, name.local);
        this.members.set(id, [...(this.members.get(id) ?? []), member]);
      }
    }
  }

  /** The named base of a simple type defined by restriction, through anonymous types written in place. */
  private simpleBase(node: Element): QName {
    const restriction = xsChild(node, 'restriction');
    if (!restriction) {
      return ANY_SIMPLE_TYPE;
    }
    const base = attr(restriction, 'base');
    if (base !== undefined) {
      return this.set.resolveQName(restriction, base);
    }
    const inner = xsChild(restriction, 'simpleType');
    return inner ? this.simpleBase(inner) : ANY_SIMPLE_TYPE;
  }

  private alternative(id: string): TypeAlternative | undefined {
    const name = { ns: id.slice(1, id.indexOf('}')), local: id.slice(id.indexOf('}') + 1) };
    if (this.set.lookup('complexType', name)) {
      return { id, name, complex: true };
    }
    if (this.set.lookup('simpleType', name) || (name.ns === XS && name.local !== 'anyType')) {
      return { id, name, complex: false };
    }
    return undefined;
  }

  private isAbstract(id: string): boolean {
    const found = this.set.components.complexType.get(id);
    return found !== undefined && booleanOf(attr(found.node, 'abstract')) === true;
  }

  /** The named member types of a union type. */
  private unionMembers(id: string): string[] {
    const found = this.set.components.simpleType.get(id);
    const union = found && xsChild(found.node, 'union');
    return (union ? (attr(union, 'memberTypes') ?? '').split(/[ \t\n\r]+/) : [])
      .filter((q) => q.length > 0)
      .map((q) => {
        const name = this.set.resolveQName(union as Element, q);
        return clark(name.ns, name.local);
      });
  }

  /** The effective named type of an element, including the implicit xs:anyType. */
  private typeOf(owner: Element): string | undefined {
    const name = this.namedType(owner);
    if (name) {
      return clark(name.ns, name.local);
    }
    return xsChild(owner, 'complexType') || xsChild(owner, 'simpleType') ? undefined : ANY_TYPE;
  }

  /** The methods in a member's type derivation, starting with the method of its anonymous type where present. */
  private memberMethods(owner: Element, base: string | undefined): string[] | undefined {
    const named = this.typeOf(owner);
    if (named !== undefined) {
      return this.methodsBetween(named, base);
    }
    const complex = xsChild(owner, 'complexType');
    const simple = xsChild(owner, 'simpleType');
    if (simple) {
      const name = this.simpleBase(simple);
      const inherited = this.methodsBetween(clark(name.ns, name.local), base);
      return inherited && ['restriction', ...inherited];
    }
    const content = complex && (xsChild(complex, 'complexContent') ?? xsChild(complex, 'simpleContent'));
    const derivation = content && xsChildren(content)[0];
    const own = derivation && attr(derivation, 'base');
    if (!derivation || own === undefined) {
      return base === ANY_TYPE ? ['restriction'] : [];
    }
    const name = this.set.resolveQName(derivation, own);
    const inherited = this.methodsBetween(clark(name.ns, name.local), base);
    return inherited && [derivation.localName ?? '', ...inherited];
  }

  /** The derivation methods up to the base; undefined when the chain is circular. */
  private methodsBetween(type: string, base: string | undefined): string[] | undefined {
    const methods: string[] = [];
    const seen = new Set<string>();
    for (let id = type; id !== base;) {
      if (seen.has(id)) {
        return undefined;
      }
      seen.add(id);
      const step = this.bases?.get(id);
      if (!step) {
        return [];
      }
      methods.push(step.method);
      id = step.id;
    }
    return methods;
  }
}

/** The derivation methods a declaration blocks, from its block attribute or the blockDefault of its schema. */
export function blockedBy(node: Element, doc: SchemaDocument): string[] {
  const value = attr(node, 'block') ?? attr(doc.root, 'blockDefault') ?? '';
  return value.includes('#all') ? ['extension', 'restriction', 'substitution'] : value.split(/[ \t\n\r]+/);
}
