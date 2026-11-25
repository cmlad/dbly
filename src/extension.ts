import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { BigQueryExecutor } from "./bigquery";
import {
  type ConnectionConfig,
  loadConfig,
  type PostgresConnectionConfig,
} from "./config";
import {
  formatConnectionComment,
  hasConnectionComment,
  parseConnectionName,
} from "./connectionComment";
import { describeError } from "./errorDetail";
import { PostgresSessionRegistry } from "./postgresSessions";
import { ResultsPanel } from "./resultsPanel";
import { findStatementAtLine } from "./statement";

let postgresSessions: PostgresSessionRegistry | undefined;
let resultsPanel: ResultsPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  postgresSessions = new PostgresSessionRegistry(
    (documentUri, connectionName, message) => {
      void vscode.window.showWarningMessage(
        `dbly: PostgreSQL session "${connectionName}" for ${documentUri} was lost; any open transaction was lost. ${message}. Run again to reconnect.`,
      );
    },
  );
  resultsPanel = new ResultsPanel();

  context.subscriptions.push(
    resultsPanel,
    vscode.commands.registerCommand(
      "dbly.selectConnection",
      protectCommand(() => selectConnectionForActiveEditor()),
    ),
    vscode.commands.registerCommand(
      "dbly.setPassword",
      protectCommand(() => setPostgresPassword(context)),
    ),
    vscode.commands.registerCommand(
      "dbly.reconnect",
      protectCommand(() => reconnectActiveDocument()),
    ),
    vscode.commands.registerCommand(
      "dbly.runStatement",
      protectCommand(() => runCurrentStatement(context)),
    ),
    vscode.workspace.onDidCloseTextDocument((document) => {
      void postgresSessions?.closeDocument(document.uri.toString());
    }),
  );
}

export async function deactivate(): Promise<void> {
  const registry = postgresSessions;
  postgresSessions = undefined;
  await registry?.disposeAll();
  resultsPanel?.dispose();
  resultsPanel = undefined;
}

async function selectConnectionForActiveEditor(): Promise<void> {
  const editor = activeSqlEditor();
  if (editor === undefined) {
    return;
  }

  const config = await loadConfig();
  const names = Object.keys(config.connections).sort((left, right) =>
    left.localeCompare(right),
  );
  if (names.length === 0) {
    await vscode.window.showWarningMessage(
      "dbly: No connections are configured in ~/config/dbly.yaml.",
    );
    return;
  }

  const name = await vscode.window.showQuickPick(names, {
    placeHolder: "Select a dbly connection",
  });
  if (name === undefined) {
    return;
  }

  const document = editor.document;
  const previousName = parseConnectionName(document.getText());
  const firstLine = document.lineAt(0).text;
  const marker = formatConnectionComment(name);
  const applied = await editor.edit((edit) => {
    if (hasConnectionComment(firstLine)) {
      edit.replace(new vscode.Range(0, 0, 0, firstLine.length), marker);
    } else {
      const newline =
        document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
      edit.insert(new vscode.Position(0, 0), `${marker}${newline}`);
    }
  });
  if (!applied) {
    await vscode.window.showErrorMessage(
      "dbly: The connection marker edit was not applied.",
    );
    return;
  }

  if (previousName !== name) {
    await postgresSessions?.closeDocument(document.uri.toString());
  }
  await vscode.window.showInformationMessage(`dbly: Selected "${name}".`);
}

async function setPostgresPassword(
  context: vscode.ExtensionContext,
): Promise<void> {
  const config = await loadConfig();
  const names = Object.entries(config.connections)
    .filter((entry): entry is [string, PostgresConnectionConfig] =>
      entry[1].type === "postgres",
    )
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) {
    await vscode.window.showWarningMessage(
      "dbly: No PostgreSQL connections are configured.",
    );
    return;
  }

  const name = await vscode.window.showQuickPick(names, {
    placeHolder: "Select a PostgreSQL connection",
  });
  if (name === undefined) {
    return;
  }

  const password = await vscode.window.showInputBox({
    password: true,
    ignoreFocusOut: true,
    prompt: `Password for ${name}`,
  });
  if (password === undefined) {
    return;
  }
  if (password.length === 0) {
    await vscode.window.showWarningMessage(
      "dbly: Password was not changed because it was empty.",
    );
    return;
  }

  await context.secrets.store(postgresPasswordKey(name), password);
  const closed = (await postgresSessions?.closeByConnection(name)) ?? 0;
  await vscode.window.showInformationMessage(
    `dbly: Password stored. Closed ${closed} session${closed === 1 ? "" : "s"}; affected documents will reconnect on their next run.`,
  );
}

async function reconnectActiveDocument(): Promise<void> {
  const editor = activeSqlEditor();
  if (editor === undefined) {
    return;
  }

  const documentUri = editor.document.uri.toString();
  const outcome = await postgresSessions?.reconnect(documentUri);
  if (outcome?.hadSession) {
    if (outcome.terminateWarning !== undefined) {
      await vscode.window.showWarningMessage(
        `dbly: Reset the local session, but could not confirm server backend termination (${outcome.terminateWarning}). The backend may still be executing, holding locks, or able to commit.`,
      );
      return;
    }
    if (outcome.queryMayHaveCompleted) {
      await vscode.window.showWarningMessage(
        "dbly: PostgreSQL session reset, but the in-flight statement may have completed before backend termination. Check its effects before retrying; any transaction still open at termination was rolled back.",
      );
      return;
    }
    await vscode.window.showInformationMessage(
      "dbly: PostgreSQL session closed; any open transaction was rolled back. The next run will reconnect.",
    );
    return;
  }

  const { connectionName, connection } = await resolveConnection(
    editor.document,
  );
  if (connection.type === "bigquery") {
    await vscode.window.showInformationMessage(
      "dbly: BigQuery has no persistent session.",
    );
    return;
  }
  await vscode.window.showInformationMessage(
    `dbly: No PostgreSQL session exists for "${connectionName}" in this document.`,
  );
  return;
}

async function runCurrentStatement(
  context: vscode.ExtensionContext,
): Promise<void> {
  const panel = resultsPanel;
  if (panel === undefined) {
    return;
  }
  const editor = activeSqlEditor();
  if (editor === undefined) {
    return;
  }

  const selectionText = editor.selection.isEmpty
    ? undefined
    : editor.document.getText(editor.selection).trim();
  const sql = editor.selection.isEmpty
    ? findStatementAtLine(
        editor.document.getText(),
        editor.selection.active.line,
      )
    : selectionText || undefined;
  if (sql === undefined) {
    await vscode.window.showWarningMessage(
      "dbly: There is no SQL statement at the cursor or in the selection.",
    );
    return;
  }
  const runId = panel.reserveRun();

  const documentUri = editor.document.uri.toString();
  const reservation = postgresSessions!.reserve(documentUri);
  let connectionName: string;
  let connection: ConnectionConfig;
  try {
    ({ connectionName, connection } = await resolveConnection(editor.document));
  } catch (error) {
    reservation.release();
    throw error;
  }
  if (connection.type === "bigquery") {
    try {
      await postgresSessions!.closeDocument(documentUri);
    } finally {
      reservation.release();
    }
  }
  panel.beginRun(runId);
  const started = performance.now();
  panel.showRunning(runId, connectionName);

  try {
    const result =
      connection.type === "postgres"
        ? await reservation.execute(
            connectionName,
            connection,
            () => context.secrets.get(postgresPasswordKey(connectionName)),
            sql,
          )
        : await new BigQueryExecutor(connection).execute(sql);
    panel.showResult(runId, {
      status: "success",
      connectionName,
      durationMs: performance.now() - started,
      ...result,
    });
  } catch (error) {
    panel.showFailure(runId, {
      status: "error",
      connectionName,
      durationMs: performance.now() - started,
      message:
        connection.type === "postgres"
          ? postgresQueryErrorMessage(error)
          : errorMessage(error),
      detail: describeError(error),
    });
  } finally {
    reservation.release();
  }
}

async function resolveConnection(
  document: vscode.TextDocument,
): Promise<{ connectionName: string; connection: ConnectionConfig }> {
  const connectionName = parseConnectionName(document.getText());
  if (connectionName === undefined) {
    throw new Error(
      "dbly: No connection marker on line 1. Run dbly: Select Connection.",
    );
  }

  const config = await loadConfig();
  if (!Object.hasOwn(config.connections, connectionName)) {
    throw new Error(
      `dbly: Connection "${connectionName}" is not configured. Run dbly: Select Connection.`,
    );
  }
  const connection = config.connections[connectionName];
  return { connectionName, connection };
}

function activeSqlEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.languageId !== "sql") {
    void vscode.window.showErrorMessage(
      "dbly: Open an active SQL editor to use this command.",
    );
    return undefined;
  }
  return editor;
}

function protectCommand(
  command: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    try {
      await command();
    } catch (error) {
      await vscode.window.showErrorMessage(errorMessage(error));
    }
  };
}

function postgresPasswordKey(connectionName: string): string {
  return `dbly.postgres.password:${connectionName}`;
}

function postgresQueryErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (
    code === "28P01" ||
    /password authentication failed|no password supplied|sasl.*password/i.test(
      message,
    )
  ) {
    return `${message} Run "dbly: Set Connection Password" to store the PostgreSQL password.`;
  }
  return message;
}

function errorMessage(error: unknown): string {
  // Connecting to "localhost" tries ::1 and 127.0.0.1; when both fail Node
  // throws an AggregateError with an empty message, so show the inner errors.
  if (error instanceof AggregateError && error.errors.length > 0) {
    return [...new Set(error.errors.map(errorMessage))].join("; ");
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (error !== null && typeof error === "object" && "code" in error) {
    return `dbly: connection failed (${String(error.code)}).`;
  }
  return "dbly: An unknown error occurred.";
}
