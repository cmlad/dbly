import { TextEncoder } from "node:util";
import * as vscode from "vscode";
import { toCsv } from "./csv";
import type { DriverResult } from "./database";

export async function saveResultAsCsv(result: DriverResult): Promise<void> {
  const destination = await vscode.window.showSaveDialog({
    filters: { CSV: ["csv"] },
    saveLabel: "Export CSV",
  });
  if (destination === undefined) {
    return;
  }

  await vscode.workspace.fs.writeFile(
    destination,
    new TextEncoder().encode(toCsv(result.columns, result.rows)),
  );
}

export async function openResultAsCsv(result: DriverResult): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    content: toCsv(result.columns, result.rows),
  });
  await vscode.window.showTextDocument(document);
}
