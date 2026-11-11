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
  /** the text property holds mixed content: text and child elements, as XML markup */
  mixed?: boolean;
  /** the property holds a repeated model group: an array with an object per occurrence */
  group?: boolean;
  /** how XML normalizes the whitespace of this string value before it is checked; absent for `preserve` */
  whiteSpace?: 'replace' | 'collapse';
  /** the array holds the items of an xs:list, not repeated elements */
  list?: boolean;
  /** the element is nillable: the property also allows its nil form */
  nillable?: boolean;
  /** xs:any: other child elements are written without a schema */
  anyElement?: boolean;
  /** xs:anyAttribute: other attributes are written as strings */
  anyAttribute?: boolean;
  /** the `#type` property: the type that xsi:type selects, as `{namespace}local` */
  xsiType?: boolean;
  /** the declared simple type of an element value, as `{namespace}local`: the only type xsi:type may name there */
  type?: string;
}

export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

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
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  xml?: XmlAnnotation;
}
