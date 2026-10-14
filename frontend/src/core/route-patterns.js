// Resolve a concrete path to its route definition. Patterned routes name one
// path segment as `:param`; its decoded value joins the route params.
export function matchRoutePath(definitions, path) {
  if (Object.hasOwn(definitions, path) && !path.includes(":")) {
    return { pattern: path, definition: definitions[path], pathParams: {} };
  }
  const segments = path.split("/");
  for (const [pattern, definition] of Object.entries(definitions)) {
    if (!pattern.includes(":")) continue;
    const parts = pattern.split("/");
    if (parts.length !== segments.length) continue;
    const pathParams = {};
    const matches = parts.every((part, index) => {
      if (!part.startsWith(":")) return part === segments[index];
      if (!segments[index]) return false;
      const value = decodeURIComponent(segments[index]);
      if (!value.trim()) return false;
      pathParams[part.slice(1)] = value;
      return true;
    });
    if (matches) return { pattern, definition, pathParams };
  }
  return null;
}

export function concreteRoutePath(pattern, pathParams) {
  return pattern
    .split("/")
    .map((part) => (part.startsWith(":") ? encodeURIComponent(pathParams[part.slice(1)]) : part))
    .join("/");
}
