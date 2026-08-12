export function html(strings, ...values) {
  return strings.reduce(
    (markup, segment, index) =>
      markup + segment + (index < values.length ? values[index] : ""),
    "",
  );
}
