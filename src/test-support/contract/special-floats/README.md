`invalid-nan-below-bound.xml` is invalid under XSD 1.0 (Datatypes 3.2.5, double: a bound excludes NaN unless it is
an inclusive NaN bound). libxml2 2.13.9 wrongly accepts it. The specification decides; the schema must reject the
JSON of that document.
