/** The XML form of a property or of the root element; see docs/output.md. */
export interface XmlAnnotation {
  /** local name of the root element */
  name?: string;
  /** namespace URI of a qualified element or attribute */
  namespace?: string;
  /** the property is an attribute */
  attribute?: boolean;
  /** the property holds the text of an element with simple content */
  text?: boolean;
}

export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

/** The subset of JSON Schema 2020-12 the converter writes. */
export interface JsonSchema {
  $schema?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  description?: string;
  type?: JsonType;
  format?: string;
  contentEncoding?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchema | boolean>;
  required?: string[];
  additionalProperties?: boolean;
  dependentRequired?: Record<string, string[]>;
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  xml?: XmlAnnotation;
}
