// The attribute wildcard in effect for a complex type (XML Schema 1.0, Structures 3.4.2 and 3.10.6): the wildcards of
// a type and of its attribute groups intersect, and an extension adds the wildcard of its base.

import type { Wildcard } from './structure.js';

/** The namespaces a wildcard allows. '' stands for no namespace; `not` excludes a namespace and no namespace. */
export type NamespaceConstraint = { any: true } | { not: string } | { only: string[] };

export interface WildcardInEffect {
  namespaces: NamespaceConstraint;
  processContents: 'strict' | 'lax' | 'skip';
}

/** The namespaces of a wildcard as written. */
export function constraintOf(wildcard: Wildcard): NamespaceConstraint {
  const written = wildcard.namespace.trim();
  if (written === '##any') {
    return { any: true };
  }
  if (written === '##other') {
    return { not: wildcard.targetNamespace };
  }
  const names = written
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => (token === '##targetNamespace' ? wildcard.targetNamespace : token === '##local' ? '' : token));
  return { only: [...new Set(names)].sort() };
}

const same = (a: NamespaceConstraint, b: NamespaceConstraint): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The namespaces both allow; undefined where XML Schema 1.0 can't express it. */
export function intersect(a: NamespaceConstraint, b: NamespaceConstraint): NamespaceConstraint | undefined {
  if (same(a, b) || 'any' in b) {
    return a;
  }
  if ('any' in a) {
    return b;
  }
  if ('only' in a && 'only' in b) {
    return { only: a.only.filter((ns) => b.only.includes(ns)) };
  }
  if ('not' in a && 'only' in b) {
    return { only: b.only.filter((ns) => ns !== a.not && ns !== '') };
  }
  if ('only' in a && 'not' in b) {
    return { only: a.only.filter((ns) => ns !== b.not && ns !== '') };
  }
  return undefined;
}

/** The namespaces either allows; undefined where XML Schema 1.0 can't express it. */
export function union(a: NamespaceConstraint, b: NamespaceConstraint): NamespaceConstraint | undefined {
  if (same(a, b) || 'any' in a) {
    return a;
  }
  if ('any' in b) {
    return b;
  }
  if ('only' in a && 'only' in b) {
    return { only: [...new Set([...a.only, ...b.only])].sort() };
  }
  if ('not' in a && 'not' in b) {
    return { not: '' };
  }
  // One is a negation and the other a set: every other pairing has returned above.
  const negation = ('not' in a ? a : b) as { not: string };
  const set = ('only' in a ? a : b) as { only: string[] };
  const coversName = set.only.includes(negation.not);
  const coversNone = set.only.includes('');
  if (coversName && coversNone) {
    return { any: true };
  }
  if (!coversName && !coversNone) {
    return negation;
  }
  return undefined;
}
