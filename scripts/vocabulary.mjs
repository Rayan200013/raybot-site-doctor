// Makes data/schemaorg-vocabulary.json from schema.org's own vocabulary file:
// every type with its parents, every property with the types it belongs to,
// the types it expects, and whether it has been superseded.
//
//   curl -o schemaorg.jsonld https://schema.org/version/<version>/schemaorg-current-https.jsonld
//   node scripts/vocabulary.mjs schemaorg.jsonld <version> <release date>
//
// The vocabulary is schema.org's, under CC BY-SA 3.0 (see NOTICE.md).
import { readFileSync, writeFileSync } from 'node:fs';

const [file, version, released] = process.argv.slice(2);
if (!file || !version || !released) {
  console.error('usage: node scripts/vocabulary.mjs <schemaorg.jsonld> <version> <release date>');
  process.exit(1);
}

const graph = JSON.parse(readFileSync(file, 'utf8'))['@graph'];
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const name = (id) => String(id).replace(/^schema:/, '');
const isSchema = (id) => typeof id === 'string' && id.startsWith('schema:');

const types = {};
const properties = {};
for (const node of graph) {
  if (!isSchema(node['@id'])) continue;
  const kinds = list(node['@type']).map(String);
  const id = name(node['@id']);
  const isDataType = kinds.includes('schema:DataType') || kinds.includes('DataType');
  if (kinds.includes('rdfs:Class') || isDataType) {
    const parents = list(node['rdfs:subClassOf'])
      .map((p) => p['@id'])
      .filter(isSchema)
      .map(name);
    // A data type such as Text or URL is a class with DataType among its types.
    types[id] = isDataType && parents.length === 0 ? ['DataType'] : parents;
  }
  if (kinds.includes('rdf:Property')) {
    properties[id] = [
      list(node['schema:domainIncludes']).map((d) => name(d['@id'])),
      list(node['schema:rangeIncludes']).map((d) => name(d['@id'])),
      node['schema:supersededBy'] ? name(list(node['schema:supersededBy'])[0]['@id']) : 0,
    ];
  }
}
types.DataType ??= [];

const out = {
  about:
    'Types and properties of the schema.org vocabulary, from schema.org/version/' +
    version +
    '/schemaorg-current-https.jsonld. Licensed CC BY-SA 3.0 by schema.org; see NOTICE.md.',
  version,
  released,
  types,
  // name: [types it belongs to, types it expects, superseded by (or 0)]
  properties,
};
writeFileSync(new URL('../data/schemaorg-vocabulary.json', import.meta.url), JSON.stringify(out));
console.log(
  `schema.org ${version}: ${Object.keys(types).length} types, ${Object.keys(properties).length} properties`,
);
