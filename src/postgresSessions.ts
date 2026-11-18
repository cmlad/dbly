import { Client, type ClientConfig, type QueryResult } from "pg";
import type { PostgresConnectionConfig } from "./config";
import { normalizeCell, type DriverResult } from "./database";

interface PostgresSessionEntry {
  documentUri: string;
  connectionName: string;
  configFingerprint: string;
  password: string | undefined;
  clientConfig: ClientConfig;
  client: Client;
  backendPid: number | undefined;
  queryInFlight: boolean;
  generation: number;
  intentionalClose: boolean;
  ready: boolean;
  lostNotified: boolean;
  closing: Promise<void> | undefined;
}

export interface ReconnectResult {
  hadSession: boolean;
  terminateWarning?: string;
}

type SessionLostHandler = (
  documentUri: string,
  connectionName: string,
  message: string,
) => void;

export class PostgresSessionRegistry {
  private readonly entries = new Map<string, PostgresSessionEntry>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();
  private disposed = false;

  public constructor(private readonly onSessionLost: SessionLostHandler) {}

  public execute(
    documentUri: string,
    connectionName: string,
    config: PostgresConnectionConfig,
    password: string | undefined,
    sql: string,
  ): Promise<DriverResult> {
    if (this.disposed) {
      return Promise.reject(new Error("PostgreSQL sessions have been disposed"));
    }

    const invocationGeneration = this.getGeneration(documentUri);
    const prior = this.queues.get(documentUri) ?? Promise.resolve();
    const execution = prior.then(async () => {
      this.assertGeneration(documentUri, invocationGeneration);
      const entry = await this.getOrCreateSession(
        documentUri,
        connectionName,
        config,
        password,
        invocationGeneration,
      );
      this.assertGeneration(documentUri, invocationGeneration);

      entry.queryInFlight = true;
      try {
        const response = (await entry.client.query({
          text: sql,
          rowMode: "array",
        })) as QueryResult<unknown[]> | QueryResult<unknown[]>[];
        return normalizePostgresResult(response);
      } finally {
        entry.queryInFlight = false;
      }
    });

    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(documentUri, tail);
    void tail.finally(() => {
      if (this.queues.get(documentUri) === tail) {
        this.queues.delete(documentUri);
      }
    });
    return execution;
  }

  public async reconnect(documentUri: string): Promise<ReconnectResult> {
    this.incrementGeneration(documentUri);
    const entry = this.entries.get(documentUri);
    if (entry === undefined) {
      return { hadSession: false };
    }

    this.entries.delete(documentUri);
    entry.intentionalClose = true;
    let terminateWarning: string | undefined;
    if (entry.queryInFlight) {
      try {
        await this.terminateBackend(entry);
      } catch (error) {
        terminateWarning = error instanceof Error ? error.message : String(error);
      }
    }
    await this.closeEntry(entry);

    return {
      hadSession: true,
      ...(terminateWarning === undefined ? {} : { terminateWarning }),
    };
  }

  public async closeDocument(documentUri: string): Promise<void> {
    this.incrementGeneration(documentUri);
    const entry = this.entries.get(documentUri);
    if (entry === undefined) {
      return;
    }

    this.entries.delete(documentUri);
    entry.intentionalClose = true;
    await this.closeEntry(entry);
  }

  public async closeByConnection(connectionName: string): Promise<number> {
    const matching = [...this.entries.values()].filter(
      (entry) => entry.connectionName === connectionName,
    );
    for (const entry of matching) {
      this.incrementGeneration(entry.documentUri);
      if (this.entries.get(entry.documentUri) === entry) {
        this.entries.delete(entry.documentUri);
      }
      entry.intentionalClose = true;
    }
    await Promise.all(matching.map((entry) => this.closeEntry(entry)));
    return matching.length;
  }

  public async disposeAll(): Promise<void> {
    this.disposed = true;
    for (const documentUri of new Set([
      ...this.entries.keys(),
      ...this.queues.keys(),
    ])) {
      this.incrementGeneration(documentUri);
    }

    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      entry.intentionalClose = true;
    }
    await Promise.all(entries.map((entry) => this.closeEntry(entry)));
  }

  private async getOrCreateSession(
    documentUri: string,
    connectionName: string,
    config: PostgresConnectionConfig,
    password: string | undefined,
    generation: number,
  ): Promise<PostgresSessionEntry> {
    const configFingerprint = JSON.stringify(config);
    const existing = this.entries.get(documentUri);
    if (
      existing !== undefined &&
      existing.connectionName === connectionName &&
      existing.configFingerprint === configFingerprint &&
      existing.password === password
    ) {
      return existing;
    }

    if (existing !== undefined) {
      this.entries.delete(documentUri);
      existing.intentionalClose = true;
      await this.closeEntry(existing);
      this.assertGeneration(documentUri, generation);
    }

    const clientConfig: ClientConfig = {
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      ...(password === undefined ? {} : { password }),
    };
    const client = new Client(clientConfig);
    const entry: PostgresSessionEntry = {
      documentUri,
      connectionName,
      configFingerprint,
      password,
      clientConfig,
      client,
      backendPid: undefined,
      queryInFlight: false,
      generation,
      intentionalClose: false,
      ready: false,
      lostNotified: false,
      closing: undefined,
    };

    client.on("error", (error: Error) => {
      this.handleUnexpectedLoss(entry, error.message);
    });
    client.on("end", () => {
      this.handleUnexpectedLoss(entry, "the PostgreSQL connection ended");
    });
    this.entries.set(documentUri, entry);

    try {
      await client.connect();
      this.assertCurrentEntry(entry);
      const initialization = await client.query<{ backend_pid: number }>({
        text: "SELECT set_config('search_path', quote_ident($1), false), pg_backend_pid() AS backend_pid",
        values: [config.schema],
      });
      this.assertCurrentEntry(entry);

      const backendPid = Number(initialization.rows[0]?.backend_pid);
      if (!Number.isInteger(backendPid) || backendPid <= 0) {
        throw new Error("PostgreSQL did not return a valid backend PID");
      }
      entry.backendPid = backendPid;
      entry.ready = true;
      return entry;
    } catch (error) {
      if (this.entries.get(documentUri) === entry) {
        this.entries.delete(documentUri);
      }
      entry.intentionalClose = true;
      await this.closeEntry(entry);
      if (this.getGeneration(documentUri) !== generation) {
        throw new Error("PostgreSQL run was cancelled because the session reset");
      }
      throw error;
    }
  }

  private async terminateBackend(entry: PostgresSessionEntry): Promise<void> {
    if (entry.backendPid === undefined) {
      throw new Error("the PostgreSQL backend PID was unavailable");
    }

    const terminator = new Client(entry.clientConfig);
    try {
      await terminator.connect();
      const result = await terminator.query<{ terminated: boolean }>({
        text: "SELECT pg_terminate_backend($1) AS terminated",
        values: [entry.backendPid],
      });
      if (result.rows[0]?.terminated !== true) {
        throw new Error("PostgreSQL did not confirm backend termination");
      }
    } finally {
      try {
        await terminator.end();
      } catch {
        // The termination result is more useful than an error while closing it.
      }
    }
  }

  private handleUnexpectedLoss(
    entry: PostgresSessionEntry,
    message: string,
  ): void {
    if (
      entry.intentionalClose ||
      entry.lostNotified ||
      this.entries.get(entry.documentUri) !== entry
    ) {
      return;
    }

    this.entries.delete(entry.documentUri);
    this.incrementGeneration(entry.documentUri);
    entry.lostNotified = true;
    if (entry.ready) {
      this.onSessionLost(entry.documentUri, entry.connectionName, message);
    }
    entry.intentionalClose = true;
    void this.closeEntry(entry);
  }

  private async closeEntry(entry: PostgresSessionEntry): Promise<void> {
    entry.closing ??= (async () => {
      try {
        await entry.client.end();
      } catch {
        // Cleanup is best effort; the registry has already invalidated the entry.
      }
    })();
    await entry.closing;
  }

  private assertCurrentEntry(entry: PostgresSessionEntry): void {
    this.assertGeneration(entry.documentUri, entry.generation);
    if (this.entries.get(entry.documentUri) !== entry) {
      throw new Error("PostgreSQL run was cancelled because the session reset");
    }
  }

  private assertGeneration(documentUri: string, generation: number): void {
    if (this.disposed || this.getGeneration(documentUri) !== generation) {
      throw new Error("PostgreSQL run was cancelled because the session reset");
    }
  }

  private getGeneration(documentUri: string): number {
    return this.generations.get(documentUri) ?? 0;
  }

  private incrementGeneration(documentUri: string): void {
    this.generations.set(documentUri, this.getGeneration(documentUri) + 1);
  }
}

function normalizePostgresResult(
  response: QueryResult<unknown[]> | QueryResult<unknown[]>[],
): DriverResult {
  const finalResult = Array.isArray(response) ? response.at(-1) : response;
  if (finalResult === undefined) {
    return { columns: [], rows: [], rowCount: "0" };
  }

  return {
    columns: finalResult.fields.map((field) => field.name),
    rows: finalResult.rows.map((row) => row.map(normalizeCell)),
    rowCount: String(finalResult.rowCount ?? finalResult.rows.length),
  };
}
