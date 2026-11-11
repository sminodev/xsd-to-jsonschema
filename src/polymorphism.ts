// Which types a document may give an element with xsi:type, and which elements may stand in for another one in a
// substitution group. Both follow the derivations between named types: complex types derived by extension or
// restriction, simple types derived by restriction, and the built-in type hierarchy of XML Schema Part 2.

import type { Element } from '@xmldom/xmldom';
import {
  attr,
  clark,
  type Component,
  type QName,
  type SchemaDocument,
  type SchemaSet,
  XS,
  xsChild,
  xsChildren,
} from './schema-set.js';

/** The built-in simple types derived by restriction from another built-in type (XML Schema Part 2, 3.3). */
const BUILTIN_BASE: Record<string, string> = {
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
      return isTrue(attr(head.node, 'abstract')) ? [] : undefined;
    }
    const blocked = new Set(blockedBy(head.node, head.doc));
    const out: Component[] = isTrue(attr(head.node, 'abstract')) ? [] : [head];
    if (blocked.has('substitution')) {
      return out;
    }
    const headType = this.typeOf(head.node);
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
        const methods = this.memberMethods(member.node, headType);
        if (!methods.some((method) => blocked.has(method)) && !isTrue(attr(member.node, 'abstract'))) {
          out.push(member);
        }
        visit(memberId);
      }
    };
    visit(headId);
    return out;
  }

  /** The type an element declaration names, or takes from the head of its substitution group; undefined if anonymous. */
  typeName(node: Element, seen = new Set<Element>()): QName | undefined {
    const type = attr(node, 'type');
    if (type !== undefined) {
      return this.set.resolveQName(node, type);
    }
    if (xsChild(node, 'complexType') || xsChild(node, 'simpleType') || seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    const head = (attr(node, 'substitutionGroup') ?? '').split(/\s+/).find((q) => q.length > 0);
    const found = head === undefined ? undefined : this.set.lookup('element', this.set.resolveQName(node, head));
    return found ? this.typeName(found.node, seen) : undefined;
  }

  private build(): void {
    if (this.derived !== undefined) {
      return;
    }
    this.derived = new Map();
    this.bases = new Map();
    this.members = new Map();
    const add = (base: string, id: string, method: string): void => {
      this.derived?.set(base, [...(this.derived.get(base) ?? []), { id, method }]);
      this.bases?.set(id, { id: base, method });
    };
    for (const [id, { node }] of this.set.components.complexType) {
      const content = xsChild(node, 'complexContent') ?? xsChild(node, 'simpleContent');
      const derivation = content && xsChildren(content)[0];
      const base = derivation && attr(derivation, 'base');
      if (derivation && base !== undefined) {
        const name = this.set.resolveQName(derivation, base);
        add(clark(name.ns, name.local), id, derivation.localName ?? '');
      }
    }
    for (const [id, { node }] of this.set.components.simpleType) {
      const base = this.simpleBase(node);
      if (base) {
        add(clark(base.ns, base.local), id, 'restriction');
      }
    }
    for (const [local, base] of Object.entries(BUILTIN_BASE)) {
      add(clark(XS, base), clark(XS, local), 'restriction');
    }
    for (const member of this.set.components.element.values()) {
      for (const head of (attr(member.node, 'substitutionGroup') ?? '').split(/\s+/).filter((q) => q.length > 0)) {
        const name = this.set.resolveQName(member.node, head);
        const id = clark(name.ns, name.local);
        this.members.set(id, [...(this.members.get(id) ?? []), member]);
      }
    }
  }

  /** The named base of a simple type defined by restriction, through anonymous types written in place. */
  private simpleBase(node: Element): QName | undefined {
    const restriction = xsChild(node, 'restriction');
    if (!restriction) {
      return undefined;
    }
    const base = attr(restriction, 'base');
    if (base !== undefined) {
      return this.set.resolveQName(restriction, base);
    }
    const inner = xsChild(restriction, 'simpleType');
    return inner ? this.simpleBase(inner) : undefined;
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
    return found !== undefined && isTrue(attr(found.node, 'abstract'));
  }

  /** The named member types of a union type. */
  private unionMembers(id: string): string[] {
    const found = this.set.components.simpleType.get(id);
    const union = found && xsChild(found.node, 'union');
    return (union ? (attr(union, 'memberTypes') ?? '').split(/\s+/) : [])
      .filter((q) => q.length > 0)
      .map((q) => {
        const name = this.set.resolveQName(union as Element, q);
        return clark(name.ns, name.local);
      });
  }

  /** The type of an element declaration as an expanded name, for derivation checks; undefined if anonymous. */
  private typeOf(node: Element): string | undefined {
    const name = this.typeName(node);
    return name && clark(name.ns, name.local);
  }

  /**
   * The derivation methods from the type of an element declaration up to `base`. An anonymous type adds the method
   * of its own derivation to those from its base.
   */
  private memberMethods(node: Element, base: string | undefined): string[] {
    const named = this.typeOf(node);
    if (named !== undefined) {
      return this.methodsBetween(named, base);
    }
    const anonymous = xsChild(node, 'complexType') ?? xsChild(node, 'simpleType');
    const content = anonymous && (xsChild(anonymous, 'complexContent') ?? xsChild(anonymous, 'simpleContent'));
    const derivation = content ? xsChildren(content)[0] : anonymous && xsChild(anonymous, 'restriction');
    const own = derivation && attr(derivation, 'base');
    if (!derivation || own === undefined) {
      return [];
    }
    const name = this.set.resolveQName(derivation, own);
    return [derivation.localName ?? '', ...this.methodsBetween(clark(name.ns, name.local), base)];
  }

  /** The derivation methods on the way from `type` up to `base`; none if `type` doesn't derive from `base`. */
  private methodsBetween(type: string | undefined, base: string | undefined): string[] {
    const methods: string[] = [];
    for (let id = type, steps = 0; id !== undefined && id !== base && steps < 100; steps += 1) {
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

const isTrue = (value: string | undefined): boolean => value === 'true' || value === '1';

/** The derivation methods a declaration blocks, from its block attribute or the blockDefault of its schema. */
export function blockedBy(node: Element, doc: SchemaDocument): string[] {
  const value = attr(node, 'block') ?? attr(doc.root, 'blockDefault') ?? '';
  return value.includes('#all') ? ['extension', 'restriction', 'substitution'] : value.split(/\s+/);
}
