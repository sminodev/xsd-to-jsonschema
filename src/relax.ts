// Relaxing the choices of an object. When a name occurs inside a choice and again outside it, the choice can no longer
// tell its branches apart by that name: the `false` entries for it leave the maps of the branches, its entries in
// `dependentRequired` and `dependentSchemas` go, an anchor stops being one, and a `oneOf` above any of these becomes
// an `anyOf`. The planning of the object knows beforehand which names a later particle gives again. Their `false`
// entries are only noted for each choice (a Deferral) and written at the end of the object's content if they are still
// there. Relaxing finds what it changes through an index of each constraint instead of walking all of them again.

import type { JsonSchema } from './json-schema.js';

type PropertyMap = Record<string, JsonSchema | boolean>;

/** Counts what relaxing changes, for `maxOutputEntries`; see the emitter. */
export interface RelaxCounter {
  /** `key` removed from a map */
  relaxed(map: object, key: string): void;
  /** a schema removed */
  discarded(schema: JsonSchema): void;
  /** `count` entries about to be added to a map: stops first if they don't fit */
  grow(map: object, count: number): void;
}

/** A map of a choice branch with entries noted in a Deferral: the branch holding it, and the names it has itself. */
interface NotedMap {
  deferral: Deferral;
  map: PropertyMap;
  branch: JsonSchema;
  own: ReadonlySet<string>;
}

/**
 * The `false` entries the maps of one choice leave out for now: names that a later particle of the object gives again,
 * which relaxing then removes from every map of the choice. They are noted once for the choice, not in each map.
 */
export class Deferral {
  /** the position of each name in the maps */
  readonly order: ReadonlyMap<string, number>;
  /** the names relaxing has removed so far */
  readonly relaxed = new Set<string>();
  readonly maps: NotedMap[] = [];
  /** for each noted name, how many of the maps have it themselves, so that it is no `false` entry there */
  private readonly owners = new Map<string, number>();
  /** the noted names as a set */
  readonly notedNames: ReadonlySet<string>;

  /**
   * @param names - all names of the maps, in their order
   * @param noted - the names left out, in the same order
   */
  constructor(
    names: readonly string[] | ReadonlyMap<string, number>,
    readonly noted: readonly string[],
  ) {
    this.order = Array.isArray(names)
      ? new Map(names.map((name, i) => [name, i]))
      : (names as ReadonlyMap<string, number>);
    this.notedNames = new Set(noted);
  }

  /** A deferral for a copy of the maps, with what has been relaxed so far. */
  copy(): Deferral {
    const copy = new Deferral(this.order, this.noted);
    for (const name of this.relaxed) {
      copy.relaxed.add(name);
    }
    return copy;
  }

  /** Notes `map`, held by `branch`, whose own names `own` are no `false` entries. */
  add(map: PropertyMap, branch: JsonSchema, own: ReadonlySet<string>): void {
    const noted: NotedMap = { deferral: this, map, branch, own };
    this.maps.push(noted);
    notedMaps.set(map, noted);
    for (const name of own) {
      if (this.notedNames.has(name)) {
        this.owners.set(name, (this.owners.get(name) ?? 0) + 1);
      }
    }
  }

  /** Whether some map has a `false` entry for `name` (noted and not relaxed yet). */
  ruledOutBySome(name: string): boolean {
    return (this.owners.get(name) ?? 0) < this.maps.length;
  }

  /** How many noted entries `map` still has. */
  left(noted: NotedMap): number {
    let own = 0;
    for (const name of noted.own) {
      if (this.notedNames.has(name) && !this.relaxed.has(name)) {
        own += 1;
      }
    }
    return this.noted.length - this.relaxed.size - own;
  }
}

const notedMaps = new WeakMap<object, NotedMap>();

// The number of entries of each map and dependent dictionary, kept as relaxing removes entries, so that it doesn't
// count a large map again after each removal.
const sizes = new WeakMap<object, number>();

function sizeOf(record: object): number {
  let size = sizes.get(record);
  if (size === undefined) {
    size = Object.keys(record).length;
    sizes.set(record, size);
  }
  return size;
}

function removeKey(record: Record<string, unknown>, key: string): void {
  const size = sizeOf(record);
  delete record[key];
  sizes.set(record, size - 1);
}

/** Whether a map holds no entries, written or noted. */
function isEmpty(map: PropertyMap): boolean {
  const noted = notedMaps.get(map);
  return sizeOf(map) === 0 && (noted === undefined || noted.deferral.left(noted) === 0);
}

/** A place where relaxing a name changes a constraint. */
type Spot =
  | { kind: 'entry'; parent: JsonSchema | undefined; branch: JsonSchema }
  | { kind: 'anchor'; parent: JsonSchema | undefined; branch: JsonSchema }
  | { kind: 'dependent'; node: JsonSchema }
  | { kind: 'noted'; parent: JsonSchema | undefined; deferral: Deferral };

/** The spots of one constraint by name, with the parent of each schema in it and the parents made `anyOf` above. */
interface Index {
  spots: Map<string, Spot[]>;
  parents: Map<JsonSchema, JsonSchema>;
  /** schemas whose `oneOf` and those of all schemas above them are `anyOf` already */
  done: Set<JsonSchema>;
  relaxable: (key: string) => boolean;
}

export class Relaxer {
  private readonly indexes = new WeakMap<JsonSchema, Index>();
  // The constraints of each fragment by name. A fragment only appends constraints or replaces its list, so the index
  // of a list catches up with its new constraints, like the index of the properties of a fragment.
  private readonly lists = new WeakMap<JsonSchema[], { size: number; byName: Map<string, JsonSchema[]> }>();

  constructor(private readonly counter: RelaxCounter) {}

  /**
   * Relaxes `key` in a fragment's constraints, as its property now also occurs outside them.
   *
   * @returns whether anything changed
   */
  relax(constraints: JsonSchema[], key: string, relaxable: (key: string) => boolean): boolean {
    const byName = this.byName(constraints, relaxable);
    const list = byName.get(key);
    if (list === undefined) {
      return false;
    }
    let changed = false;
    const still: JsonSchema[] = [];
    for (const constraint of list) {
      const index = this.indexOf(constraint, relaxable);
      changed = this.relaxIn(index, key) || changed;
      if (index.spots.has(key)) {
        still.push(constraint);
      }
    }
    if (still.length > 0) {
      byName.set(key, still);
    } else {
      byName.delete(key);
    }
    return changed;
  }

  /**
   * Writes the noted entries not relaxed into their maps, each in its place, counting each map before it grows. An
   * empty map leaves its branch.
   */
  settle(deferrals: readonly Deferral[]): void {
    for (const deferral of deferrals) {
      const left = deferral.noted.filter((name) => !deferral.relaxed.has(name));
      const leftNames = new Set(left);
      for (const { map, branch, own } of deferral.maps) {
        let count = left.length;
        for (const name of own) {
          if (leftNames.has(name)) {
            count -= 1;
          }
        }
        if (count === 0) {
          if (sizeOf(map) === 0 && branch.properties === map) {
            delete branch.properties;
          }
          continue;
        }
        this.counter.grow(map, count);
        const written = Object.entries(map);
        for (const [key] of written) {
          delete map[key];
        }
        let next = 0;
        const writeUpTo = (at: number): void => {
          for (; next < written.length; next += 1) {
            const [key, value] = written[next] as [string, JsonSchema | boolean];
            if ((deferral.order.get(key) ?? -1) > at) {
              return;
            }
            map[key] = value;
          }
        };
        for (const name of left) {
          if (!own.has(name)) {
            writeUpTo(deferral.order.get(name) as number);
            map[name] = false;
          }
        }
        writeUpTo(Infinity);
        sizes.set(map, written.length + count);
      }
    }
  }

  /**
   * A copy of a constraint with maps of its own and their own deferrals; `copied` is told of each new deferral. Its
   * index is made when the copy is first relaxed.
   */
  copy(constraint: JsonSchema, copied: (deferral: Deferral) => void): JsonSchema {
    const deferrals = new Map<Deferral, Deferral>();
    const copyOf = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(copyOf);
      }
      if (value === null || typeof value !== 'object') {
        return value;
      }
      const from = value as Record<string, unknown>;
      const to: Record<string, unknown> = {};
      for (const [key, part] of Object.entries(from)) {
        to[key] = copyOf(part);
      }
      const properties = from['properties'];
      const noted = typeof properties === 'object' && properties !== null ? notedMaps.get(properties) : undefined;
      if (noted) {
        let deferral = deferrals.get(noted.deferral);
        if (deferral === undefined) {
          deferral = noted.deferral.copy();
          deferrals.set(noted.deferral, deferral);
          copied(deferral);
        }
        deferral.add(to['properties'] as PropertyMap, to, noted.own);
      }
      return to;
    };
    return copyOf(constraint) as JsonSchema;
  }

  private byName(constraints: JsonSchema[], relaxable: (key: string) => boolean): Map<string, JsonSchema[]> {
    let list = this.lists.get(constraints);
    if (list === undefined) {
      list = { size: 0, byName: new Map() };
      this.lists.set(constraints, list);
    }
    for (; list.size < constraints.length; list.size += 1) {
      const constraint = constraints[list.size] as JsonSchema;
      for (const name of this.indexOf(constraint, relaxable).spots.keys()) {
        const holders = list.byName.get(name);
        if (holders === undefined) {
          list.byName.set(name, [constraint]);
        } else {
          holders.push(constraint);
        }
      }
    }
    return list.byName;
  }

  /**
   * The index of a constraint, made when it is first needed. It holds only names `relaxable` allows, those a later
   * particle of the object can give again; relaxing never asks for others.
   */
  private indexOf(constraint: JsonSchema, relaxable: (key: string) => boolean): Index {
    let index = this.indexes.get(constraint);
    if (index === undefined) {
      index = { spots: new Map(), parents: new Map(), done: new Set(), relaxable };
      // A constraint of a fragment is a branch of the fragment's own `allOf`, which has no parent here.
      this.visitBranch(index, constraint, undefined, new Set());
      this.indexes.set(constraint, index);
    }
    return index;
  }

  private visitBranch(index: Index, branch: JsonSchema, parent: JsonSchema | undefined, seen: Set<Deferral>): void {
    if (parent) {
      index.parents.set(branch, parent);
    }
    const map = branch.properties;
    if (map) {
      for (const key of Object.keys(map)) {
        spot(index, key, { kind: 'entry', parent, branch });
      }
      const noted = notedMaps.get(map);
      if (noted && !seen.has(noted.deferral)) {
        seen.add(noted.deferral);
        for (const name of noted.deferral.noted) {
          if (!noted.deferral.relaxed.has(name)) {
            spot(index, name, { kind: 'noted', parent, deferral: noted.deferral });
          }
        }
      }
    }
    if (branch.required?.length === 1) {
      spot(index, branch.required[0] as string, { kind: 'anchor', parent, branch });
    }
    for (const key of new Set([
      ...Object.keys(branch.dependentRequired ?? {}),
      ...Object.keys(branch.dependentSchemas ?? {}),
    ])) {
      spot(index, key, { kind: 'dependent', node: branch });
    }
    for (const part of [...(branch.oneOf ?? []), ...(branch.anyOf ?? []), ...(branch.allOf ?? [])]) {
      this.visitBranch(index, part, branch, seen);
    }
  }

  private relaxIn(index: Index, key: string): boolean {
    const spots = index.spots.get(key);
    if (spots === undefined) {
      return false;
    }
    let changed = false;
    // An anchor stays one as long as its branch has nothing else; it can stop telling branches apart again later.
    const anchors: Spot[] = [];
    for (const spot of spots) {
      if (spot.kind === 'entry') {
        const map = spot.branch.properties;
        if (map && map[key] !== undefined) {
          this.counter.relaxed(map, key);
          removeKey(map, key);
          if (isEmpty(map)) {
            delete spot.branch.properties;
          }
          this.removedBelow(index, spot.parent);
          changed = true;
        }
      } else if (spot.kind === 'anchor') {
        anchors.push(spot);
        if (isAnchor(spot.branch, key)) {
          this.removedBelow(index, spot.parent);
          changed = true;
        }
      } else if (spot.kind === 'noted') {
        const deferral = spot.deferral;
        if (!deferral.relaxed.has(key)) {
          deferral.relaxed.add(key);
          if (deferral.ruledOutBySome(key)) {
            this.removedBelow(index, spot.parent);
            changed = true;
          }
        }
      } else if (this.relaxDependent(spot.node, key)) {
        this.changedAt(index, spot.node);
        changed = true;
      }
    }
    if (anchors.length > 0) {
      index.spots.set(key, anchors);
    } else {
      index.spots.delete(key);
    }
    return changed;
  }

  private relaxDependent(node: JsonSchema, key: string): boolean {
    let changed = false;
    if (node.dependentRequired?.[key] !== undefined) {
      removeKey(node.dependentRequired, key);
      if (sizeOf(node.dependentRequired) === 0) {
        delete node.dependentRequired;
      }
      changed = true;
    }
    if (node.dependentSchemas?.[key] !== undefined) {
      this.counter.discarded(node.dependentSchemas[key]);
      removeKey(node.dependentSchemas, key);
      if (sizeOf(node.dependentSchemas) === 0) {
        delete node.dependentSchemas;
      }
      changed = true;
    }
    return changed;
  }

  /** A branch of `node` lost something: `node` and every schema above it become `anyOf` where they are `oneOf`. */
  private removedBelow(index: Index, node: JsonSchema | undefined): void {
    if (node === undefined || index.done.has(node)) {
      return;
    }
    toAnyOf(node);
    index.done.add(node);
    this.changedAt(index, node);
  }

  /** `node` changed: every schema above it becomes `anyOf` where it is `oneOf`. */
  private changedAt(index: Index, node: JsonSchema): void {
    for (let above = index.parents.get(node); above && !index.done.has(above); above = index.parents.get(above)) {
      toAnyOf(above);
      index.done.add(above);
    }
  }
}

function spot(index: Index, key: string, at: Spot): void {
  if (!index.relaxable(key)) {
    return;
  }
  const spots = index.spots.get(key);
  if (spots === undefined) {
    index.spots.set(key, [at]);
  } else {
    spots.push(at);
  }
}

/** Whether `branch` only requires `key`: an anchor, which tells the branches of its choice apart. */
function isAnchor(branch: JsonSchema, key: string): boolean {
  if (branch.required?.length !== 1 || branch.required[0] !== key) {
    return false;
  }
  return Object.keys(branch).every(
    (name) => name === 'required' || (name === 'properties' && isEmpty(branch.properties as PropertyMap)),
  );
}

function toAnyOf(schema: JsonSchema): void {
  if (schema.oneOf) {
    schema.anyOf = schema.oneOf;
    delete schema.oneOf;
  }
}
