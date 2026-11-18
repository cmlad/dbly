# dbly

dbly is a small VS Code query runner for PostgreSQL and BigQuery. It activates for VS Code's built-in `sql` language mode and deliberately does not add a SQL grammar, schema browser, or autocomplete.

## Commands

- **dbly: Select Connection** writes or replaces `-- dbly: <connection name>` on line 1 of the active SQL document.
- **dbly: Set Password** stores a PostgreSQL password in VS Code SecretStorage and closes active sessions that use that connection.
- **dbly: Reconnect** closes the active document's PostgreSQL session. BigQuery has no persistent session.
- **dbly: Run Current Statement** runs the selected text, or the paragraph at the cursor when there is no selection.

Run the current statement with <kbd>Cmd</kbd>+<kbd>Enter</kbd> on macOS or <kbd>Ctrl</kbd>+<kbd>Enter</kbd> elsewhere. The shortcut is active only while a SQL editor has focus.

## Configuration

Create `~/config/dbly.yaml` (this is intentionally `~/config`, not `~/.config`). Connection names are the keys under `connections`:

```yaml
connections:
  local-app:
    type: postgres
    host: localhost
    port: 5432 # optional; defaults to 5432
    user: chris
    database: app_development
    schema: public

  warehouse:
    type: bigquery
    project: acme-analytics
    dataset: reporting
    location: US # optional

  warehouse-keyfile:
    type: bigquery
    project: acme-analytics
    dataset: reporting
    auth:
      type: keyfile
      path: /Users/chris/.config/gcloud/dbly-reader.json
```

dbly reloads this file for every command, so ordinary edits apply without restarting VS Code.

PostgreSQL passwords do not belong in YAML. Run **dbly: Set Password** to save a non-empty password with VS Code SecretStorage. On desktop VS Code, Electron safe storage encrypts these secrets and macOS Keychain protects the safe-storage encryption material. dbly accesses secrets only through the VS Code API; it does not claim or require a separate Keychain item for each password. If no secret is stored, the PostgreSQL driver receives no explicit password, allowing trust/passwordless and normal driver environment authentication.

BigQuery uses Application Default Credentials when `auth` is omitted or set to `type: adc`. For local ADC setup, run:

```sh
gcloud auth application-default login
```

Keyfile authentication uses the absolute path in `auth.path`; keyfile contents are never copied into SecretStorage. The configured project and dataset are applied to every query, and `location` is optional.

## Selecting and running SQL

The line-1 marker is the only persisted connection association:

```sql
-- dbly: local-app
```

A non-empty selection is run as-is after trimming its outer whitespace. Without a selection, each maximal block of non-blank lines is a statement; blank or whitespace-only lines separate paragraphs. A cursor on a blank line has no current statement. dbly intentionally does not parse semicolons or SQL dialects. If the marker directly touches the first SQL paragraph, it is sent as a normal SQL comment with that paragraph.

The **dbly Results** panel is reused for the latest run across all files and stays beside the editor without stealing focus. It shows columns, all returned rows, the row or affected-row count, elapsed duration, and query errors. There is no row limit or paging in this version, so very large results can consume substantial extension-host and webview memory.

Successful results can be exported in full with **Export CSV** or opened as a new unsaved plaintext editor with **Open in Editor**. CSV uses CRLF records, quotes commas/quotes/line breaks, doubles quotes, and writes null as an empty field.

## PostgreSQL sessions and transactions

Each SQL document gets its own lazy, long-lived PostgreSQL session after its first PostgreSQL run. Commands in one document are serialized and reuse that same backend, so `BEGIN`, later statements, and `COMMIT` or `ROLLBACK` can be run one at a time. Separate SQL documents have independent sessions, even when they use the same named connection.

On a new session, dbly connects to the configured database and applies the configured schema as the initial PostgreSQL search path. A later `SET search_path` persists in that document's session. Changing the marker, connection configuration, or stored password replaces the session. A query-level SQL error does not discard it, so a failed transaction remains available for a later `ROLLBACK`.

> **Warning:** A forgotten transaction can retain locks and server resources. It remains open until you commit, roll back, reconnect, close the document, lose the connection, shut down the extension host, or change the session identity.

Closing a SQL document closes its session and rolls back any open transaction. An unexpected connection loss also loses transaction state; dbly warns, and the next explicit run reconnects. Each used/open SQL document consumes one PostgreSQL connection until one of these cleanup events.

**dbly: Reconnect** invalidates the document session immediately. For an idle session, dbly closes it, which rolls back any open transaction. If a query is running, dbly opens a short-lived second connection and calls `pg_terminate_backend` for the document's backend before dropping the local client. Even confirmed termination cannot prove that the statement did not finish first, so dbly warns you to check its effects before retrying. If termination cannot be confirmed, dbly still resets locally and warns that the server query may continue, retain locks, or commit. The next explicit run creates a fresh session. Reconnect does not track or display transaction status.

## Development

Requirements: a Node 22-capable environment and VS Code 1.101 or newer.

```sh
npm install
npm run check
npm test
npm run build
```

Press F5 in VS Code to run the extension in an Extension Development Host; the launch configuration builds first. Live PostgreSQL and BigQuery credentials are required for manual database smoke testing.
