// Content models: how the particles of a complex type (elements, sequences, choices, `all` and group references)
// become the properties and constraints of one JSON object.
//
// Each model group is turned into a Fragment: its properties in document order, the properties it requires when it
// occurs, and one `oneOf` per choice. A sequence merges the fragments of its particles. A choice keeps the
// properties of all its branches and adds a `oneOf` in which each branch requires its own properties and sets those
// of the other branches to `false`. The emitter then writes the fragment of a complex type as one closed object.
//
// Example: the sequence (Kind, choice(Signature | sequence(Street, Number?))) becomes
//
//   properties: Kind, Signature, Street, Number
//   required:   Kind
//   oneOf:      [{ required: [Signature], properties: { Street: false, Number: false } },
//                { required: [Street], properties: { Signature: false } }]
//
// A group that can repeat stays together: it is one property, an array with an object per occurrence, so
// (a, b){1,3} becomes `#sequence: [{ a, b }, { a, b }]`. Two particles of one element name share an array.

import type { Element } from '@xmldom/xmldom';
import type { JsonSchema } from './json-schema.js';
import { planKeys, renameObject } from './keys.js';
import type { Problems } from './problems.js';
import { attr, type SchemaDocument, type SchemaSet, xsChildren } from './schema-set.js';

/** A property of an object, from an element particle, a repeated group or the text of simple content. */
export interface Prop {
  key: string;
  schema: JsonSchema;
  /** where problems with the property are reported */
  node: Element;
  /** how often its particle occurs; the text of simple content has none */
  occurrences?: Occurrences;
}

/** How often a particle occurs in an object, so that two particles of one name can share an array. */
export interface Occurrences {
  /** two particles can share a property only if this is the same */
  identity: string;
  /** at least this many if the property is there */
  min: number;
  max: number;
  /** the fragment can occur without this particle */
  optional?: boolean;
  /** the schema of the property as an array with these bounds */
  array(min: number, max: number): JsonSchema;
}

/**
 * The property names of the repeated groups of one object: `#sequence`, `#choice` or, for a reference, `#` and the
 * name of the group; a further group of the same name adds `:2`, `:3`. No XML name can contain `#` or, in a local name,
 * `:`, so these cannot collide with an element or attribute. The same group reached twice shares its property.
 */
export class GroupKeys {
  private readonly keys = new Map<Element, string>();
  private readonly counts = new Map<string, number>();

  /** @param group - the group definition of a reference, or the particle of an anonymous group */
  keyOf(group: Element, name: string): string {
    let key = this.keys.get(group);
    if (key === undefined) {
      const count = (this.counts.get(name) ?? 0) + 1;
      this.counts.set(name, count);
      key = count === 1 ? `#${name}` : `#${name}:${count}`;
      this.keys.set(group, key);
    }
    return key;
  }
}

/** What a model group contributes to an object, with the properties it requires when it occurs once. */
export interface Fragment {
  /** in document order */
  props: Prop[];
  required: string[];
  /** one `{oneOf}` per choice */
  constraints: JsonSchema[];
  dependentRequired: Record<string, string[]>;
  /** the fragment is a choice reached through a group reference */
  isChoice?: boolean;
  /** xs:any allows other elements, so the object accepts other properties */
  anyElement?: boolean;
  /** xs:anyAttribute allows other attributes, so the object accepts other properties */
  anyAttribute?: boolean;
  /** shared by all fragments of one object */
  groupKeys: GroupKeys;
}

/**
 * The property of an element particle; the emitter writes it, since it knows declarations and types.
 *
 * @param particle - the particle whose occurrences count, when `node` is a global element that stands in for it
 */
export type ElementProperty = (node: Element, doc: SchemaDocument, particle?: Element) => Prop | undefined;

/** The global elements that may appear for an element particle; undefined if it has no substitution group. */
export type Substitutes = (node: Element) => { node: Element; doc: SchemaDocument }[] | undefined;

export function emptyFragment(groupKeys = new GroupKeys()): Fragment {
  return { props: [], required: [], constraints: [], dependentRequired: {}, groupKeys };
}

export function occurs(node: Element): { min: number; max: number } {
  const min = attr(node, 'minOccurs');
  const max = attr(node, 'maxOccurs');
  return {
    min: min === undefined ? 1 : Number(min),
    max: max === undefined ? 1 : max === 'unbounded' ? Infinity : Number(max),
  };
}

/** Writes the choices of a fragment into an object schema: one `oneOf` directly, several as an `allOf`. */
export function addConstraints(schema: JsonSchema, constraints: JsonSchema[]): void {
  const [only] = constraints;
  // One constraint joins the schema, unless a keyword of it is there already.
  if (constraints.length === 1 && only && Object.keys(only).every((key) => !Object.hasOwn(schema, key))) {
    Object.assign(schema, only);
  } else if (constraints.length > 0) {
    schema.allOf = constraints;
  }
}

/** Takes over the wildcards of `inner`. */
export function addWildcards(fragment: Fragment, inner: Fragment): void {
  if (inner.anyElement) {
    fragment.anyElement = true;
  }
  if (inner.anyAttribute) {
    fragment.anyAttribute = true;
  }
}

/**
 * Writes properties and the constraints of a fragment into an object schema. An object with a wildcard stays open
 * and says which wildcard it has in `xml`.
 *
 * @param xml - write the `xml` annotation
 */
export function writeObject(
  schema: JsonSchema,
  properties: Record<string, JsonSchema>,
  required: string[],
  fragment: Fragment,
  xml: boolean,
): void {
  if (Object.keys(properties).length > 0) {
    schema.properties = properties;
  }
  if (required.length > 0) {
    schema.required = required;
  }
  if (!fragment.anyElement && !fragment.anyAttribute) {
    schema.additionalProperties = false;
  }
  if (Object.keys(fragment.dependentRequired).length > 0) {
    schema.dependentRequired = fragment.dependentRequired;
  }
  addConstraints(schema, fragment.constraints);
  if (xml && (fragment.anyElement || fragment.anyAttribute)) {
    schema.xml = {
      ...(fragment.anyElement ? { anyElement: true } : {}),
      ...(fragment.anyAttribute ? { anyAttribute: true } : {}),
    };
  }
}

function addRequired(fragment: Fragment, keys: string[]): void {
  fragment.required.push(...new Set(keys.filter((key) => !fragment.required.includes(key))));
}

/** How many occurrences a particle is sure to add when its fragment occurs. */
const certain = (occurrences: Occurrences): number => (occurrences.optional ? 0 : occurrences.min);

/**
 * Stops the choices of a schema from telling branches apart by `key`, which also occurs outside them. Without the
 * `false` of a branch two branches can match, so the choice becomes an `anyOf`.
 *
 * @returns whether anything changed
 */
function relaxConstraint(schema: JsonSchema, key: string): boolean {
  let changed = false;
  if (schema.dependentRequired?.[key] !== undefined) {
    delete schema.dependentRequired[key];
    if (Object.keys(schema.dependentRequired).length === 0) {
      delete schema.dependentRequired;
    }
    changed = true;
  }
  if (schema.dependentSchemas?.[key] !== undefined) {
    delete schema.dependentSchemas[key];
    if (Object.keys(schema.dependentSchemas).length === 0) {
      delete schema.dependentSchemas;
    }
    changed = true;
  }
  let removed = false;
  for (const branch of [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])]) {
    // An anchor that also occurs outside the choice no longer tells its branches apart.
    if (branch.required?.length === 1 && branch.required[0] === key && Object.keys(branch).length === 1) {
      removed = true;
    }
    if (branch.properties?.[key] !== undefined) {
      delete branch.properties[key];
      if (Object.keys(branch.properties).length === 0) {
        delete branch.properties;
      }
      removed = true;
    }
    removed = relaxConstraint(branch, key) || removed;
  }
  if (removed && schema.oneOf) {
    schema.anyOf = schema.oneOf;
    delete schema.oneOf;
  }
  return changed || removed;
}

export class ContentModel {
  /** the `{oneOf}` of each choice that can be left out: an optional choice, or one with a branch that can be empty */
  private readonly optionalChoices = new WeakSet<JsonSchema>();

  constructor(
    private readonly set: SchemaSet,
    private readonly problems: Problems,
    private readonly elementProperty: ElementProperty,
    /** write the `xml` annotations */
    private readonly xml: boolean,
    private readonly substitutes: Substitutes = () => undefined,
    /** the property for the text of an element, which an element name must not take */
    private readonly textProperty = 'value',
  ) {}

  /** Adds the model group of a complex type or derivation (its sequence, all, choice or group) to `fragment`. */
  compositor(owner: Element, doc: SchemaDocument, fragment: Fragment): void {
    const model = xsChildren(owner).find((c) => ['sequence', 'all', 'choice', 'group'].includes(c.localName ?? ''));
    if (model) {
      this.particle(model, doc, fragment, new Set());
    }
  }

  /**
   * Adds the properties and constraints of `inner` to `fragment`.
   *
   * @param withRequired - also require what `inner` requires; false for an optional group
   */
  merge(fragment: Fragment, inner: Fragment, withRequired: boolean): void {
    if (withRequired) {
      addRequired(fragment, inner.required);
    }
    fragment.constraints.push(...inner.constraints);
    addWildcards(fragment, inner);
    for (const [key, list] of Object.entries(inner.dependentRequired)) {
      fragment.dependentRequired[key] = [...new Set([...(fragment.dependentRequired[key] ?? []), ...list])];
    }
    for (const prop of inner.props) {
      this.addProp(fragment, withRequired ? prop : optionally(prop));
    }
  }

  /** The fragment of a model group (sequence, all or choice) when it occurs once. */
  private group(node: Element, doc: SchemaDocument, seen: Set<Element>, keys: GroupKeys): Fragment {
    if (node.localName === 'choice') {
      return this.choice(node, doc, false, seen, keys);
    }
    const fragment = emptyFragment(keys);
    for (const child of xsChildren(node)) {
      this.particle(child, doc, fragment, seen);
    }
    return fragment;
  }

  /**
   * Adds one particle of a sequence or all to `fragment`.
   *
   * @param seen - the named groups on the way here, to stop a group that contains itself
   */
  private particle(child: Element, doc: SchemaDocument, fragment: Fragment, seen: Set<Element>): void {
    const { min, max } = occurs(child);
    if (max === 0) {
      // XML Schema maps a particle with maxOccurs="0" to nothing: the element may not occur.
      return;
    }
    switch (child.localName) {
      case 'element': {
        const members = this.substitutes(child);
        if (members) {
          this.substitutionGroup(child, members, fragment, min, max);
          return;
        }
        const prop = this.elementProperty(child, doc);
        if (prop) {
          this.addProp(fragment, prop);
          if (min > 0) {
            addRequired(fragment, [prop.key]);
          }
        }
        return;
      }
      case 'sequence':
      case 'all':
      case 'choice':
      case 'group': {
        // Each occurrence of a repeated group is an object of its own, with its own names.
        const repeated = max > 1;
        const keys = repeated ? new GroupKeys() : fragment.groupKeys;
        const optional = min === 0 && !repeated;
        let inner: Fragment | undefined;
        if (child.localName === 'group') {
          inner = this.groupReference(child, optional, seen, keys);
        } else if (child.localName === 'choice') {
          inner = this.choice(child, doc, optional, seen, keys);
        } else {
          inner = this.group(child, doc, seen, keys);
        }
        if (!inner) {
          return;
        }
        if (repeated) {
          this.repeatedGroup(fragment, child, inner, min, max);
          return;
        }
        if (min > 0 || child.localName === 'choice' || inner.isChoice) {
          this.merge(fragment, inner, true);
        } else {
          this.optionalGroup(fragment, inner);
        }
        return;
      }
      case 'any':
        fragment.anyElement = true;
        this.problems.warning(
          'unsupported-any',
          'xs:any: the object accepts other properties without checking them',
          this.set.at(child),
        );
        return;
      default:
        this.problems.error('unsupported-particle', `xs:${child.localName} is not supported here`, this.set.at(child));
    }
  }

  /**
   * A particle that refers to the head of a substitution group: a choice between the head, unless it is abstract,
   * and its members, with the occurrences of the particle. With `maxOccurs` greater than 1, each member that occurs
   * is an array; how many there are together isn't checked.
   */
  private substitutionGroup(
    child: Element,
    members: { node: Element; doc: SchemaDocument }[],
    fragment: Fragment,
    min: number,
    max: number,
  ): void {
    if (members.length === 0) {
      this.problems.error(
        'unsupported-element',
        `${attr(child, 'ref') ?? ''} is abstract and no element may stand in for it`,
        this.set.at(child),
      );
      return;
    }
    if (max <= 1) {
      const branches = members.flatMap((member) => {
        const branch = emptyFragment(fragment.groupKeys);
        const prop = this.elementProperty(member.node, member.doc, child);
        if (!prop) {
          return [];
        }
        this.addProp(branch, prop);
        addRequired(branch, [prop.key]);
        return [{ fragment: branch, node: child }];
      });
      this.merge(fragment, this.choiceOf(branches, min === 0, fragment.groupKeys), true);
      return;
    }
    const keys: string[] = [];
    for (const member of members) {
      const prop = this.elementProperty(member.node, member.doc, child);
      if (!prop?.occurrences) {
        continue;
      }
      // Each member alone may occur up to maxOccurs times; at least one of them as often as minOccurs says.
      const occurrences = { ...prop.occurrences, min: 0, optional: true };
      this.addProp(fragment, { ...prop, schema: occurrences.array(0, max), occurrences });
      keys.push(prop.key);
    }
    // The members share one particle: at least one of them if it is required. Optional, the branch without any of
    // them says the same, so that a reader still sees which properties belong to the particle.
    if (keys.length > 0) {
      const alternatives: JsonSchema[] = keys.map((key) => ({ required: [key] }));
      if (min === 0) {
        alternatives.push({ properties: Object.fromEntries(keys.map((key) => [key, false])) });
      }
      fragment.constraints.push({ anyOf: alternatives });
    }
  }

  private groupReference(node: Element, optional: boolean, seen: Set<Element>, keys: GroupKeys): Fragment | undefined {
    const ref = attr(node, 'ref') ?? '';
    const found = this.set.lookupRef('group', this.set.resolveQName(node, ref), node);
    if (!found) {
      this.problems.error('unknown-group', `group ${ref} is not defined`, this.set.at(node));
      return undefined;
    }
    if (seen.has(found.node)) {
      this.problems.error('circular-group', `group ${ref} contains itself`, this.set.at(node));
      return undefined;
    }
    const compositor = xsChildren(found.node)[0];
    if (!compositor) {
      return emptyFragment(keys);
    }
    const inner = new Set([...seen, found.node]);
    if (compositor.localName === 'choice') {
      const fragment = this.choice(compositor, found.doc, optional, inner, keys);
      fragment.isChoice = true;
      return fragment;
    }
    return this.group(compositor, found.doc, inner, keys);
  }

  /** A group that can occur more than once: one property, an array with an object per occurrence. */
  private repeatedGroup(fragment: Fragment, node: Element, inner: Fragment, min: number, max: number): void {
    const definition =
      node.localName === 'group'
        ? this.set.lookupRef('group', this.set.resolveQName(node, attr(node, 'ref') ?? ''), node)
        : undefined;
    const key = fragment.groupKeys.keyOf(
      definition?.node ?? node,
      definition ? (attr(definition.node, 'name') ?? '') : (node.localName ?? ''),
    );
    // The name of the text property is reserved in every object, such as `#text` for a group named text.
    if (key === this.textProperty) {
      this.problems.error(
        'duplicate-name',
        `the repeated group ${key} has the name of the text property, which every object reserves`,
        this.set.at(node),
      );
    }
    const item: JsonSchema = { type: 'object' };
    writeObject(
      item,
      Object.fromEntries(inner.props.map((prop) => [prop.key, prop.schema])),
      inner.required,
      inner,
      this.xml,
    );
    renameObject(item, planKeys(Object.keys(item.properties ?? {}), this.textProperty), this.xml);
    const array = (low: number, high: number): JsonSchema => {
      const list: JsonSchema = { type: 'array', items: item };
      if (low > 0) {
        list.minItems = low;
      }
      if (high !== Infinity) {
        list.maxItems = high;
      }
      if (this.xml) {
        list.xml = { group: true };
      }
      return list;
    };
    // An occurrence without any element leaves no trace in XML, so a group that can be empty need not appear.
    const least = this.canBeEmpty(inner) ? 0 : min;
    this.addProp(fragment, {
      key,
      schema: array(least, max),
      node,
      occurrences: { identity: JSON.stringify(item), min: least, max, array },
    });
    if (least > 0) {
      addRequired(fragment, [key]);
    }
  }

  // An optional sequence: its properties are optional, but once one of them occurs, the members it requires must too.
  private optionalGroup(fragment: Fragment, inner: Fragment): void {
    if (inner.constraints.length > 0) {
      this.merge(fragment, this.wholeOrNothing(inner), false);
      return;
    }
    for (const prop of inner.props) {
      const others = inner.required.filter((key) => key !== prop.key);
      if (others.length > 0) {
        const list = inner.dependentRequired[prop.key] ?? [];
        inner.dependentRequired[prop.key] = [...new Set([...list, ...others])];
      }
    }
    this.merge(fragment, inner, false);
  }

  /** An optional sequence with a choice in it, as a constraint: none of its properties, or the whole sequence. */
  private wholeOrNothing(inner: Fragment): Fragment {
    const whole: JsonSchema = {};
    if (inner.required.length > 0) {
      whole.required = inner.required;
    }
    if (Object.keys(inner.dependentRequired).length > 0) {
      whole.dependentRequired = inner.dependentRequired;
    }
    addConstraints(whole, inner.constraints);
    const nothing: JsonSchema = { properties: Object.fromEntries(inner.props.map((prop) => [prop.key, false])) };
    const constraint: JsonSchema = this.canBeEmpty(inner) ? { anyOf: [nothing, whole] } : { oneOf: [nothing, whole] };
    this.optionalChoices.add(constraint);
    const fragment = emptyFragment(inner.groupKeys);
    fragment.props = inner.props;
    fragment.constraints = [constraint];
    addWildcards(fragment, inner);
    return fragment;
  }

  /**
   * A choice becomes one `oneOf`, or an `anyOf` if several branches can match. The properties of all branches belong
   * to the enclosing object, so the object stays closed and keeps the document order.
   *
   * @param optional - the choice may be left out; adds a branch without any of its properties
   */
  private choice(node: Element, doc: SchemaDocument, optional: boolean, seen: Set<Element>, keys: GroupKeys): Fragment {
    const branches: { fragment: Fragment; node: Element }[] = [];
    for (const child of xsChildren(node)) {
      if (occurs(child).max === 0) {
        continue;
      }
      const branch = emptyFragment(keys);
      this.particle(child, doc, branch, seen);
      if (child.localName !== 'element' && occurs(child).min === 0) {
        branch.required = [];
      }
      branches.push({ fragment: branch, node: child });
    }
    return this.choiceOf(branches, optional, keys);
  }

  /** The fragment of a choice between `branches`, as described for `choice`. */
  private choiceOf(branches: { fragment: Fragment; node: Element }[], optional: boolean, keys: GroupKeys): Fragment {
    const fragment = emptyFragment(keys);
    // A choice without particles (all of them may occur 0 times) matches nothing (XML Schema Part 1, 3.8.4): left
    // out, it adds nothing; required, no object meets it. JSON Schema has no empty `oneOf`.
    if (branches.length === 0) {
      if (!optional) {
        fragment.constraints.push({ not: {} });
      }
      return fragment;
    }
    for (const { fragment: branch } of branches) {
      addWildcards(fragment, branch);
    }
    for (const { fragment: branch, node: child } of branches) {
      for (const prop of branch.props) {
        const existing = fragment.props.find((p) => p.key === prop.key);
        if (!existing) {
          fragment.props.push({ ...prop });
        } else if (existing.occurrences?.identity !== prop.occurrences?.identity || !prop.occurrences) {
          this.problems.error('duplicate-name', `${prop.key} occurs in two branches of a choice`, this.set.at(child));
        } else {
          this.joinAlternative(existing, prop.occurrences);
        }
      }
    }
    for (const prop of fragment.props) {
      if (optional || branches.some((b) => !hasKey(b.fragment, prop.key))) {
        Object.assign(prop, optionally(prop));
      }
    }
    const empty = branches.filter((b) => this.canBeEmpty(b.fragment));
    const shared = fragment.props.some((prop) => branches.filter((b) => hasKey(b.fragment, prop.key)).length > 1);
    if (!shared && empty.length === 0 && branches.every((b) => b.fragment.required.length > 0)) {
      return this.anchoredChoice(fragment, branches, optional);
    }
    const alternatives = branches.map(({ fragment: branch }) => {
      const schema: JsonSchema = {};
      if (branch.required.length > 0) {
        schema.required = branch.required;
      }
      const properties = branchProperties(fragment, branch);
      if (Object.keys(properties).length > 0) {
        schema.properties = properties;
      }
      if (Object.keys(branch.dependentRequired).length > 0) {
        schema.dependentRequired = branch.dependentRequired;
      }
      addConstraints(schema, branch.constraints);
      return schema;
    });
    if (optional && empty.length === 0) {
      alternatives.push({ properties: Object.fromEntries(fragment.props.map((prop) => [prop.key, false])) });
    }
    // Branches that share a property or can both be empty can match together; what only one branch has still keeps
    // the others out. This form grows with the square of the number of branches.
    const constraint: JsonSchema = shared || empty.length > 1 ? { anyOf: alternatives } : { oneOf: alternatives };
    if (optional || empty.length > 0) {
      this.optionalChoices.add(constraint);
    }
    fragment.constraints.push(constraint);
    return fragment;
  }

  /**
   * A choice whose branches each require a property and share none, written in a size that grows linearly with the
   * branches: each branch has an anchor, its first required property. Exactly one anchor is there (`oneOf`), or none
   * for an optional choice; every other property of a branch needs the anchor of its branch (`dependentRequired`);
   * and with its anchor, the rest of a branch applies (`dependentSchemas`).
   */
  private anchoredChoice(
    fragment: Fragment,
    branches: { fragment: Fragment; node: Element }[],
    optional: boolean,
  ): Fragment {
    const anchors: string[] = [];
    const dependentRequired: Record<string, string[]> = {};
    const dependentSchemas: Record<string, JsonSchema> = {};
    for (const { fragment: branch } of branches) {
      const anchor = branch.required[0] ?? '';
      anchors.push(anchor);
      for (const prop of branch.props) {
        if (prop.key !== anchor) {
          dependentRequired[prop.key] = [anchor];
        }
      }
      const rest: JsonSchema = {};
      if (branch.required.length > 1) {
        rest.required = branch.required.slice(1);
      }
      if (Object.keys(branch.dependentRequired).length > 0) {
        rest.dependentRequired = branch.dependentRequired;
      }
      addConstraints(rest, branch.constraints);
      if (Object.keys(rest).length > 0) {
        dependentSchemas[anchor] = rest;
      }
    }
    const alternatives: JsonSchema[] = anchors.map((anchor) => ({ required: [anchor] }));
    if (optional) {
      alternatives.push({ properties: Object.fromEntries(anchors.map((anchor) => [anchor, false])) });
    }
    const constraint: JsonSchema = { oneOf: alternatives };
    if (Object.keys(dependentRequired).length > 0) {
      constraint.dependentRequired = dependentRequired;
    }
    if (Object.keys(dependentSchemas).length > 0) {
      constraint.dependentSchemas = dependentSchemas;
    }
    if (optional) {
      this.optionalChoices.add(constraint);
    }
    fragment.constraints.push(constraint);
    return fragment;
  }

  /** Whether a fragment can occur without any of its properties: it requires none, and its choices can be left out. */
  private canBeEmpty(fragment: Fragment): boolean {
    return fragment.required.length === 0 && fragment.constraints.every((c) => this.optionalChoices.has(c));
  }

  /** Two branches of a choice declare one name: an array with the bounds of either branch. */
  private joinAlternative(existing: Prop, other: Occurrences): void {
    const own = existing.occurrences as Occurrences;
    const min = Math.min(own.min, other.min);
    const max = Math.max(own.max, other.max);
    existing.occurrences = { ...own, min, max, optional: own.optional === true || other.optional === true };
    existing.schema = own.array(min, max);
  }

  /** Adds a property. Two particles of one element name share an array that holds the occurrences of both. */
  private addProp(fragment: Fragment, prop: Prop): void {
    const existing = fragment.props.find((p) => p.key === prop.key);
    if (!existing) {
      fragment.props.push(prop);
      return;
    }
    const own = existing.occurrences;
    const other = prop.occurrences;
    if (!own || !other || own.identity !== other.identity) {
      this.problems.error('duplicate-name', `${prop.key} occurs twice in one object`, this.set.at(prop.node));
      return;
    }
    const min = certain(own) + certain(other);
    const max = own.max + other.max;
    existing.occurrences = { ...own, min, max, optional: false };
    existing.schema = own.array(min, max);
    this.relax(fragment, prop);
  }

  /** `prop` now also occurs outside a choice or optional group of `fragment`, which can no longer depend on it. */
  private relax(fragment: Fragment, prop: Prop): void {
    const holder: JsonSchema = { allOf: fragment.constraints, dependentRequired: fragment.dependentRequired };
    if (relaxConstraint(holder, prop.key)) {
      fragment.dependentRequired = holder.dependentRequired ?? {};
      this.problems.warning(
        'approximated-occurrences',
        `${prop.key} occurs inside and outside a choice or optional group; the schema does not tie it to the group`,
        this.set.at(prop.node),
      );
    }
  }
}

const hasKey = (fragment: Fragment, key: string): boolean => fragment.props.some((prop) => prop.key === key);

/** The same property for a fragment that can occur without it. */
function optionally(prop: Prop): Prop {
  return prop.occurrences ? { ...prop, occurrences: { ...prop.occurrences, optional: true } } : prop;
}

/** What one branch of a choice says about the properties of the choice: `false` for those of the other branches. */
function branchProperties(choice: Fragment, branch: Fragment): Record<string, JsonSchema | boolean> {
  const properties: Record<string, JsonSchema | boolean> = {};
  for (const prop of choice.props) {
    const own = branch.props.find((p) => p.key === prop.key);
    if (!own) {
      properties[prop.key] = false;
    } else if (own.occurrences && prop.occurrences) {
      // Branches that share an array can differ in how many items they allow.
      const bounds: JsonSchema = {};
      if (own.occurrences.min > prop.occurrences.min) {
        bounds.minItems = own.occurrences.min;
      }
      if (own.occurrences.max < prop.occurrences.max) {
        bounds.maxItems = own.occurrences.max;
      }
      if (Object.keys(bounds).length > 0) {
        properties[prop.key] = { type: 'array', ...bounds };
      }
    }
  }
  return properties;
}
