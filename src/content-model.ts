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

import type { Element } from '@xmldom/xmldom';
import type { JsonSchema } from './json-schema.js';
import type { Problems } from './problems.js';
import { attr, type SchemaDocument, type SchemaSet, xsChildren } from './schema-set.js';

/** A property of an object, from an element particle or the text of simple content. */
export interface Prop {
  key: string;
  schema: JsonSchema;
  /** where problems with the property are reported */
  node: Element;
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
}

/** The property of an element particle; the emitter writes it, since it knows declarations and types. */
export type ElementProperty = (node: Element, doc: SchemaDocument) => Prop | undefined;

export function emptyFragment(): Fragment {
  return { props: [], required: [], constraints: [], dependentRequired: {} };
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
  if (constraints.length === 1) {
    Object.assign(schema, constraints[0]);
  } else if (constraints.length > 1) {
    schema.allOf = constraints;
  }
}

export class ContentModel {
  constructor(
    private readonly set: SchemaSet,
    private readonly problems: Problems,
    private readonly elementProperty: ElementProperty,
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
            this.set.at(child),
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
        this.problems.error(
          'unsupported-any',
          'xs:any is not supported; its elements are rejected',
          this.set.at(child),
        );
        return;
      default:
        this.problems.error('unsupported-particle', `xs:${child.localName} is not supported here`, this.set.at(child));
    }
  }

  private groupReference(node: Element, optional: boolean, seen: Set<Element>): Fragment | undefined {
    const ref = attr(node, 'ref') ?? '';
    const found = this.set.lookup('group', this.set.resolveQName(node, ref));
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
        this.set.at(node),
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
   *
   * @param optional - the choice may be left out; adds a branch without any of its properties
   */
  private choice(node: Element, doc: SchemaDocument, optional: boolean, seen: Set<Element>): Fragment {
    const branches: { fragment: Fragment; node: Element }[] = [];
    for (const child of xsChildren(node)) {
      if (occurs(child).max === 0) {
        continue;
      }
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
          this.problems.error('duplicate-name', `${prop.key} occurs in two branches of a choice`, this.set.at(child));
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
        this.set.at(node),
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
      this.problems.error('duplicate-name', `${prop.key} occurs twice in one object`, this.set.at(prop.node));
      return;
    }
    fragment.props.push(prop);
  }
}
