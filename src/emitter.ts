import type { Element } from '@xmldom/xmldom';
import type { JsonSchema, XmlAnnotation } from './json-schema.js';
import type { At, Problems } from './problems.js';
import {
  attr,
  clark,
  type Component,
  documentation,
  type QName,
  type SchemaDocument,
  type SchemaSet,
  XS,
  xsChild,
  xsChildren,
} from './schema-set.js';
import { lexicalToJson, type SimpleTypeOptions, type SimpleTypeRef, SimpleTypes } from './simple-types.js';

export const SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export interface EmitterOptions extends SimpleTypeOptions {
  /** write the `xml` annotations */
  xml: boolean;
  /** property for the text of an element with simple content */
  textProperty: string;
}

/** A property of an object, from an element particle or the text of simple content. */
interface Prop {
  key: string;
  schema: JsonSchema;
  node: Element;
}

/** A property from an attribute; `prohibited` attributes remove an inherited one. */
type AttributeProp = { key: string; prohibited: true } | (Prop & { required: boolean; prohibited?: false });

/** What a model group contributes to an object, with the properties it requires when it occurs once. */
interface Fragment {
  /** in document order */
  props: Prop[];
  required: string[];
  /** one `{oneOf}` per choice */
  constraints: JsonSchema[];
  dependentRequired: Record<string, string[]>;
  /** the fragment is a choice reached through a group reference */
  isChoice?: boolean;
}

interface ElementDeclaration {
  name: string;
  ns: string;
  node: Element;
  doc: SchemaDocument;
  docs: string | undefined;
  global: boolean;
}

function emptyFragment(): Fragment {
  return { props: [], required: [], constraints: [], dependentRequired: {} };
}

function occurs(node: Element): { min: number; max: number } {
  const min = attr(node, 'minOccurs');
  const max = attr(node, 'maxOccurs');
  return {
    min: min === undefined ? 1 : Number(min),
    max: max === undefined ? 1 : max === 'unbounded' ? Infinity : Number(max),
  };
}

/**
 * Writes JSON Schema 2020-12 for one root element of a schema set. docs/output.md describes the result.
 */
export class Emitter {
  private readonly simple: SimpleTypes;
  /** definition name -> schema, in the order of first use */
  private readonly defs = new Map<string, JsonSchema>();
  /** component id -> definition name */
  private readonly names = new Map<string, string>();
  private readonly pending: { name: string; build: () => JsonSchema }[] = [];
  private rootId: string | undefined;

  constructor(
    private readonly set: SchemaSet,
    private readonly problems: Problems,
    private readonly options: EmitterOptions,
  ) {
    this.simple = new SimpleTypes(set, problems, options);
  }

  private at(node: Element): At {
    return { file: this.set.pathOf(node), node };
  }

  /** The schema of a global element: its content in place, with all definitions it reaches. */
  root(root: Component): JsonSchema {
    const name = attr(root.node, 'name') ?? '';
    this.rootId = clark(root.doc.targetNamespace, name);
    const decl = this.globalElement(root.node, root.doc);
    // The root describes the element content in place, even when its type is a named complex type.
    const typeName = attr(root.node, 'type');
    const named =
      typeName !== undefined ? this.set.lookup('complexType', this.set.resolveQName(root.node, typeName)) : undefined;
    const content = named ? this.complexType(named.node, named.doc) : this.declarationType(decl, true);
    for (let job = this.pending.shift(); job; job = this.pending.shift()) {
      this.defs.set(job.name, job.build());
    }
    const schema: JsonSchema = { $schema: SCHEMA_2020_12 };
    const description = decl.docs || content.description;
    if (description) {
      schema.description = description;
    }
    Object.assign(schema, without(content, 'description'));
    if (this.options.xml) {
      const xml: XmlAnnotation = { name };
      if (root.doc.targetNamespace) {
        xml.namespace = root.doc.targetNamespace;
      }
      schema.xml = xml;
    }
    if (this.defs.size > 0) {
      schema.$defs = Object.fromEntries(this.defs);
    }
    return schema;
  }

  // --- definitions ---------------------------------------------------------------------------------------------

  /** A `$ref` to the definition of a component; the definition is written once, after the current one. */
  private ref(kind: string, id: string, label: string, build: () => JsonSchema): JsonSchema {
    let name = this.names.get(`${kind} ${id}`);
    if (name === undefined) {
      name = this.allocate(label, id);
      this.names.set(`${kind} ${id}`, name);
      this.pending.push({ name, build });
    }
    return { $ref: `#/$defs/${pointerEscape(name)}` };
  }

  // The local name if it is free; otherwise the local name with a label of its namespace.
  private allocate(local: string, id: string): string {
    const used = new Set(this.names.values());
    if (!used.has(local)) {
      return local;
    }
    const label = namespaceLabel(id.slice(1, id.indexOf('}')));
    let name = label ? `${label}.${local}` : local;
    for (let i = 2; used.has(name); i += 1) {
      name = `${label ? `${label}.` : ''}${local}-${i}`;
    }
    return name;
  }

  private typeRef(name: QName, atNode: Element): JsonSchema {
    if (name.ns === XS) {
      return name.local === 'anyType' ? {} : this.simple.schema(name);
    }
    const id = clark(name.ns, name.local);
    const complex = this.set.lookup('complexType', name);
    if (complex) {
      return this.ref('type', id, name.local, () => this.complexType(complex.node, complex.doc));
    }
    const simple = this.set.lookup('simpleType', name);
    if (simple) {
      return this.ref('type', id, name.local, () => this.namedSimpleType(simple.node));
    }
    this.problems.error('unknown-type', `type {${name.ns}}${name.local} is not defined`, this.at(atNode));
    return {};
  }

  private namedSimpleType(node: Element): JsonSchema {
    const schema = this.simple.schema(node);
    const docs = documentation(node);
    return docs ? { description: docs, ...schema } : schema;
  }

  // --- declarations --------------------------------------------------------------------------------------------

  private globalElement(node: Element, doc: SchemaDocument): ElementDeclaration {
    return {
      name: attr(node, 'name') ?? '',
      ns: doc.targetNamespace,
      node,
      doc,
      docs: documentation(node),
      global: true,
    };
  }

  /** An element particle as a declaration: local, or a reference to a global element. */
  private elementDeclaration(node: Element, doc: SchemaDocument): ElementDeclaration | undefined {
    const ref = attr(node, 'ref');
    if (ref !== undefined) {
      const name = this.set.resolveQName(node, ref);
      const global = this.set.lookup('element', name);
      if (!global) {
        this.problems.error('unknown-element', `element {${name.ns}}${name.local} is not defined`, this.at(node));
        return undefined;
      }
      const decl = this.globalElement(global.node, global.doc);
      decl.docs = documentation(node) || decl.docs;
      return decl;
    }
    const form = attr(node, 'form');
    const qualified = form === undefined ? doc.elementQualified : form === 'qualified';
    return {
      name: attr(node, 'name') ?? '',
      ns: qualified ? doc.targetNamespace : '',
      node,
      doc,
      docs: documentation(node),
      global: false,
    };
  }

  /**
   * The schema of the content of an element declaration, with `const` and `default` from fixed and default values.
   *
   * @param inline - write the anonymous complex type of a global element in place (for the root)
   */
  private declarationType(decl: ElementDeclaration, inline = false): JsonSchema {
    const node = decl.node;
    for (const unsupported of ['substitutionGroup', 'abstract', 'nillable']) {
      const value = attr(node, unsupported);
      if (value !== undefined && value !== 'false') {
        this.problems.error('unsupported-element', `${unsupported} on an element is not supported`, this.at(node));
      }
    }
    const typeName = attr(node, 'type');
    const anonymousComplex = xsChild(node, 'complexType');
    const anonymousSimple = xsChild(node, 'simpleType');
    let schema: JsonSchema;
    let valueType: SimpleTypeRef | undefined;
    if (typeName !== undefined) {
      const name = this.set.resolveQName(node, typeName);
      schema = this.typeRef(name, node);
      if (this.set.lookup('simpleType', name) || name.ns === XS) {
        valueType = name;
      }
    } else if (anonymousComplex) {
      const id = clark(decl.ns, decl.name);
      if (decl.global && !inline && id === this.rootId) {
        schema = { $ref: '#' };
      } else if (decl.global && !inline) {
        schema = this.ref('element', id, decl.name, () => this.complexType(anonymousComplex, decl.doc));
      } else {
        schema = this.complexType(anonymousComplex, decl.doc);
      }
    } else if (anonymousSimple) {
      schema = this.simple.schema(anonymousSimple);
      valueType = anonymousSimple;
    } else {
      schema = {};
    }
    return this.withValues(schema, node, valueType);
  }

  private withValues(schema: JsonSchema, node: Element, valueType: SimpleTypeRef | undefined): JsonSchema {
    const fixed = attr(node, 'fixed');
    const fallback = attr(node, 'default');
    if (fixed === undefined && fallback === undefined) {
      return schema;
    }
    if (valueType === undefined) {
      this.problems.error(
        'unsupported-value',
        'fixed or default on an element with complex content is not supported',
        this.at(node),
      );
      return schema;
    }
    const json = this.simple.jsonType(valueType);
    const out: JsonSchema = { ...schema };
    for (const [keyword, lexical] of [
      ['const', fixed],
      ['default', fallback],
    ] as const) {
      if (lexical === undefined) {
        continue;
      }
      const value = lexicalToJson(json, lexical);
      if ('error' in value) {
        this.problems.error('invalid-value', value.error, this.at(node));
      } else {
        out[keyword] = value.value;
      }
    }
    return out;
  }

  /** The property of an element particle: content, description, `xml`, and an array for repetition. */
  private elementProperty(node: Element, doc: SchemaDocument): Prop | undefined {
    const decl = this.elementDeclaration(node, doc);
    if (!decl) {
      return undefined;
    }
    const { min, max } = occurs(node);
    let schema = this.declarationType(decl);
    const xml: XmlAnnotation | undefined = this.options.xml && decl.ns ? { namespace: decl.ns } : undefined;
    if (max > 1) {
      const array: JsonSchema = {};
      if (decl.docs) {
        array.description = decl.docs;
      }
      array.type = 'array';
      array.items = schema;
      if (min > 0) {
        array.minItems = min;
      }
      if (max !== Infinity) {
        array.maxItems = max;
      }
      if (xml) {
        array.xml = xml;
      }
      schema = array;
    } else {
      schema = annotate(schema, decl.docs, xml);
    }
    return { key: decl.name, schema, node };
  }

  private attributeProperty(node: Element, doc: SchemaDocument): AttributeProp | undefined {
    const ref = attr(node, 'ref');
    let decl = node;
    let ns: string;
    if (ref !== undefined) {
      const name = this.set.resolveQName(node, ref);
      const global = this.set.lookup('attribute', name);
      if (!global) {
        if (name.ns !== XML_NS) {
          this.problems.error('unknown-attribute', `attribute {${name.ns}}${name.local} is not defined`, this.at(node));
        }
        return undefined;
      }
      decl = global.node;
      ns = global.doc.targetNamespace;
    } else {
      const form = attr(node, 'form');
      const qualified = form === undefined ? doc.attributeQualified : form === 'qualified';
      ns = qualified ? doc.targetNamespace : '';
    }
    const key = attr(decl, 'name') ?? '';
    const use = attr(node, 'use') ?? 'optional';
    if (use === 'prohibited') {
      return { key, prohibited: true };
    }
    const typeName = attr(decl, 'type');
    const anonymous = xsChild(decl, 'simpleType');
    let schema: JsonSchema;
    let valueType: SimpleTypeRef;
    if (typeName !== undefined) {
      valueType = this.set.resolveQName(decl, typeName);
      schema = this.typeRef(valueType, decl);
    } else if (anonymous) {
      valueType = anonymous;
      schema = this.simple.schema(anonymous);
    } else {
      valueType = { ns: XS, local: 'anySimpleType' };
      schema = {};
    }
    // Values written on the reference win over those of the declaration.
    const valueNode = attr(node, 'fixed') !== undefined || attr(node, 'default') !== undefined ? node : decl;
    schema = this.withValues(schema, valueNode, valueType);
    const xml: XmlAnnotation | undefined = this.options.xml
      ? { ...(ns ? { namespace: ns } : {}), attribute: true }
      : undefined;
    const docs = documentation(node) || (decl !== node ? documentation(decl) : undefined);
    return { key, schema: annotate(schema, docs, xml), node, required: use === 'required' };
  }

  /** The attributes of a complex type or derivation, with attribute groups expanded. */
  private attributes(owner: Element, doc: SchemaDocument, seen = new Set<Element>()): AttributeProp[] {
    const out: AttributeProp[] = [];
    for (const child of xsChildren(owner)) {
      if (child.localName === 'attribute') {
        const prop = this.attributeProperty(child, doc);
        if (prop) {
          out.push(prop);
        }
      } else if (child.localName === 'attributeGroup') {
        const ref = attr(child, 'ref') ?? '';
        const group = this.set.lookup('attributeGroup', this.set.resolveQName(child, ref));
        if (!group) {
          this.problems.error('unknown-group', `attribute group ${ref} is not defined`, this.at(child));
        } else if (seen.has(group.node)) {
          this.problems.error('circular-group', `attribute group ${ref} refers to itself`, this.at(child));
        } else {
          out.push(...this.attributes(group.node, group.doc, new Set([...seen, group.node])));
        }
      } else if (child.localName === 'anyAttribute') {
        this.problems.warning(
          'unsupported-any',
          'xs:anyAttribute: other attributes are rejected (objects are closed)',
          this.at(child),
        );
      }
    }
    return out;
  }

  // --- content models ------------------------------------------------------------------------------------------

  /** The fragment of a model group (sequence, all or choice) when it occurs once. */
  private group(node: Element, doc: SchemaDocument, seen: Set<Element>): Fragment {
    if (node.localName === 'choice') {
      return this.choice(node, doc, false, seen);
    }
    const fragment = emptyFragment();
    for (const child of xsChildren(node)) {
      this.particle(child, doc, fragment, seen);
    }
    return fragment;
  }

  /** Adds one particle of a sequence or all to `fragment`. */
  private particle(child: Element, doc: SchemaDocument, fragment: Fragment, seen: Set<Element>): void {
    const { min, max } = occurs(child);
    switch (child.localName) {
      case 'element': {
        const prop = this.elementProperty(child, doc);
        if (prop) {
          this.addProp(fragment, prop);
          if (min > 0) {
            fragment.required.push(prop.key);
          }
        }
        return;
      }
      case 'sequence':
      case 'all':
      case 'choice':
      case 'group': {
        if (max > 1) {
          this.problems.error(
            'repeated-group',
            `a repeated ${child.localName} (maxOccurs ${max === Infinity ? 'unbounded' : max}) is written as if it occurred once`,
            this.at(child),
          );
        }
        let inner: Fragment | undefined;
        if (child.localName === 'group') {
          inner = this.groupReference(child, min === 0, seen);
        } else if (child.localName === 'choice') {
          inner = this.choice(child, doc, min === 0, seen);
        } else {
          inner = this.group(child, doc, seen);
        }
        if (!inner) {
          return;
        }
        if (min > 0 || child.localName === 'choice' || inner.isChoice) {
          this.merge(fragment, inner, true);
        } else {
          this.optionalGroup(fragment, inner, child);
        }
        return;
      }
      case 'any':
        this.problems.error('unsupported-any', 'xs:any is not supported; its elements are rejected', this.at(child));
        return;
      default:
        this.problems.error('unsupported-particle', `xs:${child.localName} is not supported here`, this.at(child));
    }
  }

  private groupReference(node: Element, optional: boolean, seen: Set<Element>): Fragment | undefined {
    const ref = attr(node, 'ref') ?? '';
    const found = this.set.lookup('group', this.set.resolveQName(node, ref));
    if (!found) {
      this.problems.error('unknown-group', `group ${ref} is not defined`, this.at(node));
      return undefined;
    }
    if (seen.has(found.node)) {
      this.problems.error('circular-group', `group ${ref} contains itself`, this.at(node));
      return undefined;
    }
    const compositor = xsChildren(found.node)[0];
    if (!compositor) {
      return emptyFragment();
    }
    const inner = new Set([...seen, found.node]);
    if (compositor.localName === 'choice') {
      const fragment = this.choice(compositor, found.doc, optional, inner);
      fragment.isChoice = true;
      return fragment;
    }
    return this.group(compositor, found.doc, inner);
  }

  // An optional sequence: its properties are optional, but once one of them occurs, the members it requires must too.
  private optionalGroup(fragment: Fragment, inner: Fragment, node: Element): void {
    if (inner.constraints.length > 0) {
      this.problems.error(
        'unsupported-optional-group',
        'a choice inside an optional sequence is written as if the sequence were required',
        this.at(node),
      );
      this.merge(fragment, inner, true);
      return;
    }
    this.merge(fragment, inner, false);
    if (inner.required.length === 0) {
      return;
    }
    for (const prop of inner.props) {
      const others = inner.required.filter((key) => key !== prop.key);
      if (others.length > 0) {
        const list = fragment.dependentRequired[prop.key] ?? [];
        fragment.dependentRequired[prop.key] = [...new Set([...list, ...others])];
      }
    }
  }

  /**
   * A choice becomes one `oneOf`. The properties of all branches belong to the enclosing object, so the object stays
   * closed and keeps the document order.
   */
  private choice(node: Element, doc: SchemaDocument, optional: boolean, seen: Set<Element>): Fragment {
    const branches: { fragment: Fragment; node: Element }[] = [];
    for (const child of xsChildren(node)) {
      const branch = emptyFragment();
      this.particle(child, doc, branch, seen);
      if (child.localName !== 'element' && occurs(child).min === 0) {
        branch.required = [];
      }
      branches.push({ fragment: branch, node: child });
    }
    const fragment = emptyFragment();
    const owner = new Map<string, Fragment>();
    for (const { fragment: branch, node: child } of branches) {
      for (const prop of branch.props) {
        if (owner.has(prop.key)) {
          this.problems.error('duplicate-name', `${prop.key} occurs in two branches of a choice`, this.at(child));
          continue;
        }
        owner.set(prop.key, branch);
        fragment.props.push(prop);
      }
    }
    const empty = branches.filter((b) => b.fragment.required.length === 0 && b.fragment.constraints.length === 0);
    if (empty.length > 1) {
      this.problems.error(
        'ambiguous-choice',
        'more than one branch of this choice can be empty; an empty object matches several branches',
        this.at(node),
      );
    }
    const oneOf = branches.map(({ fragment: branch }) => {
      const schema: JsonSchema = {};
      if (branch.required.length > 0) {
        schema.required = branch.required;
      }
      const others = fragment.props.filter((prop) => owner.get(prop.key) !== branch);
      if (others.length > 0) {
        schema.properties = Object.fromEntries(others.map((prop) => [prop.key, false]));
      }
      if (Object.keys(branch.dependentRequired).length > 0) {
        schema.dependentRequired = branch.dependentRequired;
      }
      addConstraints(schema, branch.constraints);
      return schema;
    });
    if (optional && empty.length === 0) {
      oneOf.push({ properties: Object.fromEntries(fragment.props.map((prop) => [prop.key, false])) });
    }
    fragment.constraints.push({ oneOf });
    return fragment;
  }

  private addProp(fragment: Fragment, prop: Prop): void {
    if (fragment.props.some((p) => p.key === prop.key)) {
      this.problems.error('duplicate-name', `${prop.key} occurs twice in one object`, this.at(prop.node));
      return;
    }
    fragment.props.push(prop);
  }

  private merge(fragment: Fragment, inner: Fragment, withRequired: boolean): void {
    for (const prop of inner.props) {
      this.addProp(fragment, prop);
    }
    if (withRequired) {
      fragment.required.push(...inner.required);
    }
    fragment.constraints.push(...inner.constraints);
    for (const [key, list] of Object.entries(inner.dependentRequired)) {
      fragment.dependentRequired[key] = [...new Set([...(fragment.dependentRequired[key] ?? []), ...list])];
    }
  }

  // --- complex types -------------------------------------------------------------------------------------------

  /** Properties and attributes of a complex type, following complexContent extensions to their bases. */
  private content(
    node: Element,
    doc: SchemaDocument,
    seen = new Set<Element>(),
  ): { fragment: Fragment; attributes: AttributeProp[] } {
    if (seen.has(node)) {
      this.problems.error('circular-type', 'circular complex type derivation', this.at(node));
      return { fragment: emptyFragment(), attributes: [] };
    }
    seen.add(node);
    if (attr(node, 'mixed') === 'true') {
      this.problems.error(
        'unsupported-mixed',
        'mixed content: the text between elements is not written',
        this.at(node),
      );
    }
    const simpleContent = xsChild(node, 'simpleContent');
    if (simpleContent) {
      return this.simpleContent(simpleContent, doc);
    }
    const complexContent = xsChild(node, 'complexContent');
    const derivation = complexContent ? xsChildren(complexContent)[0] : undefined;
    if (derivation) {
      const baseQName = attr(derivation, 'base') ?? '';
      const baseName = this.set.resolveQName(derivation, baseQName);
      const fragment = emptyFragment();
      let attributes: AttributeProp[] = [];
      const base = this.set.lookup('complexType', baseName);
      if (derivation.localName === 'extension') {
        if (base) {
          const inherited = this.content(base.node, base.doc, seen);
          this.merge(fragment, inherited.fragment, true);
          attributes = inherited.attributes;
        } else if (!(baseName.ns === XS && baseName.local === 'anyType')) {
          this.problems.error('unknown-type', `base type ${baseQName} is not defined`, this.at(derivation));
        }
      } else {
        attributes = base ? this.content(base.node, base.doc, seen).attributes : [];
      }
      this.compositor(derivation, doc, fragment);
      return { fragment, attributes: overrideAttributes(attributes, this.attributes(derivation, doc)) };
    }
    const fragment = emptyFragment();
    this.compositor(node, doc, fragment);
    return { fragment, attributes: this.attributes(node, doc).filter((a) => !a.prohibited) };
  }

  private compositor(owner: Element, doc: SchemaDocument, fragment: Fragment): void {
    const model = xsChildren(owner).find((c) => ['sequence', 'all', 'choice', 'group'].includes(c.localName ?? ''));
    if (model) {
      this.particle(model, doc, fragment, new Set());
    }
  }

  private simpleContent(node: Element, doc: SchemaDocument): { fragment: Fragment; attributes: AttributeProp[] } {
    const fragment = emptyFragment();
    const derivation = xsChildren(node)[0];
    if (!derivation) {
      return { fragment, attributes: [] };
    }
    if (derivation.localName !== 'extension') {
      this.problems.error(
        'unsupported-simple-content',
        'simpleContent restriction is not supported; the text is written as a string',
        this.at(derivation),
      );
    }
    const base = this.set.resolveQName(derivation, attr(derivation, 'base') ?? '');
    const complexBase = base.ns !== XS && this.set.lookup('complexType', base);
    let value: JsonSchema = complexBase ? { type: 'string' } : this.typeRef(base, derivation);
    if (this.options.xml) {
      value = { ...value, xml: { text: true } };
    }
    fragment.props.push({ key: this.options.textProperty, schema: value, node: derivation });
    fragment.required.push(this.options.textProperty);
    return { fragment, attributes: this.attributes(derivation, doc).filter((a) => !a.prohibited) };
  }

  /** The object schema of a complex type. */
  private complexType(node: Element, doc: SchemaDocument): JsonSchema {
    const { fragment, attributes } = this.content(node, doc);
    const schema: JsonSchema = {};
    const docs = documentation(node);
    if (docs) {
      schema.description = docs;
    }
    schema.type = 'object';
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const attribute of attributes) {
      if (attribute.prohibited) {
        continue;
      }
      properties[attribute.key] = attribute.schema;
      if (attribute.required) {
        required.push(attribute.key);
      }
    }
    for (const prop of fragment.props) {
      if (Object.hasOwn(properties, prop.key)) {
        this.problems.error(
          'duplicate-name',
          `${prop.key} is the name of an attribute and an element`,
          this.at(prop.node),
        );
        continue;
      }
      properties[prop.key] = prop.schema;
    }
    required.push(...fragment.required.filter((key) => !required.includes(key)));
    if (Object.keys(properties).length > 0) {
      schema.properties = properties;
    }
    if (required.length > 0) {
      schema.required = required;
    }
    schema.additionalProperties = false;
    if (Object.keys(fragment.dependentRequired).length > 0) {
      schema.dependentRequired = fragment.dependentRequired;
    }
    addConstraints(schema, fragment.constraints);
    return schema;
  }
}

function addConstraints(schema: JsonSchema, constraints: JsonSchema[]): void {
  if (constraints.length === 1) {
    Object.assign(schema, constraints[0]);
  } else if (constraints.length > 1) {
    schema.allOf = constraints;
  }
}

// Attributes of a restriction or extension replace those of the base with the same name.
function overrideAttributes(base: AttributeProp[], own: AttributeProp[]): AttributeProp[] {
  const byKey = new Map(base.map((a) => [a.key, a]));
  for (const attribute of own) {
    byKey.set(attribute.key, attribute);
  }
  return [...byKey.values()].filter((a) => !a.prohibited);
}

function annotate(schema: JsonSchema, description: string | undefined, xml: XmlAnnotation | undefined): JsonSchema {
  if (!description && !xml) {
    return schema;
  }
  const out: JsonSchema = {};
  if (description) {
    out.description = description;
  }
  Object.assign(out, without(schema, 'description'));
  if (description === undefined && schema.description !== undefined) {
    out.description = schema.description;
  }
  if (xml) {
    out.xml = xml;
  }
  return out;
}

function without(schema: JsonSchema, key: keyof JsonSchema): JsonSchema {
  const copy = { ...schema };
  delete copy[key];
  return copy;
}

function pointerEscape(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1');
}

// A short label for a namespace URI: its last two path segments, e.g. `orders_common` for
// https://example.org/orders/common.
function namespaceLabel(ns: string): string {
  const segments = ns
    .replace(/^[a-z][a-z0-9+.-]*:(\/\/[^/]*)?/i, '')
    .split(/[/:#]/)
    .filter((s) => s.length > 0);
  return segments
    .slice(-2)
    .join('_')
    .replace(/[^A-Za-z0-9_.-]/g, '_');
}
