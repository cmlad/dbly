// Full, copyable description of a thrown value: type, message, driver fields
// (pg code/detail/hint/position, BigQuery reason/location, socket errno/address),
// nested errors (AggregateError, BigQuery `errors`, `cause`), and stack.

// HTTP client internals (Google auth headers live in `config`/`request`) and
// keys handled separately below.
const SKIPPED_KEYS: Record<string, true> = {
  stack: true,
  message: true,
  name: true,
  errors: true,
  cause: true,
  config: true,
  request: true,
  response: true,
  headers: true,
};
const SECRET_KEY = /pass|secret|token|authorization|credential|private/i;
const HTTP_KEY = /^(config|request|response|headers)$/;
const MAX_VALUE_LENGTH = 1000;

export function describeError(error: unknown): string {
  const lines: string[] = [];
  appendError(error, "", lines, new Set());
  return lines.join("\n");
}

function appendError(
  error: unknown,
  indent: string,
  lines: string[],
  seen: Set<object>,
): void {
  if (error === null || typeof error !== "object") {
    lines.push(`${indent}${String(error)}`);
    return;
  }
  if (seen.has(error)) {
    lines.push(`${indent}[circular]`);
    return;
  }
  seen.add(error);

  const name =
    error instanceof Error ? error.name : (error.constructor?.name ?? "Object");
  const message =
    "message" in error && error.message !== undefined
      ? String(error.message)
      : "";
  lines.push(`${indent}${name}${message === "" ? "" : `: ${message}`}`);

  for (const [key, value] of Object.entries(error)) {
    if (
      Object.hasOwn(SKIPPED_KEYS, key) ||
      value === undefined ||
      value === null ||
      value === ""
    ) {
      continue;
    }
    const shown = SECRET_KEY.test(key) ? "<redacted>" : formatValue(value);
    lines.push(`${indent}  ${key}: ${shown}`);
  }

  const nested: unknown[] = [];
  if ("errors" in error && Array.isArray(error.errors)) {
    nested.push(...error.errors);
  }
  if ("cause" in error && error.cause !== undefined) {
    nested.push(error.cause);
  }
  for (const inner of nested) {
    appendError(inner, `${indent}  `, lines, seen);
  }

  if (error instanceof Error && error.stack !== undefined) {
    // The first stack line repeats "Name: message".
    for (const frame of error.stack.split("\n").slice(1)) {
      lines.push(`${indent}  ${frame.trim()}`);
    }
  }
}

function formatValue(value: unknown): string {
  let text: string;
  if (typeof value === "object") {
    try {
      text = JSON.stringify(value, (key, nested: unknown) =>
        key !== "" && (SECRET_KEY.test(key) || HTTP_KEY.test(key))
          ? "<redacted>"
          : nested,
      );
    } catch {
      text = "[unserializable]";
    }
  } else {
    text = String(value);
  }
  return text.length > MAX_VALUE_LENGTH
    ? `${text.slice(0, MAX_VALUE_LENGTH)}…`
    : text;
}
