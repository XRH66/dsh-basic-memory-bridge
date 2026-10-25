/** Compile the tool-schema subset DSH accepts into registry JSON Schema. */

function compileNode(node) {
  const spec = node && typeof node === 'object' ? node : { type: 'string' };
  const out = { type: spec.type };
  if (typeof spec.description === 'string') out.description = spec.description;
  if (Array.isArray(spec.enum) && spec.enum.length > 0) out.enum = [...spec.enum];
  if (spec.type === 'array') out.items = compileNode(spec.items ?? { type: 'string' });
  if (spec.type === 'object') {
    if (spec.properties && typeof spec.properties === 'object') {
      const compiled = compileProperties(spec.properties);
      out.properties = compiled.properties;
      if (compiled.required.length > 0) out.required = compiled.required;
      out.additionalProperties = spec.additionalProperties === true;
    } else {
      out.additionalProperties = true;
    }
  }
  return out;
}

function compileProperties(spec) {
  const properties = {};
  const required = [];
  for (const [name, node] of Object.entries(spec ?? {})) {
    properties[name] = compileNode(node);
    if (node && node.required === true) required.push(name);
  }
  return { properties, required };
}

/** Convert a DSH parameter spec (with per-property required flags) to JSON Schema. */
export function compileSpec(spec) {
  const compiled = compileProperties(spec);
  const schema = { type: 'object', properties: compiled.properties, additionalProperties: false };
  if (compiled.required.length > 0) schema.required = compiled.required;
  return schema;
}
