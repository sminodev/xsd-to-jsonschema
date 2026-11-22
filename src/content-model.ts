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
import { Deferral, type RelaxCounter, Relaxer } from './relax.js';
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
  private readonly groups = new Map<string, Element>();
  private readonly counts = new Map<string, number>();

  /** @param group - the group definition of a reference, or the particle of an anonymous group */
  keyOf(group: Element, name: string): string {
    let key = this.keys.get(group);
    if (key === undefined) {
      const count = (this.counts.get(name) ?? 0) + 1;
      this.counts.set(name, count);
      key = count === 1 ? `#${name}` : `#${name}:${count}`;
      this.keys.set(group, key);
      this.groups.set(key, group);
    }
    return key;
  }

  /** The key a group already has in this object. */
  get(group: Element): string | undefined {
    return this.keys.get(group);
  }

  /** The group that has `key` in this object. */
  groupOf(key: string): Element | undefined {
    return this.groups.get(key);
  }
}

/** Learns the final property names of the objects that are written; see structure.ts. */
export interface Recorder {
  /** the object of a complex type, or of one occurrence of a repeated group (`node` is then its particle) */
  object(node: Element, plan: Map<string, string>, groupKeys: GroupKeys): void;
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

/** Whether the derivation adds no content particle, including through group references. */
export function emptyContent(derivation: Element, set: SchemaSet): boolean {
  const model = xsChildren(derivation).find((child) =>
    ['sequence', 'all', 'choice', 'group'].includes(child.localName ?? ''),
  );
  if (!model) {
    return true;
  }
  const pending: { particle: Element; finishing: boolean }[] = [{ particle: model, finishing: false }];
  const open = new Set<Element>();
  const empty = new Set<Element>();
  while (pending.length > 0) {
    const { particle, finishing } = pending.pop()!;
    if (finishing) {
      open.delete(particle);
      empty.add(particle);
      continue;
    }
    const { min, max } = occurs(particle);
    if (max === 0 || empty.has(particle)) {
      continue;
    }
    if (open.has(particle)) {
      return false;
    }
    let parts: Element[];
    if (particle.localName === 'group') {
      const group = set.lookupRef('group', set.resolveQName(particle, attr(particle, 'ref') ?? ''), particle);
      const child = group && xsChildren(group.node)[0];
      if (!child) {
        return false;
      }
      parts = [child];
    } else {
      parts = xsChildren(particle);
      switch (particle.localName) {
        case 'choice':
          if (parts.length > 0 || min !== 0) {
            return false;
          }
          break;
        case 'all':
        case 'sequence':
          break;
        default:
          return false;
      }
    }
    open.add(particle);
    pending.push({ particle, finishing: true });
    for (const child of parts) {
      pending.push({ particle: child, finishing: false });
    }
  }
  return true;
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

// The required keys of each fragment as a set, caught up like the index of its properties: the list is only appended
// to or replaced.
const requiredSets = new WeakMap<string[], { size: number; keys: Set<string> }>();

function addRequired(fragment: Fragment, keys: string[]): void {
  const required = fragment.required;
  let known = requiredSets.get(required);
  if (!known) {
    known = { size: 0, keys: new Set() };
    requiredSets.set(required, known);
  }
  for (; known.size < required.length; known.size += 1) {
    known.keys.add(required[known.size] as string);
  }
  const seen = known.keys;
  required.push(...new Set(keys.filter((key) => !seen.has(key))));
}

/** How many occurrences a particle is sure to add when its fragment occurs. */
const certain = (occurrences: Occurrences): number => (occurrences.optional ? 0 : occurrences.min);

/** Counts what a content model writes, for `maxOutputEntries`; see the emitter. */
export interface Counter extends RelaxCounter {
  /** an object schema written, with its final names */
  written(schema: JsonSchema): void;
  /**
   * a constraint made: its maps and alternatives, apart from the entries of `apart`, parts that relaxing will probably
   * remove; they count once `settle` says they stay
   */
  constraint(schema: JsonSchema, apart?: readonly JsonSchema[]): void;
  /** a part kept apart in `constraint` is still there at the end of its object */
  settle(part: JsonSchema): void;
  /** `count` entries are about to be made: stops first if they don't fit */
  ensure(count: number): void;
  /** a map replaced by `to`, with its keys renamed */
  moved(from: object, to: object): void;
  /** starts building a property that will be dropped, as the object has its name; returns a mark for `leftOut` */
  leaveOut(): number;
  /** ends that build: what was counted since `mark` stays out of the limit until `schema` is dropped */
  leftOut(mark: number, schema: JsonSchema | undefined): void;
}

/** A group read once for an object: where it was read, and its content as it was then. */
interface GroupRead {
  group: Element;
  doc: SchemaDocument;
  /** read for a repeated reference, as an object of its own */
  repeated: boolean;
  optional: boolean;
  /** the named groups its content refers to, directly or further in */
  refers: Set<Element>;
  /** those of them already open on the way to the reference, the only ones the check for recursion sees */
  around: Set<Element>;
  content: Fragment;
}

const intersect = (a: Set<Element>, b: Set<Element>): Set<Element> => new Set([...a].filter((x) => b.has(x)));
const sameGroups = (a: Set<Element>, b: Set<Element>): boolean => a.size === b.size && [...a].every((x) => b.has(x));
const addAll = (to: Set<Element> | undefined, from: Set<Element>): void => {
  for (const x of from) {
    to?.add(x);
  }
};

/**
 * A copy of a fragment that merging can change without changing the original: its own properties, lists and
 * constraints (made by `copyConstraint`), which merging relaxes in place. The schemas of the properties are shared; merging
 * replaces them rather than changing them.
 */
function copyFragment(fragment: Fragment, copyConstraint: (constraint: JsonSchema) => JsonSchema): Fragment {
  const copy: Fragment = {
    props: fragment.props.map((prop) =>
      prop.occurrences ? { ...prop, occurrences: { ...prop.occurrences } } : { ...prop },
    ),
    required: [...fragment.required],
    constraints: fragment.constraints.map(copyConstraint),
    dependentRequired: Object.fromEntries(
      Object.entries(fragment.dependentRequired).map(([key, keys]) => [key, [...keys]]),
    ),
    groupKeys: fragment.groupKeys,
  };
  for (const flag of ['isChoice', 'anyElement', 'anyAttribute'] as const) {
    if (fragment[flag] !== undefined) {
      copy[flag] = fragment[flag];
    }
  }
  return copy;
}

/**
 * How many particles of an object give each element name, and each repeated group (by the group, which gives its key),
 * up to 2: summed over the parts of a sequence, the most of any branch for a choice, whose branches are joined without
 * relaxing. A name given twice is joined by `addProp`, which relaxes the choices that name it.
 */
export type Names = Map<string | Element, number>;

/** The content of an object being read: its names, the deferrals of its choices, and parts kept apart. */
interface ObjectContent {
  names: Names;
  deferrals: Deferral[];
  apart: JsonSchema[];
}

/** Adds the counts of `from` to `to`, summed or as the larger of both, up to 2. */
function addNames(to: Names, from: Names, sum: boolean): void {
  for (const [name, count] of from) {
    const before = to.get(name) ?? 0;
    to.set(name, sum ? Math.min(2, before + count) : Math.max(before, count));
  }
}

/** The maps of the branches of one choice: all their names, those written at once, and the deferral of the others. */
interface MapPlan {
  names: readonly string[];
  written: readonly string[];
  deferral: Deferral | undefined;
}

const UNCOUNTED: Counter = {
  written: () => undefined,
  constraint: () => undefined,
  settle: () => undefined,
  ensure: () => undefined,
  grow: () => undefined,
  discarded: () => undefined,
  moved: () => undefined,
  relaxed: () => undefined,
  leaveOut: () => 0,
  leftOut: () => undefined,
};

export class ContentModel {
  /**
   * The fragments of the object being filled whose names a new property would join: the fragment of the object, the
   * groups open around the particle, and for an open choice one fragment with the properties of its branches so far.
   */
  private open: Fragment[] = [];
  /** the names of each named group, as `planOf` reads them */
  private readonly groupNames = new Map<Element, Names>();
  /** the objects whose content is being read, innermost last */
  private readonly objects: ObjectContent[] = [];
  private readonly relaxer: Relaxer;
  /** The groups already read in each object, for further references in the same place; see groupReference. */
  private readonly groupsRead = new WeakMap<GroupKeys, GroupRead[]>();
  /** for each group being read, the named groups its content refers to so far */
  private readonly referring: Set<Element>[] = [];
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
    private readonly recorder?: Recorder,
    /** counts what is written, for `maxOutputEntries` */
    private readonly counter: Counter = UNCOUNTED,
    /** the name an element particle gives its property, known before the property is made */
    private readonly elementKey: (node: Element, doc: SchemaDocument, particle?: Element) => string | undefined = () =>
      undefined,
  ) {
    this.relaxer = new Relaxer(counter);
  }

  /** Adds the model group of a complex type or derivation (its sequence, all, choice or group) to `fragment`. */
  compositor(owner: Element, doc: SchemaDocument, fragment: Fragment): void {
    const model = xsChildren(owner).find((c) => ['sequence', 'all', 'choice', 'group'].includes(c.localName ?? ''));
    if (model) {
      // The object being filled is where every property of this model ends up, unless a repeated group starts another.
      const outer = this.open;
      this.open = [fragment];
      try {
        this.particle(model, doc, fragment, new Set());
      } finally {
        this.open = outer;
      }
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
    const open = this.open.length;
    this.open.push(fragment);
    try {
      for (const child of xsChildren(node)) {
        this.particle(child, doc, fragment, seen);
      }
    } finally {
      this.open.length = open;
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
        const prop = this.property(child, doc);
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
        // A repeated group whose key the object already has is joined with it: it is built only to be dropped.
        const known = repeated ? fragment.groupKeys.get(this.groupNode(child)) : undefined;
        const leftOut = known !== undefined && this.open.some((open) => hasKey(open, known));
        const mark = leftOut ? this.counter.leaveOut() : 0;
        let counted = !leftOut;
        try {
          // The occurrences of a repeated group are objects of their own: names around it don't take its names.
          const outer = this.open;
          if (repeated) {
            this.open = [];
            this.beginObject(this.planOf(child, doc, seen, true));
          }
          let inner: Fragment | undefined;
          try {
            if (child.localName === 'group') {
              inner = this.groupReference(child, optional, seen, keys, fragment.groupKeys);
            } else if (child.localName === 'choice') {
              inner = this.choice(child, doc, optional, seen, keys);
            } else {
              inner = this.group(child, doc, seen, keys);
            }
          } finally {
            this.open = outer;
            if (repeated) {
              this.endObject();
            }
          }
          if (!inner) {
            return;
          }
          if (repeated) {
            this.repeatedGroup(fragment, child, inner, min, max, (schema) => {
              if (leftOut) {
                this.counter.leftOut(mark, schema);
                counted = true;
              }
            });
            return;
          }
          if (min > 0 || child.localName === 'choice' || inner.isChoice) {
            this.merge(fragment, inner, true);
          } else {
            this.optionalGroup(fragment, inner);
          }
        } finally {
          if (!counted) {
            this.counter.leftOut(mark, undefined);
          }
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
      const branches: { fragment: Fragment; node: Element }[] = [];
      // As in a choice, the names of the members made so far stay open.
      const earlier = emptyFragment(fragment.groupKeys);
      const open = this.open.length;
      this.open.push(earlier);
      try {
        for (const member of members) {
          const branch = emptyFragment(fragment.groupKeys);
          const prop = this.property(member.node, member.doc, child);
          if (prop) {
            this.addProp(branch, prop);
            addRequired(branch, [prop.key]);
            earlier.props.push(prop);
            branches.push({ fragment: branch, node: child });
          }
        }
      } finally {
        this.open.length = open;
      }
      this.merge(fragment, this.choiceOf(branches, min === 0, fragment.groupKeys), true);
      return;
    }
    const keys: string[] = [];
    for (const member of members) {
      // The particle may use any member. A member that appears has at least one occurrence of its own.
      const prop = this.property(member.node, member.doc, child, (made) => {
        const occurrences = made.occurrences && { ...made.occurrences, min: 1, optional: true };
        return occurrences && { ...made, schema: occurrences.array(1, max), occurrences };
      });
      if (!prop) {
        continue;
      }
      this.addProp(fragment, prop);
      keys.push(prop.key);
    }
    // The members share one particle: at least one of them if it is required. Optional, the branch without any of
    // them says the same, so that a reader still sees which properties belong to the particle.
    if (keys.length > 0) {
      const alternatives: JsonSchema[] = keys.map((key) => ({ required: [key] }));
      if (min === 0) {
        const none: JsonSchema = {};
        this.branchMap(this.planMaps(keys, fragment.groupKeys), none, new Set(), undefined, true);
        alternatives.push(none);
      }
      const constraint: JsonSchema = { anyOf: alternatives };
      if (min === 0) {
        this.optionalChoices.add(constraint);
      }
      this.counted(constraint, fragment.groupKeys);
      fragment.constraints.push(constraint);
    }
  }

  /**
   * The fragment of a group reference.
   *
   * @param scope - the keys of the object the reference stands in; `keys` differs from them where the reference is
   *   repeated, each occurrence an object of its own
   */
  private groupReference(
    node: Element,
    optional: boolean,
    seen: Set<Element>,
    keys: GroupKeys,
    scope: GroupKeys = keys,
  ): Fragment | undefined {
    const ref = attr(node, 'ref') ?? '';
    const found = this.set.lookupRef('group', this.set.resolveQName(node, ref), node);
    if (!found) {
      this.problems.error('unknown-group', `group ${ref} is not defined`, this.set.at(node));
      return undefined;
    }
    // Recorded for the enclosing group, which passes its set on when it is finished.
    this.referring.at(-1)?.add(found.node);
    if (seen.has(found.node)) {
      this.problems.error('circular-group', `group ${ref} contains itself`, this.set.at(node));
      return undefined;
    }
    const compositor = xsChildren(found.node)[0];
    if (!compositor) {
      return emptyFragment(keys);
    }
    // Another reference to the same group in the same object yields the same content, so the group is read once and
    // later references get a copy. Otherwise groups that each refer twice to the next one would be read exponentially
    // often. The content can only differ where it refers to a group already open on the way here, which then contains
    // itself, or, for a choice, where one reference is optional and the other is not. A repeated reference reads the
    // group as an object of its own, with keys of its own: its content is shared with other repeated references in
    // the same object, not with plain ones.
    const choice = compositor.localName === 'choice';
    const repeated = keys !== scope;
    const reads = this.groupsRead.get(scope) ?? [];
    const read = reads.find(
      (r) =>
        r.group === found.node &&
        r.doc === found.doc &&
        r.repeated === repeated &&
        r.optional === (choice && optional) &&
        sameGroups(r.around, intersect(seen, r.refers)),
    );
    if (read) {
      addAll(this.referring.at(-1), read.refers);
      return copyFragment(read.content, (from) => {
        const to = this.relaxer.copy(from, (deferral) => this.objects.at(-1)?.deferrals.push(deferral));
        if (this.optionalChoices.has(from)) {
          this.optionalChoices.add(to);
        }
        this.counted(to, keys);
        return to;
      });
    }
    const inner = new Set([...seen, found.node]);
    const refers = new Set<Element>();
    this.referring.push(refers);
    let fragment: Fragment;
    try {
      if (choice) {
        fragment = this.choice(compositor, found.doc, optional, inner, keys);
        fragment.isChoice = true;
      } else {
        fragment = this.group(compositor, found.doc, inner, keys);
      }
    } finally {
      this.referring.pop();
    }
    addAll(this.referring.at(-1), refers);
    // Kept as a copy, because merging changes the fragment returned here.
    reads.push({
      group: found.node,
      doc: found.doc,
      repeated,
      optional: choice && optional,
      refers,
      around: intersect(seen, refers),
      // Never written itself, so its deferrals are not settled.
      content: copyFragment(fragment, (from) => {
        const to = this.relaxer.copy(from, () => undefined);
        if (this.optionalChoices.has(from)) {
          this.optionalChoices.add(to);
        }
        return to;
      }),
    });
    this.groupsRead.set(scope, reads);
    return fragment;
  }

  /** Starts reading the content of an object whose particles give `names`. */
  beginObject(names: Names): void {
    this.objects.push({ names, deferrals: [], apart: [] });
  }

  /**
   * The content of the object is complete: the noted entries that were not relaxed are written, and the parts kept
   * apart count.
   */
  endObject(): void {
    const object = this.objects.pop();
    if (object !== undefined) {
      this.relaxer.settle(object.deferrals);
      for (const part of object.apart) {
        this.counter.settle(part);
      }
    }
  }

  /** Whether a later particle of the object can give `name` again, so that relaxing can remove it from a choice. */
  private relaxable(name: string, keys: GroupKeys): boolean {
    const object = this.objects.at(-1);
    if (object === undefined) {
      return false;
    }
    const counted = name.startsWith('{') ? name : keys.groupOf(name);
    return counted !== undefined && (object.names.get(counted) ?? 0) > 1;
  }

  /** Adds the names of the content of `owner` (a complex type or derivation) to `names`, as further parts of it. */
  modelNames(owner: Element, doc: SchemaDocument, names: Names): void {
    const model = xsChildren(owner).find((c) => ['sequence', 'all', 'choice', 'group'].includes(c.localName ?? ''));
    if (model) {
      addNames(names, this.planOf(model, doc, new Set()), true);
    }
  }

  /**
   * The names a particle gives (see `Names`), in a map the caller may change. A repeated group is an object of its
   * own: it gives its group, unless `whole` asks for the names of that object. The larger map of the parts takes in
   * the smaller ones, so reading stays near linear however deep the parts nest.
   */
  private planOf(node: Element, doc: SchemaDocument, seen: Set<Element>, whole = false): Names {
    const { max } = occurs(node);
    if (max === 0) {
      return new Map();
    }
    if (node.localName === 'element') {
      const members = this.substitutes(node);
      const names: Names = new Map();
      for (const key of members
        ? members.map((member) => this.elementKey(member.node, member.doc, node))
        : [this.elementKey(node, doc)]) {
        if (key !== undefined) {
          names.set(key, 1);
        }
      }
      return names;
    }
    if (!['sequence', 'all', 'choice', 'group'].includes(node.localName ?? '')) {
      return new Map();
    }
    if (max > 1 && !whole) {
      return new Map([[this.groupNode(node), 1]]);
    }
    if (node.localName === 'group') {
      const found = this.set.lookupRef('group', this.set.resolveQName(node, attr(node, 'ref') ?? ''), node);
      if (!found || seen.has(found.node)) {
        return new Map();
      }
      // The names of a group are the same wherever it is referred to, so each group is read for them once.
      let names = this.groupNames.get(found.node);
      if (names === undefined) {
        const compositor = xsChildren(found.node)[0];
        names = compositor ? this.planOf(compositor, found.doc, new Set([...seen, found.node])) : new Map();
        this.groupNames.set(found.node, names);
      }
      return new Map(names);
    }
    const parts = xsChildren(node).map((child) => this.planOf(child, doc, seen));
    const largest = parts.reduce<Names | undefined>((a, b) => (a === undefined || b.size > a.size ? b : a), undefined);
    if (largest === undefined) {
      return new Map();
    }
    for (const part of parts) {
      if (part !== largest) {
        addNames(largest, part, node.localName !== 'choice');
      }
    }
    return largest;
  }

  /**
   * Plans the maps of the branches of one choice over `names`, which hold `false` for a name a branch doesn't have.
   * Where a later particle of the object gives a name again, relaxing will remove its `false` entries, so they are
   * only noted (see Deferral) and written at the end of the object's content if they are still there.
   */
  private planMaps(names: readonly string[], keys: GroupKeys): MapPlan {
    const noted = names.filter((name) => this.relaxable(name, keys));
    if (noted.length === 0) {
      return { names, written: names, deferral: undefined };
    }
    const deferral = new Deferral(names, noted);
    this.objects.at(-1)?.deferrals.push(deferral);
    return { names, written: names.filter((name) => !deferral.notedNames.has(name)), deferral };
  }

  /**
   * Writes the map of one branch into `branch`: `false` for each planned name the branch doesn't have among `own`,
   * and `value(name)` for one it has, where that gives a schema. The entries are counted before the map is made.
   *
   * @param always - write the map even when it is empty
   */
  private branchMap(
    plan: MapPlan,
    branch: JsonSchema,
    own: ReadonlySet<string>,
    value: (name: string) => JsonSchema | undefined = () => undefined,
    always = false,
  ): void {
    const { written, deferral } = plan;
    // The names of the branch that are noted for the others still get their own value now.
    const ownNoted = deferral
      ? [...own]
          .filter((name) => deferral.notedNames.has(name))
          .sort((a, b) => (deferral.order.get(a) as number) - (deferral.order.get(b) as number))
      : [];
    const entries: [string, JsonSchema | boolean][] = [];
    let next = 0;
    const takeOwnUpTo = (at: number): void => {
      for (; next < ownNoted.length; next += 1) {
        const name = ownNoted[next] as string;
        if ((deferral?.order.get(name) as number) > at) {
          return;
        }
        const schema = value(name);
        if (schema !== undefined) {
          entries.push([name, schema]);
        }
      }
    };
    for (const name of written) {
      if (deferral) {
        takeOwnUpTo(deferral.order.get(name) as number);
      }
      if (!own.has(name)) {
        entries.push([name, false]);
      } else {
        const schema = value(name);
        if (schema !== undefined) {
          entries.push([name, schema]);
        }
      }
    }
    takeOwnUpTo(Infinity);
    this.counter.ensure(entries.length);
    const map: Record<string, JsonSchema | boolean> = Object.fromEntries(entries);
    const noted = deferral ? deferral.noted.length - ownNoted.length : 0;
    if (entries.length > 0 || noted > 0 || always) {
      branch.properties = map;
    }
    if (deferral && noted > 0) {
      deferral.add(map, branch, own);
    }
  }

  /** The parts of `schema` that relaxing will probably remove: the `dependentSchemas` of names given again. */
  private apartParts(schema: JsonSchema, keys: GroupKeys, parts: JsonSchema[] = []): JsonSchema[] {
    for (const [name, part] of Object.entries(schema.dependentSchemas ?? {})) {
      if (this.relaxable(name, keys)) {
        parts.push(part);
      }
    }
    for (const branch of [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])]) {
      this.apartParts(branch, keys, parts);
    }
    return parts;
  }

  /** Counts a constraint made, keeping apart what relaxing will probably remove from it until its object is complete. */
  private counted(constraint: JsonSchema, keys: GroupKeys): void {
    const apart = this.apartParts(constraint, keys);
    this.objects.at(-1)?.apart.push(...apart);
    this.counter.constraint(constraint, apart);
  }

  /** The group a repeated group particle stands for: the definition of a reference, or the particle itself. */
  private groupNode(node: Element): Element {
    return node.localName === 'group'
      ? (this.set.lookupRef('group', this.set.resolveQName(node, attr(node, 'ref') ?? ''), node)?.node ?? node)
      : node;
  }

  /**
   * The property of an element particle. Where the object already has a property of that name, in the fragment being
   * filled or in one this fragment will be merged into, the new property is built only to be dropped. Its entries are
   * kept apart, so that they can't stop the conversion before the property is dropped.
   *
   * @param shape - the property as the particle adds it, made from the property of the declaration
   */
  private property(
    node: Element,
    doc: SchemaDocument,
    particle?: Element,
    shape?: (made: Prop) => Prop | undefined,
  ): Prop | undefined {
    const key = this.elementKey(node, doc, particle);
    const leftOut = key !== undefined && this.open.some((fragment) => hasKey(fragment, key));
    const mark = leftOut ? this.counter.leaveOut() : 0;
    let prop: Prop | undefined;
    try {
      const made = this.elementProperty(node, doc, particle);
      prop = made && shape ? shape(made) : made;
    } finally {
      if (leftOut) {
        this.counter.leftOut(mark, prop?.schema);
      }
    }
    return prop;
  }

  /** A group that can occur more than once: one property, an array with an object per occurrence. */
  private repeatedGroup(
    fragment: Fragment,
    node: Element,
    inner: Fragment,
    min: number,
    max: number,
    adding?: (schema: JsonSchema) => void,
  ): void {
    const group = this.groupNode(node);
    const key = fragment.groupKeys.keyOf(group, group === node ? (node.localName ?? '') : (attr(group, 'name') ?? ''));
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
    const plan = planKeys(Object.keys(item.properties ?? {}), this.textProperty);
    renameObject(item, plan, this.xml, (from, to) => this.counter.moved(from, to));
    this.counter.written(item);
    this.recorder?.object(node, plan, inner.groupKeys);
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
    const prop: Prop = {
      key,
      schema: array(least, max),
      node,
      occurrences: { identity: JSON.stringify(item), min: least, max, array },
    };
    adding?.(prop.schema);
    this.addProp(fragment, prop);
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
    const nothing: JsonSchema = {};
    const names = inner.props.map((prop) => prop.key);
    this.branchMap(this.planMaps(names, inner.groupKeys), nothing, new Set(), undefined, true);
    const constraint: JsonSchema = this.canBeEmpty(inner) ? { anyOf: [nothing, whole] } : { oneOf: [nothing, whole] };
    this.optionalChoices.add(constraint);
    const fragment = emptyFragment(inner.groupKeys);
    fragment.props = inner.props;
    this.counted(constraint, inner.groupKeys);
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
    // A name an earlier branch has is joined with it, so the names of the branches made so far stay open, as one
    // fragment that holds the properties of all of them.
    const earlier = emptyFragment(keys);
    const open = this.open.length;
    this.open.push(earlier);
    try {
      for (const child of xsChildren(node)) {
        if (occurs(child).max === 0) {
          continue;
        }
        const branch = emptyFragment(keys);
        this.open.push(branch);
        this.particle(child, doc, branch, seen);
        this.open.pop();
        earlier.props.push(...branch.props);
        if (child.localName !== 'element' && occurs(child).min === 0) {
          branch.required = [];
        }
        branches.push({ fragment: branch, node: child });
      }
    } finally {
      this.open.length = open;
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
    // How many branches have each property: one that some branch lacks is optional, one several have is shared.
    const holders = new Map<string, number>();
    for (const { fragment: branch, node: child } of branches) {
      for (const prop of branch.props) {
        holders.set(prop.key, (holders.get(prop.key) ?? 0) + 1);
        const existing = propOf(fragment, prop.key);
        if (!existing) {
          fragment.props.push({ ...prop });
        } else if (existing.occurrences?.identity !== prop.occurrences?.identity || !prop.occurrences) {
          this.problems.error('duplicate-name', `${prop.key} occurs in two branches of a choice`, this.set.at(child));
          this.counter.discarded(prop.schema);
        } else {
          this.joinAlternative(existing, prop.occurrences);
          this.counter.discarded(prop.schema);
        }
      }
    }
    for (const prop of fragment.props) {
      if (optional || (holders.get(prop.key) ?? 0) < branches.length) {
        Object.assign(prop, optionally(prop));
      }
    }
    const empty = branches.filter((b) => this.canBeEmpty(b.fragment));
    const shared = [...holders.values()].some((count) => count > 1);
    if (!shared && empty.length === 0 && branches.every((b) => b.fragment.required.length > 0)) {
      return this.anchoredChoice(fragment, branches, optional);
    }
    const plan = this.planMaps(
      fragment.props.map((prop) => prop.key),
      keys,
    );
    const alternatives = branches.map(({ fragment: branch }) => {
      const schema: JsonSchema = {};
      if (branch.required.length > 0) {
        schema.required = branch.required;
      }
      // What the branch says about the properties of the choice: `false` for those of the other branches, and the
      // bounds of an array it shares with them where it allows fewer items.
      this.branchMap(plan, schema, new Set(branch.props.map((prop) => prop.key)), (name) => {
        const own = propOf(branch, name)?.occurrences;
        const all = propOf(fragment, name)?.occurrences;
        if (!own || !all) {
          return undefined;
        }
        const bounds: JsonSchema = {};
        if (own.min > all.min) {
          bounds.minItems = own.min;
        }
        if (own.max < all.max) {
          bounds.maxItems = own.max;
        }
        return Object.keys(bounds).length > 0 ? { type: 'array', ...bounds } : undefined;
      });
      if (Object.keys(branch.dependentRequired).length > 0) {
        schema.dependentRequired = branch.dependentRequired;
      }
      addConstraints(schema, branch.constraints);
      // Counted as each branch is made: their maps grow with the square of the number of branches.
      this.counted(schema, keys);
      return schema;
    });
    if (optional && empty.length === 0) {
      const none: JsonSchema = {};
      this.branchMap(plan, none, new Set(), undefined, true);
      alternatives.push(none);
    }
    // Branches that share a property or can both be empty can match together; what only one branch has still keeps
    // the others out. This form grows with the square of the number of branches.
    const constraint: JsonSchema = shared || empty.length > 1 ? { anyOf: alternatives } : { oneOf: alternatives };
    if (optional || empty.length > 0) {
      this.optionalChoices.add(constraint);
    }
    this.counted(constraint, keys);
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
      const none: JsonSchema = {};
      this.branchMap(this.planMaps(anchors, fragment.groupKeys), none, new Set(), undefined, true);
      alternatives.push(none);
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
    this.counted(constraint, fragment.groupKeys);
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
    const existing = propOf(fragment, prop.key);
    if (!existing) {
      fragment.props.push(prop);
      return;
    }
    const own = existing.occurrences;
    const other = prop.occurrences;
    if (!own || !other || own.identity !== other.identity) {
      this.problems.error('duplicate-name', `${prop.key} occurs twice in one object`, this.set.at(prop.node));
      this.counter.discarded(prop.schema);
      return;
    }
    // The array keeps the item of the first particle; the second particle's own schema, the same, is left out.
    const required = certain(own) + certain(other);
    const min = required || Math.min(own.min, other.min);
    const max = own.max + other.max;
    existing.occurrences = { ...own, min, max, optional: required === 0 };
    existing.schema = own.array(min, max);
    this.counter.discarded(prop.schema);
    this.relax(fragment, prop);
  }

  /** `prop` now also occurs outside a choice or optional group of `fragment`, which can no longer depend on it. */
  private relax(fragment: Fragment, prop: Prop): void {
    let changed = false;
    if (fragment.dependentRequired[prop.key] !== undefined) {
      delete fragment.dependentRequired[prop.key];
      if (Object.keys(fragment.dependentRequired).length === 0) {
        fragment.dependentRequired = {};
      }
      changed = true;
    }
    // Without an object being read nothing was noted, and every name may be relaxed.
    const relaxable = this.objects.length > 0 ? (name: string) => this.relaxable(name, fragment.groupKeys) : () => true;
    if (this.relaxer.relax(fragment.constraints, prop.key, relaxable) || changed) {
      this.problems.warning(
        'approximated-occurrences',
        `${prop.key} occurs inside and outside a choice or optional group; the schema does not tie it to the group`,
        this.set.at(prop.node),
      );
    }
  }
}

// The properties of each fragment by key. Properties are only ever appended to the list, or the list is replaced, so
// the index of a list catches up with its new entries; it holds the first property of each key, as a search would.
// Looking a key up then takes constant time, and adding the properties of a wide type stays linear.
const indexes = new WeakMap<Prop[], { size: number; byKey: Map<string, Prop> }>();

function propOf(fragment: Fragment, key: string): Prop | undefined {
  const props = fragment.props;
  // A short list, such as the branch of a choice, is searched faster than an index is kept.
  if (props.length <= 8) {
    return props.find((prop) => prop.key === key);
  }
  let index = indexes.get(props);
  if (!index) {
    index = { size: 0, byKey: new Map() };
    indexes.set(props, index);
  }
  for (; index.size < props.length; index.size += 1) {
    const prop = props[index.size] as Prop;
    if (!index.byKey.has(prop.key)) {
      index.byKey.set(prop.key, prop);
    }
  }
  return index.byKey.get(key);
}

const hasKey = (fragment: Fragment, key: string): boolean => propOf(fragment, key) !== undefined;

/** The same property for a fragment that can occur without it. */
function optionally(prop: Prop): Prop {
  return prop.occurrences ? { ...prop, occurrences: { ...prop.occurrences, optional: true } } : prop;
}
