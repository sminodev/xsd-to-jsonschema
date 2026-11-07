// Writes the JSON Schema for one root element: element and attribute declarations, fixed and default values, and the
// objects of complex types. The other parts live next door: content models (sequence, choice, groups) in
// content-model.ts, the names in `$defs` in definitions.ts, simple types and their facets in simple-types.ts.
// docs/output.md describes the result.

import type { Element } from '@xmldom/xmldom';
import { addConstraints, ContentModel, emptyFragment, type Fragment, occurs, type Prop } from './content-model.js';
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
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export interface EmitterOptions extends SimpleTypeOptions {
  /** write the `xml` annotations */
  xml: boolean;
  /** property for the text of an element with simple content */
  textProperty: string;
}

/** A property from an attribute; `prohibited` attributes remove an inherited one. */
type AttributeProp = { key: string; prohibited: true } | (Prop & { required: boolean; prohibited?: false });

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

  constructor(
    private readonly set: SchemaSet,
    private readonly problems: Problems,
    private readonly options: EmitterOptions,
  ) {
    this.simple = new SimpleTypes(set, problems, options);
    this.contentModel = new ContentModel(set, problems, (node, doc) => this.elementProperty(node, doc));
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
    for (const unsupported of ['substitutionGroup', 'abstract', 'nillable']) {
      const value = attr(node, unsupported);
      if (value !== undefined && value !== 'false') {
        this.problems.error('unsupported-element', `${unsupported} on an element is not supported`, this.set.at(node));
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
        schema = this.definitions.ref('element', id, decl.name, () => this.complexType(anonymousComplex, decl.doc));
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
        this.set.at(node),
      );
      return schema;
    }
    const json = this.simple.jsonType(valueType, node);
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
        this.problems.error('invalid-value', value.error, this.set.at(node));
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
          this.problems.error(
            'unknown-attribute',
            `attribute {${name.ns}}${name.local} is not defined`,
            this.set.at(node),
          );
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
          this.problems.error('unknown-group', `attribute group ${ref} is not defined`, this.set.at(child));
        } else if (seen.has(group.node)) {
          this.problems.error('circular-group', `attribute group ${ref} refers to itself`, this.set.at(child));
        } else {
          out.push(...this.attributes(group.node, group.doc, new Set([...seen, group.node])));
        }
      } else if (child.localName === 'anyAttribute') {
        this.problems.warning(
          'unsupported-any',
          'xs:anyAttribute: other attributes are rejected (objects are closed)',
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
    if (attr(node, 'mixed') === 'true') {
      this.problems.error(
        'unsupported-mixed',
        'mixed content: the text between elements is not written',
        this.set.at(node),
      );
    }
    const simpleContent = xsChild(node, 'simpleContent');
    if (simpleContent) {
      return this.simpleContent(simpleContent, doc, seen);
    }
    const complexContent = xsChild(node, 'complexContent');
    const derivation = complexContent ? xsChildren(complexContent)[0] : undefined;
    if (derivation) {
      const baseQName = attr(derivation, 'base') ?? '';
      const baseName = this.set.resolveQName(derivation, baseQName);
      const fragment = emptyFragment();
      let attributes: AttributeProp[] = [];
      const base = this.set.lookup('complexType', baseName);
      if (!base && !(baseName.ns === XS && baseName.local === 'anyType')) {
        this.problems.error('unknown-type', `base type ${baseQName} is not defined`, this.set.at(derivation));
      }
      if (base && derivation.localName === 'extension') {
        const inherited = this.content(base.node, base.doc, seen);
        this.contentModel.merge(fragment, inherited.fragment, true);
        attributes = inherited.attributes;
      } else if (base) {
        attributes = this.content(base.node, base.doc, seen).attributes;
      }
      this.contentModel.compositor(derivation, doc, fragment);
      return { fragment, attributes: overrideAttributes(attributes, this.attributes(derivation, doc)) };
    }
    const fragment = emptyFragment();
    this.contentModel.compositor(node, doc, fragment);
    return { fragment, attributes: this.attributes(node, doc).filter((a) => !a.prohibited) };
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
    if (derivation.localName !== 'extension') {
      this.problems.error(
        'unsupported-simple-content',
        'simpleContent restriction is not supported; its facets are not applied',
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
    return { fragment, attributes: overrideAttributes(inherited, this.attributes(derivation, doc)) };
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
