// One explicit execution classification, shared by Task and recurring forms.
// Unknown work stays unclassified rather than being offered as headless-safe.
export function createBrowserRequirementSelect(createQuickSelect, value = "unclassified") {
  const field = createQuickSelect(
    "Browser need",
    [
      ["unclassified", "Not classified"],
      ["headless", "Headless — finishes without a browser"],
      ["required", "Browser required"],
    ],
    value,
  );
  field.input.value = value;
  return field;
}
