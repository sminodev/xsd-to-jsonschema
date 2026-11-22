// The structure report of `describeSchema()`: the XML Schema of one root element as a tree of particles, with what the JSON
// Schema leaves out or flattens (the order of a sequence, compositors, wildcards, identity constraints, raw facets),
// and for each node the place of its property in the JSON Schema. docs/structure.md describes the result.
//
// The tree is read from the XML Schema itself; the property names come from the emitter, which records the final
// names of every object it writes. Types are listed once by id, so a recursive type is a reference, not an endless
// tree.

import type { Element, Node } from '@xmldom/xmldom';
import { constraintOf, intersect, union, type WildcardInEffect } from './attribute-wildcard.js';
import { emptyContent, type GroupKeys, occurs, type Recorder } from './content-model.js';
import { attributeKey, elementKey } from './keys.js';
import { blockedBy, Polymorphism } from './polymorphism.js';
import type { Problems } from './problems.js';
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
import { builtinFacets, FacetReader, facetsOf, idTypeOf, restrict, type ValueFacets } from './value-facets.js';

/** Where a node is written in the XML Schema. */
export interface Source {
  file?: string;
  line?: number;
  column?: number;
}

export type Cardinality = number | 'unbounded';

export interface ElementNode {
  kind: 'element';
  /** the expanded name, `{namespace}local` */
  name: string;
  /** the root only: its path, `/{namespace}local` */
  path?: string;
  min: number;
  max: Cardinality;
  /** the name of its property in the object of the enclosing type; absent where no property is written */
  key?: string;
  /** JSON Pointer of its property, relative to the object of the enclosing type ('' for the root) */
  pointer?: string;
  /** the particle refers to a global element */
  global: boolean;
  /** the id of its type in `Structure.types`, or a built-in type as `{http://www.w3.org/2001/XMLSchema}name` */
  type: string;
  /** the facets of its value, or of the text of simple content, with the fixed value of the declaration */
  value?: ValueFacets;
  nillable: boolean;
  abstract: boolean;
  default?: string;
  fixed?: string;
  block?: string;
  final?: string;
  idType?: IdType;
  /** the other elements that may stand in for it in its substitution group */
  substitutes?: ElementNode[];
  /** the types xsi:type may select, as ids; present when there is a choice */
  typeAlternatives?: string[];
  identity?: IdentityConstraint[];
  source: Source;
  /** indexes into the problems of the result */
  problems?: number[];
}

export interface AttributeNode {
  kind: 'attribute';
  name: string;
  /** the declaration is global: a global attribute, or a reference to one */
  global: boolean;
  use: 'required' | 'optional';
  type: string;
  value: ValueFacets;
  default?: string;
  fixed?: string;
  idType?: IdType;
  key?: string;
  pointer?: string;
  /** the attribute group it comes from, `{namespace}name` */
  group?: string;
  source: Source;
  problems?: number[];
}

export interface GroupNode {
  kind: 'sequence' | 'choice' | 'all';
  min: number;
  max: Cardinality;
  particles: Particle[];
  /** a reference to a named model group, `{namespace}name` */
  ref?: string;
  /** a group that repeats is one property, an array with an object per occurrence */
  key?: string;
  pointer?: string;
  source: Source;
  problems?: number[];
}

export interface Wildcard {
  /** as written: `##any`, `##other`, `##local`, `##targetNamespace` or a list of namespaces */
  namespace: string;
  processContents: 'strict' | 'lax' | 'skip';
  /** the target namespace the wildcard is read against */
  targetNamespace: string;
  source: Source;
  problems?: number[];
}

export interface WildcardNode extends Wildcard {
  kind: 'any';
  min: number;
  max: Cardinality;
}

export type Particle = ElementNode | GroupNode | WildcardNode;

export interface ComplexType {
  kind: 'complex';
  id: string;
  /** the expanded name of a named type */
  name?: string;
  /**
   * the declaration an anonymous type belongs to: an element as its expanded name `{namespace}local`, an attribute
   * as `@{namespace}local`. It names the kind and name of the declaration, not a unique id: local declarations of the
   * same name share it.
   */
  owner?: string;
  /** where its object is written as a definition (`/$defs/…`), or '' for the anonymous type of the root */
  pointer?: string;
  abstract: boolean;
  mixed: boolean;
  block?: string;
  final?: string;
  derivation?: { base: string; method: 'extension' | 'restriction' };
  attributes: AttributeNode[];
  /** the attribute wildcards that apply: of the type, its attribute groups and, for an extension, its base */
  anyAttribute?: Wildcard[];
  /** the attribute wildcard in effect, as XML Schema combines those of `anyAttribute` */
  attributeWildcard?: WildcardInEffect;
  /** the content model in effect; for an extension a sequence of the base's and its own */
  content?: GroupNode;
  /** simple content: the text property */
  text?: { key?: string; pointer?: string; value: ValueFacets };
  /** what the report can't state for sure about this type, such as an attribute wildcard XML Schema 1.0 can't express */
  uncertain?: Uncertainty[];
  source: Source;
  problems?: number[];
}

export interface Uncertainty {
  code: 'attribute-wildcard' | 'mixed' | 'occurrences';
  message: string;
}

/** The attribute wildcard in effect for a list of attributes, or why it is uncertain. */
interface EffectiveWildcard {
  wildcard?: WildcardInEffect;
  uncertain?: string;
}

const ANY_TYPE_WILDCARD: WildcardInEffect = { namespaces: { any: true }, processContents: 'lax' };

export interface SimpleType {
  kind: 'simple';
  id: string;
  name?: string;
  /** as for a complex type: `{namespace}local` for an element, `@{namespace}local` for an attribute */
  owner?: string;
  pointer?: string;
  /** the id of the type a restriction derives from */
  base?: string;
  facets: ValueFacets;
  idType?: IdType;
  source: Source;
  problems?: number[];
}

export type IdType = 'ID' | 'IDREF' | 'IDREFS' | 'ENTITY' | 'ENTITIES';

export interface IdentityConstraint {
  kind: 'key' | 'keyref' | 'unique';
  name: string;
  selector: string;
  fields: string[];
  /** a keyref: the key or unique constraint it refers to */
  refer?: string;
  /** the namespaces of the prefixes the XPaths use */
  namespaces: Record<string, string>;
  source: Source;
}

export interface Structure {
  root: ElementNode;
  /** complex and simple types by id: `{namespace}local` for a named type, `#1`, `#2` … for an anonymous one */
  types: Record<string, ComplexType | SimpleType>;
  /** the global declarations of the whole schema set, as wildcards may take them */
  globals: {
    /** the expanded names of the global elements */
    elements: string[];
    /** the global attributes, each as an attribute node */
    attributes: AttributeNode[];
  };
  /** problems without a place in the tree */
  unplaced: number[];
}

/** The final property names of each object the emitter writes. */
export class ObjectRecorder implements Recorder {
  readonly objects = new Map<Element, { plan: Map<string, string>; groupKeys: GroupKeys }>();

  object(node: Element, plan: Map<string, string>, groupKeys: GroupKeys): void {
    if (!this.objects.has(node)) {
      this.objects.set(node, { plan, groupKeys });
    }
  }
}

/** Where the properties of one object are: the final names, the keys of its groups, and its pointer. */
interface Context {
  plan: Map<string, string> | undefined;
  groupKeys: GroupKeys | undefined;
  prefix: string;
}

const NO_CONTEXT: Context = { plan: undefined, groupKeys: undefined, prefix: '' };
const IDENTITY_CONSTRAINTS = ['key', 'keyref', 'unique'];

const cardinality = (max: number): Cardinality => (max === Infinity ? 'unbounded' : max);
const escape = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');

interface Owner {
  problems?: number[];
}

/** The structure report would grow beyond `maxStructureSize`. */
export class StructureLimitExceeded extends Error {
  override name = 'StructureLimitExceeded';
}

/**
 * The size of a value of the report in structure units: every value counts 1 (object, array, number, boolean or string),
 * every field name of an object 1, and a string its length as well. `maxStructureSize` bounds the whole report in this
 * unit. It is no measure of memory.
 */
export function structureSize(value: unknown): number {
  if (typeof value === 'string') {
    return 1 + value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum: number, item) => sum + structureSize(item), 1);
  }
  if (value !== null && typeof value === 'object') {
    let size = 1;
    for (const item of Object.values(value)) {
      size += 1 + structureSize(item);
    }
    return size;
  }
  return value === undefined ? 0 : 1;
}

/**
 * The size of a node without its parts that are counted as they are made: the items of the arrays in `arrays` (the
 * array itself counts) and the objects in `objects`.
 */
function ownSize(node: object, arrays: readonly string[], objects: readonly string[] = []): number {
  let size = 1;
  for (const [key, item] of Object.entries(node)) {
    size += 1 + (arrays.includes(key) ? 1 : objects.includes(key) ? 0 : structureSize(item));
  }
  return size;
}

export class StructureBuilder {
  private readonly poly: Polymorphism;
  private readonly facets: FacetReader;
  private readonly types: Record<string, ComplexType | SimpleType> = {};
  private readonly anonymous = new Map<Element, string>();
  private readonly owners = new Map<Node, Owner[]>();
  private rootId = '';
  /** where the content of the type being read collects what it can't state for sure */
  private uncertainContent: Uncertainty[] | undefined;
  private readonly invalidOccurs = new Map<Element, Uncertainty>();
  /** the structure units of the report made so far, for `maxStructureSize` */
  private units = 0;
  /** the nodes of the report counted, whose problem indexes count as `place` adds them */
  private readonly inReport = new WeakSet<object>();
  /** inside a pass that reads the attributes of a base again, which count only once they are taken over */
  private quiet = 0;

  constructor(
    private readonly set: SchemaSet,
    private readonly problems: Problems,
    private readonly recorder: ObjectRecorder,
    /** the name of a definition in `$defs`, as the emitter allocated it */
    private readonly definitionName: (kind: string, id: string) => string | undefined,
    private readonly textProperty: string,
  ) {
    this.poly = new Polymorphism(set);
    this.facets = new FacetReader(set);
  }

  /**
   * Counts a particle before it joins the tree and before anything inside it is read; its children in `children`
   * count by themselves. Stops when the report would grow beyond `maxStructureSize`.
   */
  private counted<T extends object>(node: T, children: readonly string[] = []): T {
    this.inReport.add(node);
    this.add(ownSize(node, children));
    return node;
  }

  /** Counts an attribute or attribute wildcard as it joins a list of the report, unless a base is read again. */
  private item<T extends object>(node: T): T {
    if (this.quiet === 0) {
      this.inReport.add(node);
      this.add(structureSize(node));
    }
    return node;
  }

  /** Counts a type entry once it is complete: its particles and attributes count by themselves. */
  private entryCounted(entry: ComplexType | SimpleType): void {
    this.inReport.add(entry);
    // the name in `types`, then the entry
    this.add(1 + ownSize(entry, ['attributes', 'anyAttribute'], ['content']));
  }

  private add(units: number): void {
    this.units += units;
    const limit = this.set.limits.maxStructureSize;
    if (this.units > limit) {
      throw new StructureLimitExceeded(
        `the structure report exceeds the limit of ${limit} structure units (maxStructureSize)`,
      );
    }
  }

  /** The structure of a root element. Problems the reading finds are already in the list; it adds none. */
  build(root: Component): Structure {
    const length = this.problems.list.length;
    try {
      const name = clark(root.doc.targetNamespace, attr(root.node, 'name') ?? '');
      this.rootId = name;
      const node = this.element(root.node, root.doc, name, root.node, NO_CONTEXT, true);
      node.min = 1;
      node.max = 1;
      node.path = `/${name}`;
      node.pointer = '';
      delete node.key;
      // The root's substitutes may be the root of a document instead; the schema of this root has no place for them.
      const others = (this.poly.substitutes(root) ?? []).filter((member) => member.node !== root.node);
      if (others.length > 0) {
        node.substitutes = others.map((member) => {
          const memberName = clark(member.doc.targetNamespace, attr(member.node, 'name') ?? '');
          const sub = this.element(member.node, member.doc, memberName, member.node, NO_CONTEXT, true);
          delete sub.key;
          delete sub.pointer;
          return this.counted(sub, ['substitutes']);
        });
      }
      tidy(node, ELEMENT_ORDER);
      this.counted(node, ['substitutes']);
      const globals = this.globals();
      // The report itself with its four fields, the object of the types, and the globals with their two lists.
      this.add(1 + 4 + 1 + 1 + 2 + structureSize(globals.elements) + 1);
      const unplaced = this.place(length);
      this.add(structureSize(unplaced));
      return { root: node, types: this.types, globals, unplaced };
    } finally {
      this.problems.truncate(length);
    }
  }

  /** The global elements by name and the global attributes with their types and values, sorted by name. */
  private globals(): Structure['globals'] {
    const elements = [...this.set.components.element.keys()].sort();
    const attributes: AttributeNode[] = [];
    for (const [name, component] of [...this.set.components.attribute].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      // Counted once it is taken.
      this.quiet += 1;
      let read: ReturnType<StructureBuilder['attribute']>;
      try {
        read = this.attribute(component.node, component.doc, NO_CONTEXT, undefined, true);
      } finally {
        this.quiet -= 1;
      }
      if (read?.kind === 'attribute' && read.name === name) attributes.push(this.item(read));
    }
    return { elements, attributes };
  }

  // --- problems ------------------------------------------------------------------------------------------------

  private own(node: Node, owner: Owner): void {
    const list = this.owners.get(node);
    if (list) {
      if (!list.includes(owner)) {
        list.push(owner);
      }
    } else {
      this.owners.set(node, [owner]);
    }
  }

  /** Associates the first `count` problems with their nearest report nodes and returns those without a node. */
  private place(count: number): number[] {
    const unplaced: number[] = [];
    this.problems.nodes.slice(0, count).forEach((at, index) => {
      let owners: Owner[] | undefined;
      for (let node: Node | null | undefined = at; node && !owners; node = node.parentNode) {
        owners = this.owners.get(node);
      }
      if (!owners) {
        unplaced.push(index);
        return;
      }
      for (const owner of owners) {
        if (this.inReport.has(owner)) {
          // a new array under the name `problems`, then the index
          this.add(owner.problems ? 1 : 3);
        }
        (owner.problems ??= []).push(index);
      }
    });
    return unplaced;
  }

  private source(node: Element): Source {
    const out: Source = {};
    const file = this.set.pathOf(node);
    if (file !== undefined) {
      out.file = file;
    }
    if (node.lineNumber !== undefined) {
      out.line = node.lineNumber;
    }
    if (node.columnNumber !== undefined) {
      out.column = node.columnNumber;
    }
    return out;
  }

  // --- elements ------------------------------------------------------------------------------------------------

  /**
   * An element declaration where `particle` uses it.
   *
   * @param name - its expanded name
   */
  private element(
    decl: Element,
    doc: SchemaDocument,
    name: string,
    particle: Element,
    context: Context,
    global: boolean,
  ): ElementNode {
    const { min, max } = this.occurs(particle);
    const end = name.indexOf('}');
    const key = context.plan?.get(elementKey(name.slice(1, end), name.slice(end + 1)));
    const node: ElementNode = {
      kind: 'element',
      name,
      min,
      max: cardinality(max),
      global,
      type: '',
      nillable: booleanOf(attr(decl, 'nillable')) === true,
      abstract: booleanOf(attr(decl, 'abstract')) === true,
      source: this.source(decl),
    };
    if (key !== undefined) {
      node.key = key;
      node.pointer = `${context.prefix}/properties/${escape(key)}`;
    }
    this.own(decl, node);
    this.own(particle, node);
    for (const keyword of ['default', 'fixed'] as const) {
      const value = attr(decl, keyword);
      if (value !== undefined) {
        node[keyword] = value;
      }
    }
    // block and final in effect: the attribute, or the default of the schema document; final only applies to globals.
    const block = attr(decl, 'block') ?? attr(doc.root, 'blockDefault');
    const final = global ? (attr(decl, 'final') ?? attr(doc.root, 'finalDefault')) : undefined;
    if (block !== undefined) {
      node.block = block;
    }
    if (final !== undefined) {
      node.final = final;
    }
    const typeOwner = this.poly.typeOwner(decl);
    const typeName = this.poly.typeName(typeOwner);
    const anonymousComplex = xsChild(typeOwner, 'complexType');
    const anonymousSimple = xsChild(typeOwner, 'simpleType');
    const ownerDoc = this.set.documentOf(typeOwner) ?? doc;
    const ownerName = typeOwner === decl ? name : clark(ownerDoc.targetNamespace, attr(typeOwner, 'name') ?? '');
    let value: ValueFacets | undefined;
    if (typeName !== undefined) {
      node.type = this.typeId(typeName);
      const entry = this.types[node.type];
      value = entry?.kind === 'simple' ? entry.facets : entry?.kind === 'complex' ? entry.text?.value : undefined;
      if (typeName.ns === XS && typeName.local !== 'anyType') {
        value = builtinFacets(typeName.local);
      }
      const alternatives = this.alternatives(decl, doc, typeName);
      if (alternatives) {
        node.typeAlternatives = alternatives;
      }
    } else if (anonymousComplex) {
      node.type = this.anonymousComplex(anonymousComplex, ownerDoc, ownerName, global, name);
      const entry = this.types[node.type];
      value = entry?.kind === 'complex' ? entry.text?.value : undefined;
    } else if (anonymousSimple) {
      node.type = this.anonymousSimple(anonymousSimple, ownerName);
      const entry = this.types[node.type];
      value = entry?.kind === 'simple' ? entry.facets : undefined;
    } else {
      node.type = clark(XS, 'anyType');
    }
    if (value) {
      node.value = node.fixed === undefined ? value : { ...value, fixed: node.fixed };
      const idType = idTypeOf(value);
      if (idType) {
        node.idType = idType;
      }
    }
    const identity = xsChildren(decl)
      .filter((child) => IDENTITY_CONSTRAINTS.includes(child.localName ?? ''))
      .map((child) => this.identity(child, doc));
    if (identity.length > 0) {
      node.identity = identity;
    }
    return tidy(node, ELEMENT_ORDER);
  }

  /** The types xsi:type may select for an element of `type`, if there is more than the declared one. */
  private alternatives(decl: Element, doc: SchemaDocument, type: QName): string[] | undefined {
    if (type.ns === XS && (type.local === 'anyType' || type.local === 'anySimpleType')) {
      return undefined;
    }
    const complex = this.set.lookup('complexType', type);
    const blocked = new Set([...blockedBy(decl, doc), ...(complex ? blockedBy(complex.node, complex.doc) : [])]);
    const ids = this.poly.alternatives(type, blocked).map((alternative) => alternative.id);
    const own = clark(type.ns, type.local);
    if (!ids.some((id) => id !== own)) {
      return undefined;
    }
    for (const id of ids) {
      const end = id.indexOf('}');
      this.typeId({ ns: id.slice(1, end), local: id.slice(end + 1) });
    }
    return ids;
  }

  private identity(node: Element, doc: SchemaDocument): IdentityConstraint {
    const selector = attr(xsChild(node, 'selector') ?? node, 'xpath') ?? '';
    const fields = xsChildren(node)
      .filter((child) => child.localName === 'field')
      .map((child) => attr(child, 'xpath') ?? '');
    const out: IdentityConstraint = {
      kind: node.localName as IdentityConstraint['kind'],
      name: clark(doc.targetNamespace, attr(node, 'name') ?? ''),
      selector,
      fields,
      namespaces: {},
      source: this.source(node),
    };
    const refer = attr(node, 'refer');
    if (refer !== undefined) {
      const name = this.set.resolveQName(node, refer);
      out.refer = clark(name.ns, name.local);
    }
    for (const xpath of [selector, ...fields]) {
      for (const match of xpath.matchAll(/(?<![\w.:-])([A-Za-z_][\w.-]*):(?!:)/g)) {
        const prefix = match[1] ?? '';
        const uri = node.lookupNamespaceURI(prefix);
        if (uri) {
          out.namespaces[prefix] = uri;
        }
      }
    }
    return out;
  }

  // --- types ---------------------------------------------------------------------------------------------------

  /** The id of a named or built-in type, describing a named one the first time. */
  private typeId(name: QName): string {
    const id = clark(name.ns, name.local);
    if (name.ns === XS || this.types[id]) {
      return id;
    }
    const complex = this.set.lookup('complexType', name);
    const simple = complex ? undefined : this.set.lookup('simpleType', name);
    if (!complex && !simple) {
      return id;
    }
    const definition = this.definitionName('type', id);
    const pointer = definition === undefined ? undefined : `/$defs/${escape(definition)}`;
    if (complex) {
      this.complexType(complex.node, complex.doc, id, { name: id, pointer });
    } else if (simple) {
      this.simpleType(simple.node, id, { name: id, pointer });
    }
    return id;
  }

  private nextId(node: Element): string {
    let id = this.anonymous.get(node);
    if (id === undefined) {
      id = `#${this.anonymous.size + 1}`;
      this.anonymous.set(node, id);
    }
    return id;
  }

  private anonymousComplex(
    node: Element,
    doc: SchemaDocument,
    owner: string,
    global: boolean,
    elementName: string,
  ): string {
    const known = this.anonymous.get(node);
    if (known !== undefined) {
      return known;
    }
    const id = this.nextId(node);
    let pointer: string | undefined;
    if (global && elementName === this.rootId) {
      pointer = '';
    } else if (global) {
      const definition = this.definitionName('element', owner);
      pointer = definition === undefined ? undefined : `/$defs/${escape(definition)}`;
    } else {
      // A local type the emitter could not write in place (it contains itself, or nests very deep).
      const where = `${this.set.pathOf(node) ?? ''}:${node.lineNumber ?? 0}:${node.columnNumber ?? 0}`;
      const definition = this.definitionName('local', `${owner} ${where}`);
      pointer = definition === undefined ? undefined : `/$defs/${escape(definition)}`;
    }
    this.complexType(node, doc, id, { owner, pointer });
    return id;
  }

  private anonymousSimple(node: Element, owner: string): string {
    const known = this.anonymous.get(node);
    if (known !== undefined) {
      return known;
    }
    const id = this.nextId(node);
    this.simpleType(node, id, { owner });
    return id;
  }

  private simpleType(
    node: Element,
    id: string,
    naming: { name?: string; owner?: string; pointer?: string | undefined },
  ): void {
    const facets = this.facets.ofSimpleType(node);
    const entry: SimpleType = { kind: 'simple', id, ...defined(naming), facets, source: this.source(node) };
    // Listed before its base is read, so a type that derives from itself refers to this entry.
    this.types[id] = entry;
    this.own(node, entry);
    const restriction = xsChild(node, 'restriction');
    const base = restriction && attr(restriction, 'base');
    if (base !== undefined) {
      entry.base = this.typeId(this.set.resolveQName(restriction as Element, base));
    } else if (restriction) {
      const inline = xsChild(restriction, 'simpleType');
      if (inline) {
        entry.base = this.anonymousSimple(inline, naming.name ?? naming.owner ?? '');
      }
    }
    const collection = xsChild(node, 'list') ?? xsChild(node, 'union');
    if (collection) {
      if (collection.localName === 'list') {
        const item = attr(collection, 'itemType');
        if (item !== undefined) {
          this.typeId(this.set.resolveQName(collection, item));
        }
      } else {
        for (const name of (attr(collection, 'memberTypes') ?? '').split(/[ \t\n\r]+/).filter(Boolean)) {
          this.typeId(this.set.resolveQName(collection, name));
        }
      }
      for (const inline of xsChildren(collection)) {
        if (inline.localName === 'simpleType') {
          this.anonymousSimple(inline, naming.name ?? naming.owner ?? '');
        }
      }
    }
    const idType = idTypeOf(facets);
    if (idType) {
      entry.idType = idType;
    }
    tidy(entry, SIMPLE_ORDER);
    this.entryCounted(entry);
  }

  private complexType(
    node: Element,
    doc: SchemaDocument,
    id: string,
    naming: { name?: string; owner?: string; pointer?: string | undefined },
  ): void {
    const entry: ComplexType = {
      kind: 'complex',
      id,
      ...defined(naming),
      abstract: booleanOf(attr(node, 'abstract')) === true,
      mixed: false,
      attributes: [],
      source: this.source(node),
    };
    // Listed before its content is read, so a type that contains itself refers to this entry.
    this.types[id] = entry;
    this.own(node, entry);
    for (const keyword of ['block', 'final'] as const) {
      const value = attr(node, keyword) ?? attr(doc.root, `${keyword}Default`);
      if (value !== undefined) {
        entry[keyword] = value;
      }
    }
    const recorded = this.recorder.objects.get(node);
    const context: Context = { plan: recorded?.plan, groupKeys: recorded?.groupKeys, prefix: '' };
    const simpleContent = xsChild(node, 'simpleContent');
    const complexContent = xsChild(node, 'complexContent');
    const derivation = (simpleContent ?? complexContent) && xsChildren((simpleContent ?? complexContent) as Element)[0];
    // mixed on complexContent decides where it is written; otherwise mixed on complexType; otherwise false
    // (XML Schema 1.0, Structures 3.4.2).
    const contentMixed = complexContent && attr(complexContent, 'mixed');
    entry.mixed = booleanOf(contentMixed !== undefined ? contentMixed : attr(node, 'mixed')) === true;
    const uncertain: Uncertainty[] = [];
    if (derivation && (derivation.localName === 'extension' || derivation.localName === 'restriction')) {
      const base = this.set.resolveQName(derivation, attr(derivation, 'base') ?? '');
      entry.derivation = { base: this.typeId(base), method: derivation.localName };
      // An extension without content of its own and without mixed has the content type of its base, mixed included.
      if (
        complexContent &&
        derivation.localName === 'extension' &&
        !entry.mixed &&
        emptyContent(derivation, this.set)
      ) {
        const inherited = this.types[entry.derivation.base];
        if (base.ns === XS && base.local === 'anyType') {
          entry.mixed = true;
        } else if (inherited?.kind === 'complex') {
          entry.mixed = inherited.mixed;
        } else {
          uncertain.push({
            code: 'mixed',
            message: `whether the content is mixed depends on the unknown type ${entry.derivation.base}`,
          });
        }
      }
    }
    const { attributes, wildcards, effective } = this.attributesOf(node, doc, context, new Set(), entry);
    entry.attributes = attributes;
    if (wildcards.length > 0) {
      entry.anyAttribute = wildcards;
    }
    if (effective.wildcard) {
      entry.attributeWildcard = effective.wildcard;
    }
    if (effective.uncertain !== undefined) {
      uncertain.push({ code: 'attribute-wildcard', message: effective.uncertain });
    }
    if (uncertain.length > 0) {
      entry.uncertain = uncertain;
    }
    if (simpleContent) {
      const value = this.textOf(node, new Set());
      const key = context.plan?.get(this.textProperty);
      entry.text = { value };
      if (key !== undefined) {
        entry.text = { key, pointer: `/properties/${escape(key)}`, value };
      }
      this.entryCounted(entry);
      return;
    }
    const outer = this.uncertainContent;
    this.uncertainContent = uncertain;
    try {
      const content = this.contentOf(node, doc, context, new Set());
      if (content) {
        entry.content = content;
      }
    } finally {
      this.uncertainContent = outer;
    }
    if (uncertain.length > 0) {
      entry.uncertain = uncertain;
    }
    this.entryCounted(entry);
  }

  /** The occurrences of a particle; written values that aren't valid count as once and make the content uncertain. */
  private occurs(node: Element): { min: number; max: number } {
    const min = attr(node, 'minOccurs')?.trim();
    const max = attr(node, 'maxOccurs')?.trim();
    const read = occurs(node);
    const validMin = min === undefined || /^[0-9]+$/.test(min);
    const validMax = max === undefined || max === 'unbounded' || /^[0-9]+$/.test(max);
    if (validMin && validMax && read.min <= read.max) {
      return read;
    }
    const at = node.lineNumber === undefined ? '' : ` on line ${node.lineNumber}`;
    const uncertainty = this.invalidOccurs.get(node) ?? {
      code: 'occurrences',
      message: `minOccurs="${min ?? '1'}" and maxOccurs="${max ?? '1'}"${at} are not valid occurrences`,
    };
    this.invalidOccurs.set(node, uncertainty);
    if (this.uncertainContent && !this.uncertainContent.includes(uncertainty)) {
      this.uncertainContent.push(uncertainty);
    }
    const first = validMin ? read.min : 1;
    return { min: first, max: validMax && read.max >= first ? read.max : first };
  }

  /** The content model in effect for a complex type, following extensions to their bases. */
  private contentOf(node: Element, doc: SchemaDocument, context: Context, seen: Set<Element>): GroupNode | undefined {
    if (seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    const complexContent = xsChild(node, 'complexContent');
    const derivation = complexContent && xsChildren(complexContent)[0];
    const owner = derivation ?? node;
    const model = xsChildren(owner).find((c) => ['sequence', 'all', 'choice', 'group'].includes(c.localName ?? ''));
    const own = model && occurs(model).max > 0 ? this.particle(model, doc, context, new Set()) : undefined;
    if (derivation?.localName !== 'extension') {
      return own?.kind === 'any' || own?.kind === 'element' ? undefined : own;
    }
    const baseName = this.set.resolveQName(derivation, attr(derivation, 'base') ?? '');
    const base = this.set.lookup('complexType', baseName);
    // The content of anyType: any elements, each validated where a declaration exists.
    const anyContent = (): GroupNode => {
      const any = this.counted<WildcardNode>({
        kind: 'any',
        namespace: '##any',
        processContents: 'lax',
        targetNamespace: doc.targetNamespace,
        source: this.source(derivation),
        min: 0,
        max: 'unbounded',
      });
      return this.counted<GroupNode>(
        { kind: 'sequence', min: 1, max: 1, particles: [any], source: this.source(derivation) },
        ['particles'],
      );
    };
    const inherited = base
      ? this.contentOf(base.node, base.doc, context, seen)
      : baseName.ns === XS && baseName.local === 'anyType'
        ? anyContent()
        : undefined;
    const group = own?.kind === 'any' || own?.kind === 'element' ? undefined : own;
    if (!inherited || !group) {
      return inherited ?? group;
    }
    return this.counted<GroupNode>(
      { kind: 'sequence', min: 1, max: 1, particles: [inherited, group], source: this.source(derivation) },
      ['particles'],
    );
  }

  /** The facets of the text of a complex type with simple content. */
  private textOf(node: Element, seen: Set<Element>): ValueFacets {
    const simpleContent = xsChild(node, 'simpleContent');
    const derivation = simpleContent && xsChildren(simpleContent)[0];
    if (!derivation || seen.has(node)) {
      return builtinFacets('string');
    }
    seen.add(node);
    const name = this.set.resolveQName(derivation, attr(derivation, 'base') ?? '');
    const complex = name.ns === XS ? undefined : this.set.lookup('complexType', name);
    let base = complex ? this.textOf(complex.node, seen) : this.facets.ofType(name);
    if (derivation.localName !== 'restriction') {
      return base;
    }
    const inline = xsChild(derivation, 'simpleType');
    if (inline) {
      base = this.facets.ofSimpleType(inline);
    }
    return restrict(base, facetsOf(derivation));
  }

  // --- particles -----------------------------------------------------------------------------------------------

  private particle(child: Element, doc: SchemaDocument, context: Context, seen: Set<Element>): Particle | undefined {
    const { min, max } = this.occurs(child);
    if (max === 0) {
      return undefined;
    }
    switch (child.localName) {
      case 'element':
        return this.elementParticle(child, doc, context);
      case 'any': {
        const node: WildcardNode = { kind: 'any', ...this.wildcard(child, doc), min, max: cardinality(max) };
        this.own(child, node);
        return this.counted(node);
      }
      case 'sequence':
      case 'choice':
      case 'all':
      case 'group':
        return this.group(child, doc, context, seen);
      default:
        return undefined;
    }
  }

  private elementParticle(child: Element, doc: SchemaDocument, context: Context): ElementNode | undefined {
    const ref = attr(child, 'ref');
    if (ref === undefined) {
      const form = attr(child, 'form');
      const qualified = form === undefined ? doc.elementQualified : form === 'qualified';
      const name = clark(qualified ? doc.targetNamespace : '', attr(child, 'name') ?? '');
      return this.counted(this.element(child, doc, name, child, context, false));
    }
    const head = this.set.lookup('element', this.set.resolveQName(child, ref));
    if (!head) {
      return undefined;
    }
    const nameOf = (c: Component): string => clark(c.doc.targetNamespace, attr(c.node, 'name') ?? '');
    const members = this.poly.substitutes(head);
    const node = this.element(head.node, head.doc, nameOf(head), child, context, true);
    if (members !== undefined) {
      const others = members.filter((member) => member.node !== head.node);
      if (others.length > 0) {
        node.substitutes = others.map((member) =>
          this.counted(this.element(member.node, member.doc, nameOf(member), child, context, true)),
        );
      }
      if (!members.some((member) => member.node === head.node)) {
        delete node.key;
        delete node.pointer;
      }
    }
    return this.counted(node, ['substitutes']);
  }

  private group(child: Element, doc: SchemaDocument, context: Context, seen: Set<Element>): GroupNode | undefined {
    const { min, max } = this.occurs(child);
    let compositor: Element | undefined = child;
    let compositorDoc = doc;
    let definition: Component | undefined;
    let inner = seen;
    if (child.localName === 'group') {
      definition = this.set.lookupRef('group', this.set.resolveQName(child, attr(child, 'ref') ?? ''), child);
      if (!definition || seen.has(definition.node)) {
        return undefined;
      }
      inner = new Set([...seen, definition.node]);
      compositor = xsChildren(definition.node).find((c) => ['sequence', 'choice', 'all'].includes(c.localName ?? ''));
      compositorDoc = definition.doc;
      if (!compositor) {
        return undefined;
      }
    }
    const node: GroupNode = {
      kind: compositor.localName as GroupNode['kind'],
      min,
      max: cardinality(max),
      particles: [],
      source: this.source(child),
    };
    if (definition) {
      node.ref = clark(definition.doc.targetNamespace, attr(definition.node, 'name') ?? '');
      this.own(definition.node, node);
    }
    this.own(child, node);
    let own = context;
    if (max > 1) {
      // A repeated group is one property, an array whose items are objects with names of their own.
      const groupKey = context.groupKeys?.get(definition?.node ?? child);
      const key = groupKey === undefined ? undefined : (context.plan?.get(groupKey) ?? groupKey);
      const recorded = this.recorder.objects.get(child);
      if (key !== undefined && context.plan) {
        node.key = key;
        node.pointer = `${context.prefix}/properties/${escape(key)}`;
        own = { plan: recorded?.plan, groupKeys: recorded?.groupKeys, prefix: `${node.pointer}/items` };
      } else {
        own = NO_CONTEXT;
      }
    }
    this.counted(node, ['particles']);
    for (const particle of xsChildren(compositor)) {
      const described = this.particle(particle, compositorDoc, own, inner);
      if (described) {
        node.particles.push(described);
      }
    }
    return node;
  }

  private wildcard(node: Element, doc: SchemaDocument): Wildcard {
    const process = attr(node, 'processContents');
    const out: Wildcard = {
      namespace: (attr(node, 'namespace') ?? '##any').trim(),
      processContents: process === 'lax' || process === 'skip' ? process : 'strict',
      targetNamespace: doc.targetNamespace,
      source: this.source(node),
    };
    return out;
  }

  // --- attributes ----------------------------------------------------------------------------------------------

  /** The attributes of a complex type in effect, inherited ones included, and the attribute wildcards. */
  private attributesOf(
    node: Element,
    doc: SchemaDocument,
    context: Context,
    seen: Set<Element>,
    entry: Owner,
  ): { attributes: AttributeNode[]; wildcards: Wildcard[]; effective: EffectiveWildcard } {
    seen.add(node);
    const content = xsChild(node, 'simpleContent') ?? xsChild(node, 'complexContent');
    const derivation = content && xsChildren(content)[0];
    if (!derivation) {
      const own = this.attributeList(node, doc, context, new Set(), entry);
      return {
        attributes: own.attributes.filter((a): a is AttributeNode => a.kind === 'attribute'),
        wildcards: own.wildcards,
        effective: own.complete,
      };
    }
    const baseName = this.set.resolveQName(derivation, attr(derivation, 'base') ?? '');
    const base = this.set.lookup('complexType', baseName);
    // The base's attributes are read again here; those taken over count below, once overriding is settled.
    this.quiet += 1;
    let inherited: ReturnType<StructureBuilder['attributesOf']> | undefined;
    try {
      inherited =
        base && !seen.has(base.node) ? this.attributesOf(base.node, base.doc, context, seen, entry) : undefined;
    } finally {
      this.quiet -= 1;
    }
    const own = this.attributeList(derivation, doc, context, new Set(), entry);
    const byName = new Map<string, AttributeNode | { kind: 'prohibited'; name: string }>(
      (inherited?.attributes ?? []).map((a) => [a.name, a]),
    );
    for (const attribute of own.attributes) {
      byName.set(attribute.name, attribute);
    }
    const attributes = [...byName.values()].filter((a): a is AttributeNode => a.kind === 'attribute');
    const taken = new Set(inherited?.attributes ?? []);
    for (const attribute of attributes) {
      if (taken.has(attribute)) {
        this.item(attribute);
      }
    }
    // An attribute of the derivation that a later one of the same name replaces is not in the report.
    const kept = new Set(attributes);
    for (const attribute of own.attributes) {
      if (attribute.kind === 'attribute' && !kept.has(attribute) && this.inReport.delete(attribute)) {
        this.units -= structureSize(attribute);
      }
    }
    const wildcards =
      derivation.localName === 'extension'
        ? [...(inherited?.wildcards ?? []).map((w) => this.item(w)), ...own.wildcards]
        : own.wildcards;
    if (derivation.localName !== 'extension') {
      return { attributes, wildcards, effective: own.complete };
    }
    // An extension adds the wildcard of its base: that of anyType allows every attribute.
    const fromBase: EffectiveWildcard =
      baseName.ns === XS && baseName.local === 'anyType'
        ? { wildcard: ANY_TYPE_WILDCARD }
        : (inherited?.effective ?? {});
    return { attributes, wildcards, effective: joined(own.complete, fromBase) };
  }

  /** The attributes written on a complex type or derivation, with attribute groups expanded. */
  private attributeList(
    owner: Element,
    doc: SchemaDocument,
    context: Context,
    seen: Set<Element>,
    entry: Owner,
    group?: string,
  ): {
    attributes: (AttributeNode | { kind: 'prohibited'; name: string })[];
    wildcards: Wildcard[];
    complete: EffectiveWildcard;
  } {
    const attributes: (AttributeNode | { kind: 'prohibited'; name: string })[] = [];
    const wildcards: Wildcard[] = [];
    let local: Wildcard | undefined;
    const groups: EffectiveWildcard[] = [];
    for (const child of xsChildren(owner)) {
      if (child.localName === 'attribute') {
        const attribute = this.attribute(child, doc, context, group);
        // A prohibited attribute in an attribute group corresponds to nothing; only the restriction removes one.
        if (attribute && (attribute.kind === 'attribute' || group === undefined)) {
          attributes.push(attribute);
        }
      } else if (child.localName === 'attributeGroup') {
        // What goes wrong in an attribute group, or in a reference to one, concerns the types that use it.
        this.own(child, entry);
        const found = this.set.lookupRef(
          'attributeGroup',
          this.set.resolveQName(child, attr(child, 'ref') ?? ''),
          child,
        );
        if (found && !seen.has(found.node)) {
          this.own(found.node, entry);
          const name = clark(found.doc.targetNamespace, attr(found.node, 'name') ?? '');
          const inner = this.attributeList(found.node, found.doc, context, new Set([...seen, found.node]), entry, name);
          // One by one: a spread of a long list would exceed the number of arguments a call takes.
          for (const attribute of inner.attributes) {
            attributes.push(attribute);
          }
          for (const wildcard of inner.wildcards) {
            wildcards.push(wildcard);
          }
          groups.push(inner.complete);
        }
      } else if (child.localName === 'anyAttribute') {
        const wildcard = this.wildcard(child, doc);
        this.own(child, wildcard);
        wildcards.push(this.item(wildcard));
        local = wildcard;
      }
    }
    return { attributes, wildcards, complete: complete(local, groups) };
  }

  private attribute(
    node: Element,
    doc: SchemaDocument,
    context: Context,
    group: string | undefined,
    global = false,
  ): AttributeNode | { kind: 'prohibited'; name: string } | undefined {
    const ref = attr(node, 'ref');
    let decl = node;
    let ns: string;
    if (global) {
      // A global attribute always has the target namespace of its schema document, whatever its form defaults say.
      ns = doc.targetNamespace;
    } else if (ref !== undefined) {
      const global = this.set.lookup('attribute', this.set.resolveQName(node, ref));
      if (!global) {
        return undefined;
      }
      decl = global.node;
      ns = global.doc.targetNamespace;
    } else {
      const form = attr(node, 'form');
      const qualified = form === undefined ? doc.attributeQualified : form === 'qualified';
      ns = qualified ? doc.targetNamespace : '';
    }
    const local = attr(decl, 'name') ?? '';
    const name = clark(ns, local);
    const use = attr(node, 'use') ?? 'optional';
    if (use === 'prohibited') {
      return { kind: 'prohibited', name };
    }
    const typeName = attr(decl, 'type');
    const anonymous = xsChild(decl, 'simpleType');
    let type: string;
    let facets: ValueFacets;
    if (typeName !== undefined) {
      const qname = this.set.resolveQName(decl, typeName);
      type = this.typeId(qname);
      const entry = this.types[type];
      facets = entry?.kind === 'simple' ? entry.facets : this.facets.ofType(qname);
    } else if (anonymous) {
      type = this.anonymousSimple(anonymous, `@${name}`);
      const entry = this.types[type];
      facets = entry?.kind === 'simple' ? entry.facets : builtinFacets('anySimpleType');
    } else {
      type = clark(XS, 'anySimpleType');
      facets = builtinFacets('anySimpleType');
    }
    const valueNode = attr(node, 'fixed') !== undefined || attr(node, 'default') !== undefined ? node : decl;
    const fixed = attr(valueNode, 'fixed');
    const fallback = attr(valueNode, 'default');
    const out: AttributeNode = {
      kind: 'attribute',
      name,
      global: global || ref !== undefined,
      use: use === 'required' ? 'required' : 'optional',
      type,
      value: fixed === undefined ? facets : { ...facets, fixed },
      source: this.source(decl),
    };
    if (fallback !== undefined) {
      out.default = fallback;
    }
    if (fixed !== undefined) {
      out.fixed = fixed;
    }
    const idType = idTypeOf(facets);
    if (idType) {
      out.idType = idType;
    }
    const key = context.plan?.get(attributeKey(ns, local));
    if (key !== undefined) {
      out.key = key;
      out.pointer = `/properties/${escape(key)}`;
    }
    if (group !== undefined) {
      out.group = group;
    }
    tidy(out, ATTRIBUTE_ORDER);
    this.own(node, out);
    this.own(decl, out);
    return this.item(out);
  }
}

/** The order of the properties of a node in the output, the most telling first; the rest keep their place. */
const ELEMENT_ORDER = ['kind', 'name', 'path', 'min', 'max', 'key', 'pointer', 'global', 'type', 'value'];
const SIMPLE_ORDER = ['kind', 'id', 'name', 'owner', 'pointer', 'base', 'facets', 'idType'];
const ATTRIBUTE_ORDER = ['kind', 'name', 'global', 'use', 'key', 'pointer', 'type', 'value'];

/** Puts the properties of `node` in `order`, followed by the others and `source` last; keeps the object itself. */
function tidy<T extends object>(node: T, order: readonly string[]): T {
  const record = node as Record<string, unknown>;
  const keys = [...order.filter((key) => key in record), ...Object.keys(record).filter((key) => !order.includes(key))];
  for (const key of [...keys.filter((key) => key !== 'source'), 'source']) {
    if (key in record) {
      const value = record[key];
      delete record[key];
      record[key] = value;
    }
  }
  return node;
}

/** The properties of `naming` that are defined. */
function defined(naming: { name?: string; owner?: string; pointer?: string | undefined }): {
  name?: string;
  owner?: string;
  pointer?: string;
} {
  const out: { name?: string; owner?: string; pointer?: string } = {};
  if (naming.name !== undefined) {
    out.name = naming.name;
  }
  if (naming.owner !== undefined) {
    out.owner = naming.owner;
  }
  if (naming.pointer !== undefined) {
    out.pointer = naming.pointer;
  }
  return out;
}

/**
 * The complete wildcard of a type or attribute group: its own and those of its attribute groups intersected, with the
 * processContents of its own, or else of the first group's.
 */
function complete(local: Wildcard | undefined, groups: EffectiveWildcard[]): EffectiveWildcard {
  const uncertain = groups.find((g) => g.uncertain !== undefined)?.uncertain;
  const parts = [
    ...(local ? [{ namespaces: constraintOf(local), processContents: local.processContents }] : []),
    ...groups.flatMap((g) => (g.wildcard ? [g.wildcard] : [])),
  ];
  const [first, ...rest] = parts;
  if (!first) {
    return uncertain === undefined ? {} : { uncertain };
  }
  let namespaces: WildcardInEffect['namespaces'] | undefined = first.namespaces;
  for (const part of rest) {
    namespaces = namespaces && intersect(namespaces, part.namespaces);
  }
  if (!namespaces) {
    return {
      uncertain: 'the attribute wildcards of the type and its attribute groups have no expressible intersection',
    };
  }
  const wildcard = { namespaces, processContents: first.processContents };
  return uncertain === undefined ? { wildcard } : { wildcard, uncertain };
}

/** The wildcard of an extension: its own complete wildcard joined with its base's, with its own processContents. */
function joined(own: EffectiveWildcard, base: EffectiveWildcard): EffectiveWildcard {
  const uncertain = own.uncertain ?? base.uncertain;
  const result = (wildcard?: WildcardInEffect): EffectiveWildcard => ({
    ...(wildcard ? { wildcard } : {}),
    ...(uncertain === undefined ? {} : { uncertain }),
  });
  if (!own.wildcard || !base.wildcard) {
    return result(own.wildcard ?? base.wildcard);
  }
  const namespaces = union(own.wildcard.namespaces, base.wildcard.namespaces);
  if (!namespaces) {
    return { uncertain: 'the attribute wildcards of the extension and its base have no expressible union' };
  }
  return result({ namespaces, processContents: own.wildcard.processContents });
}
