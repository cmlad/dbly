export function findStatementAtLine(
  documentText: string,
  cursorLine: number,
): string | undefined {
  const lines = documentText.split(/\r?\n/);
  if (
    cursorLine < 0 ||
    cursorLine >= lines.length ||
    isBlank(lines[cursorLine])
  ) {
    return undefined;
  }

  let start = cursorLine;
  while (start > 0 && !isBlank(lines[start - 1])) {
    start -= 1;
  }

  let end = cursorLine;
  while (end + 1 < lines.length && !isBlank(lines[end + 1])) {
    end += 1;
  }

  const statement = lines.slice(start, end + 1).join("\n").trim();
  return statement || undefined;
}

function isBlank(line: string): boolean {
  return /^\s*$/.test(line);
}
