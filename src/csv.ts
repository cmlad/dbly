import type { CellValue } from "./database";

export function toCsv(columns: string[], rows: CellValue[][]): string {
  const records = [columns, ...rows].map((record) =>
    record.map(formatField).join(","),
  );
  return `${records.join("\r\n")}\r\n`;
}

function formatField(value: CellValue): string {
  if (value === null) {
    return "";
  }

  const text = String(value);
  if (!/[",\r\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}
