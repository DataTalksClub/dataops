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

// The Card and Task dialogs open over whatever page is showing, so their
// params ride on every route: `card` (a Card page names it `cardId`) and
// `taskId`. Changing only these opens or closes a dialog; the page under it
// stays as it is.
export const MODAL_TASK_PARAM = "taskId";

export function cardParamOf(definition) {
  return definition.cardParam || "card";
}

export function routeParamNames(definition) {
  const names = [...definition.params];
  for (const name of [cardParamOf(definition), MODAL_TASK_PARAM]) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function modalParamNames(route) {
  return [route?.cardParam || "card", MODAL_TASK_PARAM];
}
