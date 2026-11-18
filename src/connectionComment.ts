const CONNECTION_COMMENT = /^\s*--\s*dbly:\s*(.*?)\s*$/;

export function formatConnectionComment(name: string): string {
  return `-- dbly: ${name}`;
}

export function parseConnectionName(documentText: string): string | undefined {
  const firstLine = documentText.split(/\r?\n/, 1)[0] ?? "";
  const match = CONNECTION_COMMENT.exec(firstLine);
  const name = match?.[1]?.trim();
  return name ? name : undefined;
}

export function hasConnectionComment(firstLine: string): boolean {
  return parseConnectionName(firstLine) !== undefined;
}
