# Notices

## schema.org vocabulary

`data/schemaorg-vocabulary.json` lists the types and properties of the schema.org
vocabulary, version 30.1 (released 16 September 2026), reduced to what the
structured-data check needs: each type's parents, and each property's types,
expected types and replacement. It is made from
`https://schema.org/version/30.1/schemaorg-current-https.jsonld` by
`scripts/vocabulary.mjs`.

The schema.org vocabulary is published by schema.org under the
[Creative Commons Attribution-ShareAlike License (version 3.0)](https://creativecommons.org/licenses/by-sa/3.0/).
This reduced copy is shared under the same licence. See
[schema.org/docs/terms.html](https://schema.org/docs/terms.html).

## Dependencies

Installed from npm, under their own licences: `@modelcontextprotocol/server`
(MIT), `zod` (MIT), `playwright-core` (Apache-2.0), `axe-core` (MPL-2.0) and
`parse5` (MIT). axe-core's script is read from its installed package and run in
the page being checked; it is not copied into this package.

The rest of this package is MIT licensed: see [LICENSE](LICENSE).
