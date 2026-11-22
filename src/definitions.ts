// The `$defs` of the schema being written.
//
// A named type gets its definition name the first time it is referenced, and its schema is built later, after the
// definition the emitter is working on. That keeps the definitions in the order of first use and lets a recursive
// type refer to itself: the reference exists before the schema does.

import type { JsonSchema } from './json-schema.js';

export class Definitions {
  /** definition name -> schema, in the order of first use */
  private readonly schemas = new Map<string, JsonSchema>();
  /** `kind {namespace}name` -> definition name */
  private readonly names = new Map<string, string>();
  private readonly pending: { name: string; build: () => JsonSchema }[] = [];

  /**
   * A `$ref` to the definition of a component. The first reference picks the name and queues `build`, which runs in
   * `buildAll()`; later references reuse the name.
   *
   * @param kind - `type` or `element`, so a type and an element with the same name get separate definitions
   * @param id - the expanded name of the component, `{namespace}name`
   * @param label - the name the definition should get, usually the local name
   */
  ref(kind: string, id: string, label: string, build: () => JsonSchema): JsonSchema {
    let name = this.names.get(`${kind} ${id}`);
    if (name === undefined) {
      name = this.allocate(label, id);
      this.names.set(`${kind} ${id}`, name);
      this.pending.push({ name, build });
    }
    return { $ref: `#/$defs/${pointerEscape(name)}` };
  }

  /** The definition name of a component, if it has been referenced. */
  nameOf(kind: string, id: string): string | undefined {
    return this.names.get(`${kind} ${id}`);
  }

  /** Builds every queued definition, including those that the built schemas reference in turn. */
  buildAll(): Map<string, JsonSchema> {
    for (let job = this.pending.shift(); job; job = this.pending.shift()) {
      this.schemas.set(job.name, job.build());
    }
    return this.schemas;
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
}

function pointerEscape(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1');
}

// Keep the last two namespace segments so colliding type names stay readable in $defs.
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
