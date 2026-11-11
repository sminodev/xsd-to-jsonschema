// Writes the JSON Schema for one root element: element and attribute declarations, fixed and default values, and the
// objects of complex types. The other parts live next door: content models (sequence, choice, groups) in
// content-model.ts, the names in `$defs` in definitions.ts, simple types and their facets in simple-types.ts.
// docs/output.md describes the result.

import type { Element } from '@xmldom/xmldom';
import { ContentModel, emptyFragment, type Fragment, occurs, type Prop, writeObject } from './content-model.js';
import { Definitions } from './definitions.js';
import type { JsonSchema, XmlAnnotation } from './json-schema.js';
import type { Problems } from './problems.js';
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

const SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
// Complex type content that XML Schema 1.1 added; the converter reports and ignores it.
const XSD_1_1_CONTENT = ['assert', 'openContent'];
const IDENTITY_CONSTRAINTS = ['key', 'keyref', 'unique'];

export interface EmitterOptions extends SimpleTypeOptions {
  /** write the `xml` annotations */
  xml: boolean;
  /** property for the text of an element with simple content */
  textProperty: string;
}

/** A property from an attribute, with its expanded name as `id`; `prohibited` attributes remove an inherited one. */
type AttributeProp =
  { id: string; key: string; prohibited: true } | (Prop & { id: string; required: boolean; prohibited?: false });

interface ElementDeclaration {
  name: string;
  ns: string;
  node: Element;
  doc: SchemaDocument;
  docs: string | undefined;
  global: boolean;
}

export class Emitter {
  private readonly simple: SimpleTypes;
  private readonly contentModel: ContentModel;
  private readonly definitions = new Definitions();
  private rootId: string | undefined;
  /** the global elements that name a substitution group head, by the local name of the head; built on first use */
  private substitutionGroups: Map<string, { node: Element; head: string }[]> | undefined;
  /** the named complex types derived directly from each named complex type; built on first use */
  private derivations: Map<Element, { node: Element; method: string }[]> | undefined;

  constructor(
    private readonly set: SchemaSet,
    private readonly problems: Problems,
    private readonly options: EmitterOptions,
  ) {
    this.simple = new SimpleTypes(set, problems, options);
    this.contentModel = new ContentModel(set, problems, (node, doc) => this.elementProperty(node, doc), options.xml);
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
    if (named) {
      this.checkElement(decl);
      this.checkType(decl, named);
    }
    const content = named
      ? this.withValues(this.complexType(named.node, named.doc), root.node, undefined, this.textType(named.node))
      : this.declarationType(decl, true);
    const defs = this.definitions.buildAll();
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
    if (defs.size > 0) {
      schema.$defs = Object.fromEntries(defs);
    }
    return schema;
  }

  // --- types ---------------------------------------------------------------------------------------------------

  /** A built-in type in place, or a `$ref` to the definition of a named type. */
  private typeRef(name: QName, atNode: Element): JsonSchema {
    if (name.ns === XS) {
      return name.local === 'anyType' ? {} : this.simple.schema(name, atNode);
    }
    const id = clark(name.ns, name.local);
    const complex = this.set.lookup('complexType', name);
    if (complex) {
      return this.definitions.ref('type', id, name.local, () => this.complexType(complex.node, complex.doc));
    }
    const simple = this.set.lookup('simpleType', name);
    if (simple) {
      return this.definitions.ref('type', id, name.local, () => this.namedSimpleType(simple.node));
    }
    this.problems.error('unknown-type', `type {${name.ns}}${name.local} is not defined`, this.set.at(atNode));
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
        this.problems.error('unknown-element', `element {${name.ns}}${name.local} is not defined`, this.set.at(node));
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
    this.checkElement(decl);
    const typeName = attr(node, 'type');
    const anonymousComplex = xsChild(node, 'complexType');
    const anonymousSimple = xsChild(node, 'simpleType');
    let schema: JsonSchema;
    let valueType: SimpleTypeRef | undefined;
    let textType: SimpleTypeRef | undefined;
    if (typeName !== undefined) {
      const name = this.set.resolveQName(node, typeName);
      schema = this.typeRef(name, node);
      const complex = this.set.lookup('complexType', name);
      if (complex) {
        this.checkType(decl, complex);
        textType = this.textType(complex.node);
      } else if (this.set.lookup('simpleType', name) || name.ns === XS) {
        valueType = name;
      }
    } else if (anonymousComplex) {
      textType = this.textType(anonymousComplex);
      const id = clark(decl.ns, decl.name);
      if (decl.global && !inline && id === this.rootId) {
        schema = { $ref: '#' };
      } else if (decl.global && !inline) {
        schema = this.definitions.ref('element', id, decl.name, () => this.complexType(anonymousComplex, decl.doc));
      } else {
        schema = this.complexType(anonymousComplex, decl.doc);
      }
    } else if (anonymousSimple) {
      schema = this.simple.schema(anonymousSimple);
      valueType = anonymousSimple;
    } else {
      schema = {};
      valueType = { ns: XS, local: 'anySimpleType' };
    }
    return this.withValues(schema, node, valueType, textType);
  }

  /** The simple type of the text of a complex type with simple content; undefined for other complex types. */
  private textType(node: Element, seen = new Set<Element>()): SimpleTypeRef | undefined {
    const simpleContent = xsChild(node, 'simpleContent');
    const derivation = simpleContent && xsChildren(simpleContent)[0];
    if (!derivation || seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    const inner = xsChild(derivation, 'simpleType');
    if (inner) {
      return inner;
    }
    const base = this.set.resolveQName(derivation, attr(derivation, 'base') ?? '');
    const complex = base.ns === XS ? undefined : this.set.lookup('complexType', base);
    return complex ? this.textType(complex.node, seen) : base;
  }

  /** Reports what an element declaration means in XML that its JSON property cannot express. */
  private checkElement(decl: ElementDeclaration): void {
    const node = decl.node;
    const at = this.set.at(node);
    for (const unsupported of ['abstract', 'nillable']) {
      const value = attr(node, unsupported);
      if (value !== undefined && value !== 'false') {
        this.problems.error('unsupported-element', `${unsupported} on an element is not supported`, at);
      }
    }
    const members = decl.global ? this.substitutionMembers(decl) : [];
    if (members.length > 0) {
      this.problems.error(
        'unsupported-element',
        `${decl.name} heads a substitution group; its members (${members.join(', ')}) are not accepted in its place`,
        at,
      );
    }
    for (const child of xsChildren(node)) {
      if (IDENTITY_CONSTRAINTS.includes(child.localName ?? '')) {
        this.problems.warning(
          'unsupported-identity-constraint',
          `xs:${child.localName} ${attr(child, 'name') ?? ''} is not checked`,
          this.set.at(child),
        );
      } else if (child.localName === 'alternative') {
        this.problems.error(
          'unsupported-element',
          'xs:alternative (XML Schema 1.1) is ignored; the declared type is used',
          this.set.at(child),
        );
      }
    }
  }

  /** Reports what the complex type of an element allows in XML that its JSON form cannot express. */
  private checkType(decl: ElementDeclaration, type: Component): void {
    const name = attr(type.node, 'name') ?? '';
    if (isTrue(attr(type.node, 'abstract'))) {
      this.problems.error(
        'unsupported-element',
        `${decl.name} has the abstract type ${name}; documents choose a derived type with xsi:type, which the schema does not accept`,
        this.set.at(decl.node),
      );
      return;
    }
    const derived = this.substitutableTypes(decl, type);
    if (derived.length > 0) {
      this.problems.warning(
        'unsupported-xsi-type',
        `xsi:type can give an element of type ${name} the derived type ${derived.join(', ')}; the schema accepts only ${name}`,
        this.set.at(type.node),
      );
    }
  }

  /** The names of the concrete types derived from the type of an element that xsi:type may select. */
  private substitutableTypes(decl: ElementDeclaration, type: Component): string[] {
    if (this.derivations === undefined) {
      this.derivations = new Map();
      for (const { node } of this.set.components.complexType.values()) {
        const content = xsChild(node, 'complexContent') ?? xsChild(node, 'simpleContent');
        const derivation = content && xsChildren(content)[0];
        const base =
          derivation &&
          this.set.lookup('complexType', this.set.resolveQName(derivation, attr(derivation, 'base') ?? ''));
        if (derivation && base) {
          this.derivations.set(base.node, [
            ...(this.derivations.get(base.node) ?? []),
            { node, method: derivation.localName ?? '' },
          ]);
        }
      }
    }
    // The element and its type can block derivation methods, in their own block attribute or the schema's blockDefault.
    const blocked = new Set([...blockedBy(decl.node, decl.doc), ...blockedBy(type.node, type.doc)]);
    const names: string[] = [];
    const seen = new Set<Element>([type.node]);
    const visit = (base: Element): void => {
      for (const { node, method } of this.derivations?.get(base) ?? []) {
        if (seen.has(node) || blocked.has(method)) {
          continue;
        }
        seen.add(node);
        if (!isTrue(attr(node, 'abstract'))) {
          names.push(attr(node, 'name') ?? '');
        }
        visit(node);
      }
    };
    visit(type.node);
    return names;
  }

  /** The names of the global elements that may stand in for a global element (its substitution group). */
  private substitutionMembers(decl: ElementDeclaration): string[] {
    if (this.substitutionGroups === undefined) {
      this.substitutionGroups = new Map();
      for (const { node } of this.set.components.element.values()) {
        // XML Schema 1.0 allows one head, 1.1 a list of them.
        for (const head of (attr(node, 'substitutionGroup') ?? '').split(/\s+/).filter((q) => q.length > 0)) {
          const local = head.slice(head.indexOf(':') + 1);
          this.substitutionGroups.set(local, [...(this.substitutionGroups.get(local) ?? []), { node, head }]);
        }
      }
    }
    return (this.substitutionGroups.get(decl.name) ?? [])
      .filter(({ node, head }) => this.set.resolveQName(node, head).ns === decl.ns)
      .map(({ node }) => attr(node, 'name') ?? '');
  }

  /**
   * Adds the fixed and default value of a declaration: to the schema, or to the text property for simple content.
   *
   * @param textType - the type of the text of simple content, if the declaration has no simple type
   */
  private withValues(
    schema: JsonSchema,
    node: Element,
    valueType: SimpleTypeRef | undefined,
    textType?: SimpleTypeRef,
  ): JsonSchema {
    const fixed = attr(node, 'fixed');
    const fallback = attr(node, 'default');
    if (fixed === undefined && fallback === undefined) {
      return schema;
    }
    const type = valueType ?? textType;
    if (type === undefined) {
      this.problems.error(
        'unsupported-value',
        'fixed or default on an element with complex content is not supported',
        this.set.at(node),
      );
      return schema;
    }
    const json = this.simple.jsonType(type, node);
    const values: JsonSchema = {};
    for (const [keyword, lexical] of [
      ['const', fixed],
      ['default', fallback],
    ] as const) {
      if (lexical === undefined) {
        continue;
      }
      const value = lexicalToJson(json, lexical);
      if ('error' in value) {
        this.problems.error('invalid-value', value.error, this.set.at(node));
      } else {
        if (value.rounded) {
          this.problems.warning('rounded-number', `${lexical} is rounded to ${String(value.value)}`, this.set.at(node));
        }
        values[keyword] = value.value;
      }
    }
    if (valueType !== undefined) {
      return { ...schema, ...values };
    }
    const key = this.options.textProperty;
    const text = schema.properties?.[key];
    return {
      ...schema,
      type: 'object',
      properties: { ...schema.properties, [key]: { ...(typeof text === 'object' ? text : {}), ...values } },
    };
  }

  /** The property of an element particle: content, description, `xml`, and an array for repetition. */
  private elementProperty(node: Element, doc: SchemaDocument): Prop | undefined {
    const decl = this.elementDeclaration(node, doc);
    if (!decl) {
      return undefined;
    }
    const { min, max } = occurs(node);
    const item = this.declarationType(decl);
    const xml: XmlAnnotation | undefined = this.options.xml && decl.ns ? { namespace: decl.ns } : undefined;
    const array = (low: number, high: number): JsonSchema => {
      const list: JsonSchema = {};
      if (decl.docs) {
        list.description = decl.docs;
      }
      list.type = 'array';
      list.items = item;
      if (low > 0) {
        list.minItems = low;
      }
      if (high !== Infinity) {
        list.maxItems = high;
      }
      if (xml) {
        list.xml = xml;
      }
      return list;
    };
    return {
      key: decl.name,
      schema: max > 1 ? array(min, max) : annotate(item, decl.docs, xml),
      node,
      occurrences: { identity: `{${decl.ns}}${JSON.stringify(item)}`, min, max, array },
    };
  }

  private attributeProperty(node: Element, doc: SchemaDocument): AttributeProp | undefined {
    const ref = attr(node, 'ref');
    let decl = node;
    let ns: string;
    if (ref !== undefined) {
      const name = this.set.resolveQName(node, ref);
      const global = this.set.lookup('attribute', name);
      if (!global) {
        this.problems.error(
          'unknown-attribute',
          `attribute {${name.ns}}${name.local} is not defined`,
          this.set.at(node),
        );
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
    const id = clark(ns, key);
    const use = attr(node, 'use') ?? 'optional';
    if (use === 'prohibited') {
      return { id, key, prohibited: true };
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
    return { id, key, schema: annotate(schema, docs, xml), node, required: use === 'required' };
  }

  /**
   * The attributes of a complex type or derivation, with attribute groups expanded.
   *
   * @param fragment - marked as open when xs:anyAttribute allows other attributes
   */
  private attributes(
    owner: Element,
    doc: SchemaDocument,
    fragment: Fragment,
    seen = new Set<Element>(),
  ): AttributeProp[] {
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
          this.problems.error('unknown-group', `attribute group ${ref} is not defined`, this.set.at(child));
        } else if (seen.has(group.node)) {
          this.problems.error('circular-group', `attribute group ${ref} refers to itself`, this.set.at(child));
        } else {
          out.push(...this.attributes(group.node, group.doc, fragment, new Set([...seen, group.node])));
        }
      } else if (child.localName === 'anyAttribute') {
        fragment.open = true;
        this.problems.warning(
          'unsupported-any',
          'xs:anyAttribute: the object accepts other properties without checking them',
          this.set.at(child),
        );
      }
    }
    return out;
  }

  // --- complex types -------------------------------------------------------------------------------------------

  /** Properties and attributes of a complex type, following complexContent extensions to their bases. */
  private content(
    node: Element,
    doc: SchemaDocument,
    seen = new Set<Element>(),
  ): { fragment: Fragment; attributes: AttributeProp[] } {
    if (seen.has(node)) {
      this.problems.error('circular-type', 'circular complex type derivation', this.set.at(node));
      return { fragment: emptyFragment(), attributes: [] };
    }
    seen.add(node);
    this.checkXsd11Content(node);
    const simpleContent = xsChild(node, 'simpleContent');
    if (simpleContent) {
      return this.simpleContent(simpleContent, doc, seen);
    }
    const complexContent = xsChild(node, 'complexContent');
    const derivation = complexContent ? xsChildren(complexContent)[0] : undefined;
    if (derivation) {
      this.checkXsd11Content(derivation);
    }
    if (attr(node, 'mixed') === 'true' || (complexContent && attr(complexContent, 'mixed') === 'true')) {
      return this.mixedContent(node, derivation, doc, seen);
    }
    if (derivation) {
      const baseQName = attr(derivation, 'base') ?? '';
      const baseName = this.set.resolveQName(derivation, baseQName);
      let fragment = emptyFragment();
      let attributes: AttributeProp[] = [];
      const base = this.set.lookup('complexType', baseName);
      if (!base && !(baseName.ns === XS && baseName.local === 'anyType')) {
        this.problems.error('unknown-type', `base type ${baseQName} is not defined`, this.set.at(derivation));
      }
      if (base && derivation.localName === 'extension') {
        const inherited = this.content(base.node, base.doc, seen);
        // The object continues the numbering of the repeated groups of its base.
        fragment = emptyFragment(inherited.fragment.groupKeys);
        this.contentModel.merge(fragment, inherited.fragment, true);
        attributes = inherited.attributes;
      } else if (base) {
        attributes = this.content(base.node, base.doc, seen).attributes;
      }
      this.contentModel.compositor(derivation, doc, fragment);
      return { fragment, attributes: overrideAttributes(attributes, this.attributes(derivation, doc, fragment)) };
    }
    const fragment = emptyFragment();
    this.contentModel.compositor(node, doc, fragment);
    return { fragment, attributes: this.attributes(node, doc, fragment).filter((a) => !a.prohibited) };
  }

  /**
   * Mixed content: the attributes, and the text with the child elements as one string of XML markup. The child
   * elements are not checked.
   */
  private mixedContent(
    node: Element,
    derivation: Element | undefined,
    doc: SchemaDocument,
    seen: Set<Element>,
  ): { fragment: Fragment; attributes: AttributeProp[] } {
    this.problems.warning(
      'unsupported-mixed',
      'mixed content is written as a string of XML markup; the elements in it are not checked',
      this.set.at(node),
    );
    const fragment = emptyFragment();
    let attributes: AttributeProp[];
    if (derivation) {
      const baseQName = attr(derivation, 'base') ?? '';
      const baseName = this.set.resolveQName(derivation, baseQName);
      const base = this.set.lookup('complexType', baseName);
      let inherited: AttributeProp[] = [];
      if (base) {
        const content = this.content(base.node, base.doc, seen);
        inherited = content.attributes;
        fragment.open = derivation.localName === 'extension' && content.fragment.open === true;
      } else if (!(baseName.ns === XS && baseName.local === 'anyType')) {
        this.problems.error('unknown-type', `base type ${baseQName} is not defined`, this.set.at(derivation));
      }
      attributes = overrideAttributes(inherited, this.attributes(derivation, doc, fragment));
    } else {
      attributes = this.attributes(node, doc, fragment).filter((a) => !a.prohibited);
    }
    const text: JsonSchema = { type: 'string' };
    if (this.options.xml) {
      text.xml = { text: true, mixed: true };
    }
    fragment.props.push({ key: this.options.textProperty, schema: text, node });
    fragment.required.push(this.options.textProperty);
    return { fragment, attributes };
  }

  /**
   * Text and attributes. The base is a simple type, or a complex type with simple content whose text and attributes
   * are inherited.
   */
  private simpleContent(
    node: Element,
    doc: SchemaDocument,
    seen: Set<Element>,
  ): { fragment: Fragment; attributes: AttributeProp[] } {
    const fragment = emptyFragment();
    const derivation = xsChildren(node)[0];
    if (!derivation) {
      return { fragment, attributes: [] };
    }
    this.checkXsd11Content(derivation);
    // A restriction that only changes attributes is converted exactly; facets on the text are not applied.
    const facets = xsChildren(derivation).filter(
      (c) => !['attribute', 'attributeGroup', 'anyAttribute', ...XSD_1_1_CONTENT].includes(c.localName ?? ''),
    );
    if (derivation.localName !== 'extension' && facets.length > 0) {
      this.problems.error(
        'unsupported-simple-content',
        `a simpleContent restriction is written without its ${facets.map((f) => `xs:${f.localName}`).join(', ')}`,
        this.set.at(derivation),
      );
    }
    const baseQName = attr(derivation, 'base') ?? '';
    const baseName = this.set.resolveQName(derivation, baseQName);
    const complexBase = baseName.ns === XS ? undefined : this.set.lookup('complexType', baseName);
    let value: JsonSchema | undefined;
    let inherited: AttributeProp[] = [];
    if (complexBase) {
      const base = this.content(complexBase.node, complexBase.doc, seen);
      inherited = base.attributes;
      // An extension keeps the attribute wildcard of its base; a restriction states its own.
      fragment.open = derivation.localName === 'extension' && base.fragment.open === true;
      value = base.fragment.props.find((prop) => prop.key === this.options.textProperty)?.schema;
      if (value === undefined) {
        this.problems.error(
          'unsupported-simple-content',
          `base type ${baseQName} has no simple content; the text is written as a string`,
          this.set.at(derivation),
        );
      }
    }
    if (value === undefined) {
      value = complexBase ? { type: 'string' } : this.typeRef(baseName, derivation);
      if (this.options.xml) {
        value = { ...value, xml: { text: true } };
      }
    }
    fragment.props.push({ key: this.options.textProperty, schema: value, node: derivation });
    fragment.required.push(this.options.textProperty);
    return { fragment, attributes: overrideAttributes(inherited, this.attributes(derivation, doc, fragment)) };
  }

  /** Reports the assertions and open content of XML Schema 1.1 in a complex type or derivation, which are ignored. */
  private checkXsd11Content(owner: Element): void {
    for (const child of xsChildren(owner)) {
      if (XSD_1_1_CONTENT.includes(child.localName ?? '')) {
        this.problems.error(
          'unsupported-particle',
          `xs:${child.localName} (XML Schema 1.1) is ignored`,
          this.set.at(child),
        );
      }
    }
  }

  /** The object schema of a complex type: attributes first, then the properties of the content model. */
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
      if (Object.hasOwn(properties, attribute.key)) {
        this.problems.error(
          'duplicate-name',
          `${attribute.key} is the name of two attributes in different namespaces`,
          this.set.at(attribute.node),
        );
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
          this.set.at(prop.node),
        );
        continue;
      }
      properties[prop.key] = prop.schema;
    }
    required.push(...fragment.required.filter((key) => !required.includes(key)));
    writeObject(schema, properties, required, fragment);
    return schema;
  }
}

const isTrue = (value: string | undefined): boolean => value === 'true' || value === '1';

/** The derivation methods a declaration blocks, from its block attribute or the blockDefault of its schema. */
function blockedBy(node: Element, doc: SchemaDocument): string[] {
  const value = attr(node, 'block') ?? attr(doc.root, 'blockDefault') ?? '';
  return value.includes('#all') ? ['extension', 'restriction'] : value.split(/\s+/);
}

// Attributes of a restriction or extension replace those of the base with the same name.
function overrideAttributes(base: AttributeProp[], own: AttributeProp[]): AttributeProp[] {
  const byId = new Map(base.map((a) => [a.id, a]));
  for (const attribute of own) {
    byId.set(attribute.id, attribute);
  }
  return [...byId.values()].filter((a) => !a.prohibited);
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
