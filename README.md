# dbly

A small VS Code query runner for PostgreSQL and BigQuery. Open a `.sql` file, pick a connection, put the cursor in a statement, press <kbd>Cmd</kbd>+<kbd>Enter</kbd>, and the results show up in a table.

dbly uses VS Code's built-in SQL language mode. It does not add syntax highlighting, a schema browser, or autocomplete.

## Install

```sh
npm install
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension dbly-0.0.1.vsix --force
```

Then reload VS Code (**Developer: Reload Window**). Requires VS Code 1.101 or newer.

## Configuration

Connections live in `~/config/dbly.yaml` (note: `~/config`, not `~/.config`). The key under `connections` is the connection name:

```yaml
connections:
  local-app:
    type: postgres
    host: localhost
    port: 5432          # optional, default 5432
    sslmode: require    # optional: disable (default), require (encrypt, no cert check), verify-full
    user: app_user
    database: app_development
    schema: public      # initial search_path

  warehouse:
    type: bigquery
    project: my-gcp-project
    dataset: reporting  # default dataset for unqualified table names
    location: US        # optional

  warehouse-keyfile:
    type: bigquery
    project: my-gcp-project
    dataset: reporting
    auth:
      type: keyfile
      path: /absolute/path/to/service-account.json
```

The file is re-read on every command, so edits apply without restarting VS Code.

### Credentials

- **PostgreSQL:** passwords are never stored in the YAML file. Run **dbly: Set Connection Password** to store one in VS Code SecretStorage (encrypted; on macOS protected by the Keychain).
- **BigQuery:** uses Application Default Credentials unless `auth.type: keyfile` is set. For ADC run `gcloud auth application-default login`.

## Usage

| Command | What it does |
| --- | --- |
| **dbly: Select Connection** | Writes `-- dbly: <name>` on line 1 of the file. This comment is how a file remembers its connection. |
| **dbly: Run Current Statement** (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) | Runs the selection if there is one, otherwise the paragraph (block of non-blank lines) under the cursor. |
| **dbly: Set Connection Password** | Stores a PostgreSQL password and closes sessions using that connection. |
| **dbly: Reconnect** | Kills the file's PostgreSQL session (see below). |

dbly does not parse SQL or split on semicolons. If a run contains several PostgreSQL statements, only the last result is shown.

### Results panel

- One results panel is reused for the latest run. It opens beside the editor without taking focus; if you move it (for example to a group below the editor), it stays there.
- Cells are single-line and truncated at 120px. Hover a cell to see the full value and a **Copy** button.
- Drag a header's right edge to resize a column; double-click the edge to fit the column to its content.
- **Export CSV** saves the full result to a file; **Open in Editor** opens it as an unsaved CSV document.
- All rows are loaded; there is no row limit or paging, so very large results use a lot of memory.

## PostgreSQL sessions and transactions

Each SQL file gets its own long-lived PostgreSQL session, opened on its first run. Runs in one file are queued and share that session, so you can execute `BEGIN`, then statements one by one, then `COMMIT` or `ROLLBACK`. Different files have independent sessions.

- The configured schema is set as `search_path` once when the session opens; your own `SET search_path` persists.
- Changing the file's connection, the connection's config, or its password replaces the session.
- Closing the file closes its session and rolls back any open transaction.
- If the connection drops, dbly warns that any open transaction was lost; the next run reconnects.

> **Warning:** an open transaction holds its locks until you commit, roll back, reconnect, or close the file.

**dbly: Reconnect** resets the file's session. If a query is running, dbly terminates the server backend (`pg_terminate_backend`) from a short-lived second connection before closing the session. A statement may still have finished just before it was killed, so check its effects before retrying. The next run opens a fresh session.

BigQuery has no session; each run is an independent query job.

## Development

```sh
npm install
npm run check   # type-check
npm test        # unit tests
npm run build   # bundle to dist/extension.js
```

Press F5 in VS Code to launch an Extension Development Host with the extension loaded.
