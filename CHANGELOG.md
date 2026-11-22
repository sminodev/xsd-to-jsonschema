# Changelog

This changelog loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Release versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [unreleased]

## 1.0.0 - 2026-11-22

Initial release.

### Added

- Convert a selected XSD 1.0 root element to JSON Schema Draft 2020-12, resolving imports and includes. Run the CLI on
  schema files or use the library in Node.js and browsers.
- Map elements, attributes, choices and repeated groups to JSON. Simple types retain supported constraints such as
  enumerations, string patterns and decimal bounds.
- Inspect the XML content model with `describeSchema()` and `describeSchemaFile()`. The report preserves element order
  and links declarations to the generated JSON Schema.
- Locate unsupported constructs and input errors using diagnostic codes and source positions where available.
