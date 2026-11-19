import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { DriverResult } from "./database";
import { openResultAsCsv, saveResultAsCsv } from "./resultsExport";

export interface RunSuccess extends DriverResult {
  status: "success";
  connectionName: string;
  durationMs: number;
}

export interface RunFailure {
  status: "error";
  connectionName: string;
  durationMs: number;
  message: string;
}

interface RunRunning {
  status: "running";
  connectionName: string;
}

type PanelState = RunRunning | RunSuccess | RunFailure;

export class ResultsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private nextRunId = 0;
  private currentRunId = 0;
  private currentState: PanelState | undefined;
  private exportResult: DriverResult | undefined;
  private webviewReady = false;
  private disposed = false;

  public reserveRun(): number {
    this.nextRunId += 1;
    return this.nextRunId;
  }

  public beginRun(runId: number): void {
    if (runId > this.currentRunId) {
      this.currentRunId = runId;
      this.exportResult = undefined;
    }
  }

  public showRunning(runId: number, connectionName: string): void {
    if (!this.isCurrentRun(runId)) {
      return;
    }
    this.ensurePanel();
    this.currentState = { status: "running", connectionName };
    this.postCurrentState();
  }

  public showResult(runId: number, success: RunSuccess): void {
    if (!this.isCurrentRun(runId) || this.panel === undefined) {
      return;
    }
    this.currentState = success;
    this.exportResult = {
      columns: success.columns,
      rows: success.rows,
      rowCount: success.rowCount,
    };
    this.postCurrentState();
  }

  public showFailure(runId: number, failure: RunFailure): void {
    if (!this.isCurrentRun(runId) || this.panel === undefined) {
      return;
    }
    this.currentState = failure;
    this.exportResult = undefined;
    this.postCurrentState();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.panel?.dispose();
    this.clearPanel();
  }

  private ensurePanel(): void {
    if (this.disposed) {
      return;
    }
    if (this.panel !== undefined) {
      // Keep the panel wherever the user moved it (e.g. a bottom editor group).
      this.panel.reveal(undefined, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "dblyResults",
      "dbly Results",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [] },
    );
    this.panel = panel;
    this.webviewReady = false;
    panel.webview.html = this.getHtml(panel.webview);
    this.panelDisposables = [
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.clearPanel();
        }
      }),
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message);
      }),
    ];
  }

  private isCurrentRun(runId: number): boolean {
    return runId === this.currentRunId;
  }

  private postCurrentState(): void {
    if (
      this.panel === undefined ||
      !this.webviewReady ||
      this.currentState === undefined
    ) {
      return;
    }
    void this.panel.webview.postMessage(this.currentState);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (
      message !== null &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "ready"
    ) {
      this.webviewReady = true;
      this.postCurrentState();
      return;
    }

    if (
      message !== null &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "copy" &&
      "text" in message &&
      typeof message.text === "string"
    ) {
      await vscode.env.clipboard.writeText(message.text);
      return;
    }

    if (this.exportResult === undefined) {
      return;
    }

    try {
      if (
        message !== null &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "exportCsv"
      ) {
        await saveResultAsCsv(this.exportResult);
      } else if (
        message !== null &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "openCsv"
      ) {
        await openResultAsCsv(this.exportResult);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`dbly export failed: ${detail}`);
    }
  }

  private clearPanel(): void {
    for (const disposable of this.panelDisposables) {
      disposable.dispose();
    }
    this.panelDisposables = [];
    this.panel = undefined;
    this.currentState = undefined;
    this.exportResult = undefined;
    this.webviewReady = false;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const csp = [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource}`,
    ].join("; ");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>dbly Results</title>
  <style nonce="${nonce}">
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 12px; }
    header { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
    #connection { font-weight: 600; }
    #summary, #error { white-space: pre-wrap; }
    #error { color: var(--vscode-errorForeground); }
    #actions { display: none; gap: 8px; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 10px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .table-wrap { overflow: auto; max-height: calc(100vh - 100px); }
    table { border-collapse: collapse; min-width: 100%; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left; white-space: nowrap; vertical-align: top; position: relative; }
    .value { display: block; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .copy { display: none; position: absolute; top: 1px; right: 1px; padding: 1px 6px; font-size: 11px; }
    td:hover .copy { display: block; }
    th { position: sticky; top: 0; background: var(--vscode-editor-background); }
    .resizer { position: absolute; top: 0; right: -3px; bottom: 0; width: 6px; cursor: col-resize; z-index: 1; }
    .resizer:hover, body.resizing .resizer { background: var(--vscode-focusBorder); }
    body.resizing { cursor: col-resize; user-select: none; }
  </style>
  <style id="columns" nonce="${nonce}"></style>
</head>
<body>
  <header>
    <span id="connection"></span>
    <span id="summary"></span>
    <span id="actions">
      <button id="export" type="button">Export CSV</button>
      <button id="open" type="button">Open in Editor</button>
    </span>
  </header>
  <div id="error"></div>
  <div class="table-wrap"><table id="table"></table></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const connection = document.getElementById('connection');
    const summary = document.getElementById('summary');
    const actions = document.getElementById('actions');
    const error = document.getElementById('error');
    const table = document.getElementById('table');

    document.getElementById('export').addEventListener('click', () => vscode.postMessage({ type: 'exportCsv' }));
    document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'openCsv' }));

    // One shared copy button, moved into whichever cell is hovered.
    const copyButton = document.createElement('button');
    copyButton.className = 'copy';
    copyButton.type = 'button';
    copyButton.textContent = 'Copy';
    table.addEventListener('mouseover', (event) => {
      const cell = event.target instanceof Element ? event.target.closest('td') : null;
      if (cell !== null && copyButton.parentElement !== cell) {
        copyButton.textContent = 'Copy';
        cell.appendChild(copyButton);
      }
    });
    copyButton.addEventListener('click', () => {
      const value = copyButton.parentElement?.querySelector('.value');
      vscode.postMessage({ type: 'copy', text: value ? value.textContent : '' });
      copyButton.textContent = 'Copied';
    });

    // Column widths live in one CSS rule per column so dragging touches no cells.
    const columnSheet = document.getElementById('columns').sheet;
    let drag = null;
    table.addEventListener('mousedown', (event) => {
      if (!(event.target instanceof Element) || !event.target.classList.contains('resizer')) {
        return;
      }
      event.preventDefault();
      const header = event.target.parentElement;
      const index = Array.prototype.indexOf.call(header.parentElement.children, header);
      drag = {
        rule: columnSheet.cssRules[index],
        startX: event.clientX,
        startWidth: header.querySelector('.value').getBoundingClientRect().width,
      };
      document.body.classList.add('resizing');
    });
    document.addEventListener('mousemove', (event) => {
      if (drag === null) {
        return;
      }
      const width = Math.max(30, drag.startWidth + event.clientX - drag.startX) + 'px';
      drag.rule.style.width = width;
      drag.rule.style.maxWidth = width;
    });
    document.addEventListener('mouseup', () => {
      drag = null;
      document.body.classList.remove('resizing');
    });
    // Double-click a header edge to fit the column to its longest value.
    table.addEventListener('dblclick', (event) => {
      if (!(event.target instanceof Element) || !event.target.classList.contains('resizer')) {
        return;
      }
      const header = event.target.parentElement;
      const index = Array.prototype.indexOf.call(header.parentElement.children, header);
      const rule = columnSheet.cssRules[index];
      rule.style.width = '';
      rule.style.maxWidth = 'none';
    });

    window.addEventListener('message', (event) => {
      const state = event.data;
      connection.textContent = state.connectionName;
      summary.textContent = '';
      error.textContent = '';
      actions.style.display = 'none';
      table.replaceChildren();

      if (state.status === 'running') {
        summary.textContent = 'Running…';
        return;
      }
      if (state.status === 'error') {
        summary.textContent = Math.round(state.durationMs) + ' ms';
        error.textContent = state.message;
        return;
      }
      summary.textContent = state.rowCount + ' rows · ' + Math.round(state.durationMs) + ' ms';

      actions.style.display = 'flex';
      const headRow = document.createElement('tr');
      while (columnSheet.cssRules.length > 0) {
        columnSheet.deleteRule(0);
      }
      state.columns.forEach((column, index) => {
        columnSheet.insertRule('tr > :nth-child(' + (index + 1) + ') > .value {}', index);
        const cell = document.createElement('th');
        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = column;
        value.title = column;
        const resizer = document.createElement('div');
        resizer.className = 'resizer';
        cell.append(value, resizer);
        headRow.appendChild(cell);
      });
      const head = document.createElement('thead');
      head.appendChild(headRow);
      table.appendChild(head);

      const body = document.createElement('tbody');
      for (const row of state.rows) {
        const tableRow = document.createElement('tr');
        for (const raw of row) {
          const text = raw === null ? '' : String(raw);
          const cell = document.createElement('td');
          const value = document.createElement('span');
          value.className = 'value';
          value.textContent = text;
          value.title = text;
          cell.appendChild(value);
          tableRow.appendChild(cell);
        }
        body.appendChild(tableRow);
      }
      table.appendChild(body);
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
