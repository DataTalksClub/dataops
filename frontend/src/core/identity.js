// Person-facing text for the work surfaces. Small, pure, and shared by every
// surface that renders a teammate — the shell account menu and any avatar in
// the work queue — so the letters a name becomes cannot drift between them.

// One person, up to two letters: first letter of the first two words,
// uppercased, "?" when the name is empty.
export function personInitials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}
