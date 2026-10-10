// Values replaced without narrowing unknown generic fields or breaking equality.
export function sanitizeEnvelope(value) {
  const relations = new Map(), vocabulary = new Set(['2.0', 'thread/start', 'thread/resume', 'turn/start',
    'text', 'image', 'file', 'object', 'string', 'number', 'boolean', 'array', 'null', 'append', 'replace',
    'full', 'workspace', 'user', 'automatic', 'default', 'fast', 'plan']);
  function safe(v) {
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v === 'string') {
      if (!v || vocabulary.has(v)) return v;
      if (!relations.has(v)) relations.set(v, '/fixture/value-' + (relations.size + 1));
      return relations.get(v);
    }
    if (Array.isArray(v)) return v.map(safe);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, safe(x)]));
    throw Error('Unsupported generic shape; no raw value emitted');
  }
  return safe(value);
}
