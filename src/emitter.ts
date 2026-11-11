// Writes the JSON Schema for one root element: element and attribute declarations, fixed and default values, and the
// objects of complex types. The other parts live next door: content models (sequence, choice, groups) in
// content-model.ts, the names in `$defs` in definitions.ts, simple types and their facets in simple-types.ts.
// docs/output.md describes the result.

import type { Element } from '@xmldom/xmldom';
import { attributeKey, elementKey, planKeys, renameObject } from './keys.js';
import { float32Range } from './value-forms.js';
import { ContentModel, emptyFragment, type Fragment, occurs, type Prop, writeObject } from './content-model.js';
import { Definitions } from './definitions.js';
import type { JsonSchema, XmlAnnotation } from './json-schema.js';
import { blockedBy, Polymorphism, type TypeAlternative } from './polymorphism.js';
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
import { type RestrictionStep, type SimpleTypeOptions, type SimpleTypeRef, SimpleTypes } from './simple-types.js';

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
  /** the anonymous complex types of local elements being written, to stop one that contains itself */
  private readonly openLocal = new Set<Element>();
  /** how deep the local element types around a deferred definition nest */
  private localBase = 0;
  /** the final property names of the object of each complex type, for its nil form */
  private readonly keyPlans = new Map<Element, Map<string, string>>();
  private rootId: string | undefined;
  private readonly poly: Polymorphism;

  constructor(
    private readonly set: SchemaSet,
    private readonly problems: Problems,
    private readonly options: EmitterOptions,
  ) {
    this.simple = new SimpleTypes(
      set,
      problems,
      options,
      (local, build) => this.definitions.ref('type', clark(XS, local), local, build),
      (name, from) => this.typeRef(name, from),
    );
    this.poly = new Polymorphism(set);
    this.contentModel = new ContentModel(
      set,
      problems,
      (node, doc, particle) => this.elementProperty(node, doc, particle),
      options.xml,
      (node) => this.substitutes(node),
      options.textProperty,
    );
  }

  /** The schema of a global element: its content in place, with all definitions it reaches. */
  root(root: Component): JsonSchema {
    const name = attr(root.node, 'name') ?? '';
    this.rootId = clark(root.doc.targetNamespace, name);
    const decl = this.globalElement(root.node, root.doc);
    // The root describes the element content in place, even when its type is a named complex type.
    const typeName = this.poly.typeName(root.node);
    const named = typeName && this.set.lookup('complexType', typeName);
    if (named) {
      this.checkElement(decl);
    }
    if (isTrue(attr(root.node, 'abstract'))) {
      this.problems.error(
        'unsupported-element',
        `${name} is abstract; a document uses an element of its substitution group as root, choose that one`,
        this.set.at(root.node),
      );
    }
    const content = this.nillable(
      decl,
      named && typeName
        ? this.typeAlternatives(
            decl,
            typeName,
            this.withValues(this.complexType(named.node, named.doc), root.node, undefined, this.textType(named.node)),
          )
        : this.declarationType(decl, true),
    );
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
      schema.xml = withTypeXml(xml, content);
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
      return this.definitions.ref('type', id, name.local, () => this.namedSimpleType(simple.node, id));
    }
    this.problems.error('unknown-type', `type {${name.ns}}${name.local} is not defined`, this.set.at(atNode));
    return {};
  }

  private namedSimpleType(node: Element, id: string): JsonSchema {
    const schema = this.withTypeName(this.simple.schema(node), id);
    const docs = documentation(node);
    return docs ? { description: docs, ...schema } : schema;
  }

  /** A simple type with its expanded name in `xml.type`, so that a reader can tell xsi:type naming it apart. */
  private withTypeName(schema: JsonSchema, id: string): JsonSchema {
    return this.options.xml ? { ...schema, xml: { ...schema.xml, type: id } } : schema;
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
    // An element without a type of its own in a substitution group has the type of its head.
    const name = this.poly.typeName(node);
    const anonymousComplex = xsChild(node, 'complexType');
    const anonymousSimple = xsChild(node, 'simpleType');
    let schema: JsonSchema;
    let valueType: SimpleTypeRef | undefined;
    let textType: SimpleTypeRef | undefined;
    if (name === undefined ? !anonymousComplex && !anonymousSimple : name.ns === XS && name.local === 'anyType') {
      return this.withValues(this.anyTypeSchema(decl), node, { ns: XS, local: 'anySimpleType' });
    }
    if (name !== undefined) {
      schema = this.typeRef(name, node);
      const complex = this.set.lookup('complexType', name);
      if (complex) {
        textType = this.textType(complex.node);
      } else if (this.set.lookup('simpleType', name) || name.ns === XS) {
        valueType = name;
        if (name.ns === XS && name.local !== 'anyType' && name.local !== 'anySimpleType') {
          schema = this.withTypeName(schema, clark(name.ns, name.local));
        }
      }
      return this.typeAlternatives(decl, name, this.withValues(schema, node, valueType, textType));
    } else if (anonymousComplex) {
      textType = this.textType(anonymousComplex);
      const id = clark(decl.ns, decl.name);
      if (decl.global && !inline && id === this.rootId) {
        schema = { $ref: '#' };
      } else if (decl.global && !inline) {
        schema = this.definitions.ref('element', id, decl.name, () => this.complexType(anonymousComplex, decl.doc));
      } else if (this.openLocal.has(anonymousComplex) || this.openLocal.size >= MAX_INLINE_DEPTH) {
        // A local element that contains itself through its content refers to a definition of its type; so does one
        // nested very deep, whose definition is written later, after the stack has unwound.
        const at = this.set.at(anonymousComplex);
        const where = `${at.file ?? ''}:${anonymousComplex.lineNumber ?? 0}:${anonymousComplex.columnNumber ?? 0}`;
        const depth = this.localBase + this.openLocal.size;
        if (depth >= MAX_LOCAL_DEPTH) {
          throw new RangeError(`local element types nest deeper than ${MAX_LOCAL_DEPTH} levels`);
        }
        schema = this.definitions.ref('local', `${id} ${where}`, decl.name, () => {
          const saved = this.localBase;
          this.localBase = depth;
          try {
            return this.localComplexType(anonymousComplex, decl.doc);
          } finally {
            this.localBase = saved;
          }
        });
      } else {
        schema = this.localComplexType(anonymousComplex, decl.doc);
      }
    } else if (anonymousSimple) {
      schema = this.simple.schema(anonymousSimple);
      valueType = anonymousSimple;
    } else {
      schema = {};
    }
    return this.withValues(schema, node, valueType, textType);
  }

  /** The anonymous complex type of a local element, marked as open while it is written. */
  private localComplexType(node: Element, doc: SchemaDocument): JsonSchema {
    this.openLocal.add(node);
    try {
      return this.complexType(node, doc);
    } finally {
      this.openLocal.delete(node);
    }
  }

  /**
   * An element without a type, or of xs:anyType, takes any content: it is written without a schema, like content a
   * wildcard takes, and marked with `xml.anyType`.
   */
  private anyTypeSchema(decl: ElementDeclaration): JsonSchema {
    this.problems.warning(
      'unsupported-any',
      `${decl.name} is of xs:anyType: its content is written without a schema and isn't checked`,
      this.set.at(decl.node),
    );
    return this.options.xml ? { xml: { anyType: true } } : {};
  }

  /**
   * The simple type of the text of a complex type with simple content, with the facets of the restrictions on the
   * way; undefined for other complex types.
   */
  private textType(node: Element, seen = new Set<Element>()): SimpleTypeRef | undefined {
    const simpleContent = xsChild(node, 'simpleContent');
    const derivation = simpleContent && xsChildren(simpleContent)[0];
    if (!derivation || seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    return this.derivedTextType(derivation, seen);
  }

  /** The simple type of the text a simpleContent extension or restriction gives. */
  private derivedTextType(derivation: Element, seen = new Set<Element>()): SimpleTypeRef | undefined {
    const inner = xsChild(derivation, 'simpleType');
    let base: SimpleTypeRef | undefined = inner;
    if (!inner) {
      const name = this.set.resolveQName(derivation, attr(derivation, 'base') ?? '');
      const complex = name.ns === XS ? undefined : this.set.lookup('complexType', name);
      base = complex ? this.textType(complex.node, seen) : name;
    }
    const facets = derivation.localName === 'restriction' ? textFacets(derivation) : [];
    if (base === undefined || facets.length === 0) {
      return base;
    }
    const step: RestrictionStep = { node: derivation, facets };
    return { base, steps: [step] };
  }

  /** Reports what an element declaration means in XML that its JSON property cannot express. */
  private checkElement(decl: ElementDeclaration): void {
    for (const child of xsChildren(decl.node)) {
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

  /**
   * The schema of an element of a named or built-in type, with the types xsi:type may select. A complex type is an
   * `anyOf` of its own definition, unless it is abstract, and the definitions of its derived types, which require
   * `#type`; without derived types it stays as it is. A simple type stays as it is.
   */
  private typeAlternatives(decl: ElementDeclaration, type: QName, schema: JsonSchema): JsonSchema {
    const alternatives = this.typeChoices(decl, type);
    if (alternatives === undefined) {
      return schema;
    }
    const id = clark(type.ns, type.local);
    const complex = this.set.lookup('complexType', type);
    if (complex) {
      const abstract = isTrue(attr(complex.node, 'abstract'));
      const others = alternatives.filter((alternative) => alternative.id !== id);
      if (others.length === 0) {
        if (abstract) {
          this.problems.error(
            'unsupported-element',
            `${decl.name} has the abstract type ${type.local}, and no type derives from it`,
            this.set.at(decl.node),
          );
        }
        return schema;
      }
      const branches = others.map((alternative) => this.typeBranch(alternative, decl.node));
      return { anyOf: abstract ? branches : [schema, ...branches] };
    }
    // A simple type has no object form: xsi:type may only name the declared type, which `xml.type` records.
    return schema;
  }

  /** The types xsi:type may select for an element of `type`; undefined for anyType, anySimpleType or an unknown type. */
  private typeChoices(decl: ElementDeclaration, type: QName): TypeAlternative[] | undefined {
    if (type.ns === XS && (type.local === 'anyType' || type.local === 'anySimpleType')) {
      return undefined;
    }
    const complex = this.set.lookup('complexType', type);
    if (!complex && !this.set.lookup('simpleType', type) && type.ns !== XS) {
      return undefined;
    }
    // The element and its type can block derivation methods, in their own block attribute or the schema's blockDefault.
    const blocked = new Set([
      ...blockedBy(decl.node, decl.doc),
      ...(complex ? blockedBy(complex.node, complex.doc) : []),
    ]);
    return this.poly.alternatives(type, blocked);
  }

  /** The schema of an element whose xsi:type selects the derived complex type `alternative`. */
  private typeBranch(alternative: TypeAlternative, at: Element): JsonSchema {
    return { ...this.typeRef(alternative.name, at), type: 'object', required: ['#type'] };
  }

  /** The `#type` property for these expanded type names. */
  private typeProperty(ids: string[]): JsonSchema {
    const schema: JsonSchema = ids.length === 1 ? { const: ids[0] } : { enum: ids };
    if (this.options.xml) {
      schema.xml = { xsiType: true };
    }
    return schema;
  }

  /** The global elements that may appear for an element particle that refers to the head of a substitution group. */
  private substitutes(node: Element): Component[] | undefined {
    const ref = attr(node, 'ref');
    const head = ref === undefined ? undefined : this.set.lookup('element', this.set.resolveQName(node, ref));
    return head && this.poly.substitutes(head);
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
    const values: JsonSchema = {};
    for (const [keyword, lexical] of [
      ['const', fixed],
      ['default', fallback],
    ] as const) {
      if (lexical === undefined) {
        continue;
      }
      // The value constraint counts as normalized, as the text it is compared with.
      const value = this.simple.valueToJson(type, lexical, node);
      if ('error' in value) {
        this.problems.error('invalid-value', value.error, this.set.at(node));
      } else {
        if (value.rounded) {
          this.problems.warning(
            'rounded-number',
            `${lexical} is rounded to ${JSON.stringify(value.value)}`,
            this.set.at(node),
          );
        }
        values[keyword] = value.value;
        if (keyword === 'const') {
          this.fixedByValue(values, type, lexical, node);
        }
      }
    }
    if (valueType !== undefined) {
      return withPattern(withValuesOf(schema, values), values.pattern);
    }
    const key = this.options.textProperty;
    const text = schema.properties?.[key];
    const textSchema = withPattern(withValuesOf(typeof text === 'object' ? text : {}, values), values.pattern);
    return { ...schema, type: 'object', properties: { ...schema.properties, [key]: textSchema } };
  }

  /**
   * A fixed value compares values, not text: where the value has several spellings, `const` becomes a pattern of all
   * of them and the value moves to `default`, the value an empty element takes. Where they can't be listed (a float
   * or double member of a union), the value is only a `default`.
   */
  private fixedByValue(values: JsonSchema, type: SimpleTypeRef, lexical: string, node: Element): void {
    // An xs:float is a 32-bit float: every number that rounds to the fixed float is that value.
    if (typeof values.const === 'number' && this.simple.isFloat(type, node)) {
      values.allOf = [float32Range(values.const)];
      values.default = values.const;
      delete values.const;
      return;
    }
    const forms = this.simple.fixedForms(type, lexical, node);
    if ('unlisted' in forms) {
      this.problems.warning(
        'unsupported-union',
        `the fixed value ${lexical} is a value of ${forms.unlisted}, whose spellings can't be listed; it is not checked`,
        this.set.at(node),
      );
    } else if (forms.pattern === undefined) {
      return;
    } else {
      values.pattern = forms.pattern;
    }
    values.default = values.const;
    delete values.const;
  }

  /**
   * The schema of a nillable element: its content, or its nil form, marked with `xml.nillable`. The nil form is
   * `null` when the element can do without attributes, and an object with the attributes and the text property
   * `null` when it has attributes. With `xsi:type`, the nil form of each type the element may have carries `#type`
   * and the attributes of that type, inherited ones included.
   */
  private nillable(decl: ElementDeclaration, schema: JsonSchema): JsonSchema {
    if (!isTrue(attr(decl.node, 'nillable'))) {
      return schema;
    }
    const forms: JsonSchema[] = [];
    const { attributes, anyAttribute } = this.declaredAttributes(decl);
    const type = this.poly.typeName(decl.node);
    const declared = type && this.set.lookup('complexType', type);
    const alternatives = (declared && type && this.typeChoices(decl, type)) || [];
    const declaredId = type && clark(type.ns, type.local);
    if (!attributes.some((a) => a.required)) {
      forms.push({ type: 'null' });
    }
    const plan = this.keyPlan(decl);
    if (alternatives.length === 0) {
      const form = this.nilForm(decl, attributes, anyAttribute, plan);
      if (form && (attributes.length > 0 || anyAttribute)) {
        forms.push(form);
      }
    }
    for (const alternative of alternatives) {
      // The declared type may go without `#type`; any other type needs it.
      const own = alternative.id === declaredId;
      const complex = own ? undefined : this.set.lookup('complexType', alternative.name);
      const typed = complex ? this.typeAttributes(complex.node, complex.doc, new Set()) : { attributes, anyAttribute };
      const typePlan = complex ? this.keyPlanOf(complex.node, complex.doc) : plan;
      const form = this.nilForm(decl, typed.attributes, typed.anyAttribute, typePlan, alternative.id, !own);
      if (form) {
        forms.push(form);
      }
    }
    const out: JsonSchema = {};
    if (schema.description) {
      out.description = schema.description;
    }
    out.anyOf = [without(schema, 'description'), ...forms];
    if (this.options.xml) {
      out.xml = { nillable: true };
    }
    return out;
  }

  /**
   * One nil form as an object: the attributes, the text property `null` and, for a type xsi:type names, `#type`.
   * Undefined if an attribute takes the name of the text property.
   */
  private nilForm(
    decl: ElementDeclaration,
    attributes: (AttributeProp & { prohibited?: false })[],
    anyAttribute: boolean,
    plan: Map<string, string>,
    typeId?: string,
    typeRequired = false,
  ): JsonSchema | undefined {
    const key = this.options.textProperty;
    const clash = attributes.find((a) => (plan.get(a.key) ?? a.key) === key);
    if (clash) {
      this.problems.error(
        'duplicate-name',
        `${key} is the name of an attribute and of the text property of the nil form of ${decl.name}`,
        this.set.at(clash.node),
      );
      return undefined;
    }
    const properties: Record<string, JsonSchema> = typeId === undefined ? {} : { '#type': this.typeProperty([typeId]) };
    const required: string[] = typeRequired ? ['#type'] : [];
    for (const attribute of attributes) {
      properties[attribute.key] = attribute.schema;
      if (attribute.required) {
        required.push(attribute.key);
      }
    }
    properties[key] = this.options.xml ? { type: 'null', xml: { text: true } } : { type: 'null' };
    required.push(key);
    const form: JsonSchema = { type: 'object', properties, required };
    if (!anyAttribute) {
      form.additionalProperties = false;
    } else if (this.options.xml) {
      form.xml = { anyAttribute: true };
    }
    renameObject(form, plan, this.options.xml);
    return form;
  }

  /** The final property names of the object of an element declaration's complex type; see `planKeys`. */
  private keyPlan(decl: ElementDeclaration): Map<string, string> {
    const typeName = this.poly.typeName(decl.node);
    const named = typeName === undefined ? undefined : this.set.lookup('complexType', typeName);
    const node = named?.node ?? xsChild(decl.node, 'complexType');
    return node ? this.keyPlanOf(node, named?.doc ?? decl.doc) : new Map<string, string>();
  }

  /** The final property names of the object of a complex type. */
  private keyPlanOf(node: Element, doc: SchemaDocument): Map<string, string> {
    let plan = this.keyPlans.get(node);
    if (plan === undefined) {
      // A type that holds a nillable element of its own type asks again while its content is read: the keys of
      // that inner pass are not used.
      this.keyPlans.set(node, new Map());
      const { fragment, attributes } = this.content(node, doc);
      const keys = [...attributes.filter((a) => !a.prohibited).map((a) => a.key), ...fragment.props.map((p) => p.key)];
      plan = planKeys(keys, this.options.textProperty);
      this.keyPlans.set(node, plan);
    }
    return plan;
  }

  /** The attributes the type of an element declaration has, inherited ones included. */
  private declaredAttributes(decl: ElementDeclaration): {
    attributes: (AttributeProp & { prohibited?: false })[];
    anyAttribute: boolean;
  } {
    const typeName = this.poly.typeName(decl.node);
    const named = typeName === undefined ? undefined : this.set.lookup('complexType', typeName);
    const anonymous = xsChild(decl.node, 'complexType');
    if (named) {
      return this.typeAttributes(named.node, named.doc, new Set());
    }
    return anonymous ? this.typeAttributes(anonymous, decl.doc, new Set()) : { attributes: [], anyAttribute: false };
  }

  private typeAttributes(
    node: Element,
    doc: SchemaDocument,
    seen: Set<Element>,
  ): { attributes: (AttributeProp & { prohibited?: false })[]; anyAttribute: boolean } {
    seen.add(node);
    const fragment = emptyFragment();
    const content = xsChild(node, 'simpleContent') ?? xsChild(node, 'complexContent');
    const derivation = content && xsChildren(content)[0];
    let attributes: AttributeProp[];
    let anyAttribute = false;
    if (derivation) {
      const base = this.set.lookup('complexType', this.set.resolveQName(derivation, attr(derivation, 'base') ?? ''));
      const inherited = base && !seen.has(base.node) ? this.typeAttributes(base.node, base.doc, seen) : undefined;
      attributes = overrideAttributes(inherited?.attributes ?? [], this.attributes(derivation, doc, fragment));
      anyAttribute = derivation.localName === 'extension' && inherited?.anyAttribute === true;
    } else {
      attributes = this.attributes(node, doc, fragment);
    }
    return {
      attributes: attributes.filter((a): a is AttributeProp & { prohibited?: false } => !a.prohibited),
      anyAttribute: anyAttribute || fragment.anyAttribute === true,
    };
  }

  /** The property of an element particle: content, description, `xml`, and an array for repetition. */
  private elementProperty(node: Element, doc: SchemaDocument, particle?: Element): Prop | undefined {
    // A global element that stands in for the head of a substitution group is used directly.
    const decl = particle ? this.globalElement(node, doc) : this.elementDeclaration(node, doc);
    if (!decl) {
      return undefined;
    }
    const { min, max } = occurs(particle ?? node);
    const item = this.nillable(decl, this.declarationType(decl));
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
      key: elementKey(decl.ns, decl.name),
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
    const local = attr(decl, 'name') ?? '';
    const id = clark(ns, local);
    const key = attributeKey(ns, local);
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
      schema = { type: 'string' };
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
   * @param fragment - marked with `anyAttribute` when xs:anyAttribute allows other attributes
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
        const group = this.set.lookupRef('attributeGroup', this.set.resolveQName(child, ref), child);
        if (!group) {
          this.problems.error('unknown-group', `attribute group ${ref} is not defined`, this.set.at(child));
        } else if (seen.has(group.node)) {
          this.problems.error('circular-group', `attribute group ${ref} refers to itself`, this.set.at(child));
        } else {
          // A prohibited attribute in an attribute group corresponds to nothing (XML Schema Part 1, 3.2.2): only one
          // written in the restriction itself removes an attribute of the base.
          out.push(
            ...this.attributes(group.node, group.doc, fragment, new Set([...seen, group.node])).filter(
              (a) => !a.prohibited,
            ),
          );
        }
      } else if (child.localName === 'anyAttribute') {
        fragment.anyAttribute = true;
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
    if (isTrue(attr(node, 'mixed')) || (complexContent && isTrue(attr(complexContent, 'mixed')))) {
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
    if (this.allowsElements(node)) {
      this.problems.warning(
        'unsupported-mixed',
        'mixed content is written as a string of XML markup; the elements in it are not checked',
        this.set.at(node),
      );
    }
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
        fragment.anyAttribute = derivation.localName === 'extension' && content.fragment.anyAttribute === true;
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

  /** Whether the content of a complex type can hold an element: its own particles or those it extends. */
  private allowsElements(node: Element, seen = new Set<Element>()): boolean {
    if (seen.has(node)) {
      return false;
    }
    seen.add(node);
    const complexContent = xsChild(node, 'complexContent');
    const derivation = complexContent && xsChildren(complexContent)[0];
    if (this.particlesAllowElements(derivation ?? node, new Set())) {
      return true;
    }
    if (derivation?.localName !== 'extension') {
      return false;
    }
    const base = this.set.lookup('complexType', this.set.resolveQName(derivation, attr(derivation, 'base') ?? ''));
    return base !== undefined && this.allowsElements(base.node, seen);
  }

  /** Whether the particles of a type, derivation, model group or group definition contain an element or xs:any. */
  private particlesAllowElements(owner: Element, groups: Set<Element>): boolean {
    return xsChildren(owner).some((child) => {
      if (occurs(child).max === 0) {
        return false;
      }
      switch (child.localName) {
        case 'element':
        case 'any':
          return true;
        case 'sequence':
        case 'choice':
        case 'all':
          return this.particlesAllowElements(child, groups);
        case 'group': {
          const group = this.set.lookupRef('group', this.set.resolveQName(child, attr(child, 'ref') ?? ''), child);
          if (!group || groups.has(group.node)) {
            return false;
          }
          groups.add(group.node);
          return this.particlesAllowElements(group.node, groups);
        }
        default:
          return false;
      }
    });
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
    const baseQName = attr(derivation, 'base') ?? '';
    const baseName = this.set.resolveQName(derivation, baseQName);
    const complexBase = baseName.ns === XS ? undefined : this.set.lookup('complexType', baseName);
    let value: JsonSchema | undefined;
    let inherited: AttributeProp[] = [];
    if (complexBase) {
      const base = this.content(complexBase.node, complexBase.doc, seen);
      inherited = base.attributes;
      // An extension keeps the attribute wildcard of its base; a restriction states its own.
      fragment.anyAttribute = derivation.localName === 'extension' && base.fragment.anyAttribute === true;
      value = base.fragment.props.find((prop) => prop.key === this.options.textProperty)?.schema;
      if (value === undefined) {
        this.problems.error(
          'unsupported-simple-content',
          `base type ${baseQName} has no simple content; the text is written as a string`,
          this.set.at(derivation),
        );
      }
    }
    // A restriction with facets or a simple type of its own narrows the text of its base.
    const narrows =
      derivation.localName === 'restriction' &&
      (textFacets(derivation).length > 0 || xsChild(derivation, 'simpleType') !== undefined);
    if (narrows && (value !== undefined || !complexBase)) {
      const text = this.derivedTextType(derivation);
      value = text === undefined ? value : this.textSchema(this.simple.schema(text, derivation));
    }
    if (value === undefined) {
      value = this.textSchema(complexBase ? { type: 'string' } : this.typeRef(baseName, derivation));
    }
    fragment.props.push({ key: this.options.textProperty, schema: value, node: derivation });
    fragment.required.push(this.options.textProperty);
    return { fragment, attributes: overrideAttributes(inherited, this.attributes(derivation, doc, fragment)) };
  }

  /** The schema of the text property: the value with `xml.text`, keeping its whiteSpace. */
  private textSchema(value: JsonSchema): JsonSchema {
    return this.options.xml ? { ...value, xml: withTypeXml({ text: true }, value) } : value;
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
      properties[attribute.key] = attribute.schema;
      if (attribute.required) {
        required.push(attribute.key);
      }
    }
    for (const prop of fragment.props) {
      properties[prop.key] = prop.schema;
    }
    required.push(...fragment.required.filter((key) => !required.includes(key)));
    // xsi:type may name a named type, also the declared one: its objects may say so in `#type`.
    const name = attr(node, 'name');
    if (name !== undefined && Object.hasOwn(properties, '#type')) {
      this.problems.error(
        'duplicate-name',
        `the repeated group type of ${name} has the property #type, which xsi:type needs`,
        this.set.at(node),
      );
    }
    const typed =
      name !== undefined && !Object.hasOwn(properties, '#type')
        ? { '#type': this.typeProperty([clark(doc.targetNamespace, name)]), ...properties }
        : properties;
    writeObject(schema, typed, required, fragment, this.options.xml);
    const plan = planKeys(Object.keys(typed), this.options.textProperty);
    for (const clash of renameObject(schema, plan, this.options.xml)) {
      this.problems.error('duplicate-name', `${clash} is the name of two properties`, this.set.at(node));
    }
    return schema;
  }
}

const isTrue = (value: string | undefined): boolean => value === 'true' || value === '1';

/** How many anonymous complex types of local elements are written in place, one inside the other. */
const MAX_INLINE_DEPTH = 64;
/** How deep anonymous complex types of local elements may nest at all; a validator could not follow deeper. */
const MAX_LOCAL_DEPTH = 1000;

/** The facets of a simpleContent restriction: its children apart from attributes, a simple type and 1.1 content. */
function textFacets(derivation: Element): Element[] {
  const other = ['attribute', 'attributeGroup', 'anyAttribute', 'simpleType', ...XSD_1_1_CONTENT];
  return xsChildren(derivation).filter((c) => !other.includes(c.localName ?? ''));
}

// Attributes of a restriction or extension replace those of the base with the same name.
function overrideAttributes(base: AttributeProp[], own: AttributeProp[]): AttributeProp[] {
  const byId = new Map(base.map((a) => [a.id, a]));
  for (const attribute of own) {
    byId.set(attribute.id, attribute);
  }
  return [...byId.values()].filter((a) => !a.prohibited);
}

/** A schema with the keywords of a fixed or default value, its `allOf` joined to the schema's own. */
function withValuesOf(schema: JsonSchema, values: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema, ...without(values, 'pattern') };
  if (schema.allOf && values.allOf) {
    out.allOf = [...schema.allOf, ...values.allOf];
  }
  return out;
}

/** Adds a pattern to a schema; next to a pattern of its own, as one more part of `allOf`. */
function withPattern(schema: JsonSchema, pattern: string | undefined): JsonSchema {
  if (pattern === undefined) {
    return schema;
  }
  if (schema.pattern === undefined) {
    return { ...schema, pattern };
  }
  return { ...schema, allOf: [...(schema.allOf ?? []), { pattern }] };
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
    out.xml = withTypeXml(xml, schema);
  }
  return out;
}

/** What the `xml` annotation of a type written in place says about its values, kept next to that of a property. */
const TYPE_XML = [
  'whiteSpace',
  'list',
  'type',
  'decimal',
  'nillable',
  'anyElement',
  'anyAttribute',
  'anyType',
] as const;

/** The `xml` annotation of a property, keeping what the annotation of a type written in place says about values. */
function withTypeXml(xml: XmlAnnotation, schema: JsonSchema): XmlAnnotation {
  const out: XmlAnnotation = { ...xml };
  for (const key of TYPE_XML) {
    const value = schema.xml?.[key];
    if (value !== undefined) {
      Object.assign(out, { [key]: value });
    }
  }
  return out;
}

function without(schema: JsonSchema, key: keyof JsonSchema): JsonSchema {
  const copy = { ...schema };
  delete copy[key];
  return copy;
}
