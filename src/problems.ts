import type { Node } from '@xmldom/xmldom';

/** Every code a problem can have. docs/output.md explains each one; a test keeps the two lists in step. */
export const PROBLEM_CODES = [
  // the schema accepts some values the XML Schema rejects
  'approximated-occurrences',
  'approximated-total-digits',
  'lexical-pattern',
  'rounded-number',
  'unreachable-enumeration',
  'unsupported-any',
  'unsupported-bound',
  'unsupported-identity-constraint',
  'unsupported-length',
  'unsupported-mixed',
  'unsupported-union',
  // XML documents the JSON form has no place for
  'unsupported-xsi-type',
  // constructs JSON Schema can't express
  'duplicate-name',
  'unsupported-element',
  'unsupported-facet',
  'unsupported-include',
  'unsupported-list',
  'unsupported-particle',
  'unsupported-redefine',
  'unsupported-simple-content',
  'unsupported-value',
  'untranslatable-pattern',
  // mistakes in the XML Schema
  'circular-group',
  'circular-type',
  'duplicate-component',
  'invalid-facet',
  'invalid-value',
  'unknown-attribute',
  'unknown-element',
  'unknown-group',
  'unknown-prefix',
  'unknown-type',
  // files and the root element
  'invalid-xml',
  'missing-file',
  'namespace-mismatch',
  'not-a-schema',
  'resource-limit',
  'root-required',
  'unknown-root',
  'unsafe-input',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

/**
 * Something the JSON Schema cannot express exactly. An `error` means the schema differs from the XML Schema; a
 * `warning` means it accepts some values the XML Schema rejects.
 */
export interface Problem {
  code: ProblemCode;
  severity: 'error' | 'warning';
  message: string;
  /** path of the schema document */
  file?: string;
  line?: number;
  column?: number;
}

/** Where a problem was found. */
export interface At {
  file?: string | undefined;
  node?: Node | undefined;
}

/** The message of a caught exception. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Collects the problems of one conversion; the same problem at the same place is kept once. */
export class Problems {
  readonly list: Problem[] = [];
  private readonly keys = new Set<string>();

  add(severity: Problem['severity'], code: ProblemCode, message: string, at: At = {}): void {
    const problem: Problem = { code, severity, message };
    if (at.file !== undefined) {
      problem.file = at.file;
    }
    if (at.node?.lineNumber !== undefined) {
      problem.line = at.node.lineNumber;
      if (at.node.columnNumber !== undefined) {
        problem.column = at.node.columnNumber;
      }
    }
    const key = JSON.stringify(problem);
    if (!this.keys.has(key)) {
      this.keys.add(key);
      this.list.push(problem);
    }
  }

  error(code: ProblemCode, message: string, at?: At): void {
    this.add('error', code, message, at);
  }

  warning(code: ProblemCode, message: string, at?: At): void {
    this.add('warning', code, message, at);
  }
}
