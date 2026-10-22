function stripBulletPrefix(line) {
  return String(line || "").trim().replace(/^(?:[-*•→🔸▪▸]|\d+[.)])\s*/, "").trim();
}

export function parseSponsorBulletItems(rawValue, minItems = 3) {
  const cleaned = String(rawValue || "").replace(/\r\n/g, "\n").split("\n").map((line) => stripBulletPrefix(line));
  while (cleaned.length > minItems && cleaned.at(-1) === "") cleaned.pop();
  const items = cleaned.some((item) => item.length > 0) ? cleaned : [];
  while (items.length < minItems) items.push("");
  return items;
}

export function serializeSponsorBulletItems(items, bulletPrefix = "-") {
  if (!Array.isArray(items)) return "";
  const nonEmpty = items.map((item) => stripBulletPrefix(item)).filter((item) => item.length > 0);
  return nonEmpty.length === 0 ? "" : nonEmpty.map((item) => `${bulletPrefix} ${item}`).join("\n");
}
