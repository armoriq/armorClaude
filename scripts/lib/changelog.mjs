export function changelogSection(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${name}]`));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}
