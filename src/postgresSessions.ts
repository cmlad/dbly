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
  cleanup: Promise<void> | undefined;
  terminateWarning: string | undefined;
}

export interface ReconnectResult {
  hadSession: boolean;
  terminateWarning?: string;
  queryMayHaveCompleted?: boolean;
}

type SessionLostHandler = (
  documentUri: string,
  connectionName: string,
  message: string,
) => void;

interface SessionTimeouts {
  terminateConnectMs: number;
  terminateQueryMs: number;
  clientEndMs: number;
}

type ClientFactory = (config: ClientConfig) => Client;

const DEFAULT_TIMEOUTS: SessionTimeouts = {
  terminateConnectMs: 5_000,
  terminateQueryMs: 5_000,
  clientEndMs: 2_000,
};

interface PendingReservationNode {
  generation: number;
  connectionName: string | undefined;
  cancelled: boolean;
  cancel(): void;
}

export interface PostgresRunReservation {
  execute(
    connectionName: string,
    config: PostgresConnectionConfig,
    readPassword: () => PromiseLike<string | undefined>,
    sql: string,
  ): Promise<DriverResult>;
  release(): void;
}

export class PostgresSessionRegistry {
  private readonly entries = new Map<string, PostgresSessionEntry>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();
  private readonly pendingReservations = new Map<
    string,
    Set<PendingReservationNode>
  >();
  private disposed = false;

  public constructor(
    private readonly onSessionLost: SessionLostHandler,
    private readonly createClient: ClientFactory = (config) => new Client(config),
    private readonly timeouts: SessionTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  public reserve(documentUri: string): PostgresRunReservation {
    const invocationGeneration = this.getGeneration(documentUri);
    const prior = this.queues.get(documentUri) ?? Promise.resolve();
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const tail = prior.then(
      () => completion,
      () => completion,
    );
    this.queues.set(documentUri, tail);
    void tail.then(() => {
      if (this.queues.get(documentUri) === tail) {
        this.queues.delete(documentUri);
      }
      this.maybeEvictDocument(documentUri);
    });

    let state: "pending" | "executing" | "released" | "cancelled" =
      "pending";
    let finished = false;
    let node!: PendingReservationNode;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      complete();
      const pending = this.pendingReservations.get(documentUri);
      pending?.delete(node);
      if (pending?.size === 0) {
        this.pendingReservations.delete(documentUri);
      }
      this.maybeEvictDocument(documentUri);
    };
    node = {
      generation: invocationGeneration,
      connectionName: undefined,
      cancelled: false,
      cancel: () => {
        if (state === "pending" || state === "executing") {
          node.cancelled = true;
          state = "cancelled";
          finish();
        }
      },
    };
    const pending =
      this.pendingReservations.get(documentUri) ??
      new Set<PendingReservationNode>();
    pending.add(node);
    this.pendingReservations.set(documentUri, pending);

    return {
      execute: (connectionName, config, readPassword, sql) => {
        if (state === "cancelled") {
          return Promise.reject(
            new Error("PostgreSQL run was cancelled because the session reset"),
          );
        }
        if (state !== "pending") {
          return Promise.reject(
            new Error("PostgreSQL run reservation is no longer available"),
          );
        }
        state = "executing";
        node.connectionName = connectionName;
        const execution = prior.then(() =>
          this.executeReserved(
            documentUri,
            connectionName,
            config,
            readPassword,
            sql,
            invocationGeneration,
            node,
          ),
        );
        void execution.then(finish, finish);
        return execution;
      },
      release: () => {
        if (state === "pending") {
          state = "released";
          finish();
        }
      },
    };
  }

  private async executeReserved(
    documentUri: string,
    connectionName: string,
    config: PostgresConnectionConfig,
    readPassword: () => PromiseLike<string | undefined>,
    sql: string,
    invocationGeneration: number,
    reservation: PendingReservationNode,
  ): Promise<DriverResult> {
    this.assertReservation(documentUri, invocationGeneration, reservation);
    const password = await readPassword();
    this.assertReservation(documentUri, invocationGeneration, reservation);
    const entry = await this.getOrCreateSession(
      documentUri,
      connectionName,
      config,
      password,
      invocationGeneration,
      reservation,
    );
    this.assertReservation(documentUri, invocationGeneration, reservation);

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
  }

  public async reconnect(documentUri: string): Promise<ReconnectResult> {
    if (!this.hasDocumentActivity(documentUri)) {
      return { hadSession: false };
    }
    this.incrementGeneration(documentUri);
    const entry = this.entries.get(documentUri);
    if (entry === undefined) {
      this.maybeEvictDocument(documentUri);
      return { hadSession: false };
    }

    const queryMayHaveCompleted = entry.queryInFlight;
    await this.resetEntry(entry, true);
    return {
      hadSession: true,
      ...(queryMayHaveCompleted ? { queryMayHaveCompleted: true } : {}),
      ...(entry.terminateWarning === undefined
        ? {}
        : { terminateWarning: entry.terminateWarning }),
    };
  }

  public async closeDocument(documentUri: string): Promise<void> {
    if (!this.hasDocumentActivity(documentUri)) {
      return;
    }
    this.incrementGeneration(documentUri);
    const entry = this.entries.get(documentUri);
    if (entry !== undefined) {
      await this.resetEntry(entry, false);
    }
    this.maybeEvictDocument(documentUri);
  }

  public async closeByConnection(connectionName: string): Promise<number> {
    const matching = [...this.entries.values()].filter(
      (entry) => entry.connectionName === connectionName,
    );
    const matchingDocuments = new Set(
      matching.map((entry) => entry.documentUri),
    );
    for (const entry of matching) {
      this.incrementGeneration(entry.documentUri);
    }
    for (const [documentUri, reservations] of this.pendingReservations) {
      if (matchingDocuments.has(documentUri)) {
        continue;
      }
      for (const reservation of [...reservations]) {
        if (reservation.connectionName === connectionName) {
          reservation.cancel();
        }
      }
      this.maybeEvictDocument(documentUri);
    }
    await Promise.all(
      matching.map((entry) => this.resetEntry(entry, false)),
    );
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
    await Promise.all(
      entries.map((entry) => this.resetEntry(entry, false)),
    );
  }

  private async getOrCreateSession(
    documentUri: string,
    connectionName: string,
    config: PostgresConnectionConfig,
    password: string | undefined,
    generation: number,
    reservation: PendingReservationNode,
  ): Promise<PostgresSessionEntry> {
    const configFingerprint = JSON.stringify(config);
    const existing = this.entries.get(documentUri);
    if (
      existing !== undefined &&
      existing.generation === generation &&
      existing.cleanup === undefined &&
      existing.connectionName === connectionName &&
      existing.configFingerprint === configFingerprint &&
      existing.password === password
    ) {
      return existing;
    }

    if (existing !== undefined) {
      await this.resetEntry(existing, false);
      this.assertReservation(documentUri, generation, reservation);
    }

    const clientConfig: ClientConfig = {
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      ...(password === undefined ? {} : { password }),
      ...(config.sslmode === "disable"
        ? {}
        : { ssl: { rejectUnauthorized: config.sslmode === "verify-full" } }),
    };
    const client = this.createClient(clientConfig);
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
      cleanup: undefined,
      terminateWarning: undefined,
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
      entry.intentionalClose = true;
      await this.resetEntry(entry, false);
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

    const terminator = this.createClient({
      ...entry.clientConfig,
      connectionTimeoutMillis: this.timeouts.terminateConnectMs,
      query_timeout: this.timeouts.terminateQueryMs,
    });
    terminator.on("error", () => undefined);
    try {
      await withTimeout(
        terminator.connect(),
        this.timeouts.terminateConnectMs,
        "timed out connecting to terminate the PostgreSQL backend",
        () => destroyClient(terminator),
      );
      const result = await withTimeout(
        terminator.query<{ terminated: boolean }>({
          text: "SELECT pg_terminate_backend($1) AS terminated",
          values: [entry.backendPid],
        }),
        this.timeouts.terminateQueryMs,
        "timed out terminating the PostgreSQL backend",
        () => destroyClient(terminator),
      );
      if (result.rows[0]?.terminated !== true) {
        throw new Error("PostgreSQL did not confirm backend termination");
      }
    } finally {
      await this.endClient(terminator);
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
    void this.resetEntry(entry, false);
  }

  private async resetEntry(
    entry: PostgresSessionEntry,
    terminateInFlight: boolean,
  ): Promise<void> {
    entry.intentionalClose = true;
    entry.cleanup ??= (async () => {
      try {
        if (terminateInFlight && entry.queryInFlight) {
          try {
            await this.terminateBackend(entry);
          } catch (error) {
            entry.terminateWarning =
              error instanceof Error ? error.message : String(error);
          }
        }
      } finally {
        await this.endClient(entry.client);
        if (this.entries.get(entry.documentUri) === entry) {
          this.entries.delete(entry.documentUri);
        }
        this.maybeEvictDocument(entry.documentUri);
      }
    })();
    await entry.cleanup;
  }

  private async endClient(client: Client): Promise<void> {
    try {
      await withTimeout(
        Promise.resolve().then(() => client.end()),
        this.timeouts.clientEndMs,
        "timed out closing a PostgreSQL client",
        () => destroyClient(client),
      );
    } catch {
      destroyClient(client);
    }
  }

  private assertReservation(
    documentUri: string,
    generation: number,
    reservation: PendingReservationNode,
  ): void {
    if (reservation.cancelled) {
      throw new Error("PostgreSQL run was cancelled because the session reset");
    }
    this.assertGeneration(documentUri, generation);
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

  private hasDocumentActivity(documentUri: string): boolean {
    return (
      this.entries.has(documentUri) ||
      this.queues.has(documentUri) ||
      (this.pendingReservations.get(documentUri)?.size ?? 0) > 0
    );
  }

  private maybeEvictDocument(documentUri: string): void {
    if (!this.hasDocumentActivity(documentUri)) {
      this.generations.delete(documentUri);
      this.pendingReservations.delete(documentUri);
    }
  }

  private getGeneration(documentUri: string): number {
    return this.generations.get(documentUri) ?? 0;
  }

  private incrementGeneration(documentUri: string): void {
    const generation = this.getGeneration(documentUri) + 1;
    this.generations.set(documentUri, generation);
    for (const node of [
      ...(this.pendingReservations.get(documentUri) ?? []),
    ]) {
      if (node.generation < generation) {
        node.cancel();
      }
    }
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

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      try {
        onTimeout();
      } finally {
        reject(new Error(message));
      }
    }, timeoutMs);
    timeout.unref();

    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function destroyClient(client: Client): void {
  const internalClient = client as unknown as {
    connection?: { stream?: { destroy: () => void } };
  };
  try {
    internalClient.connection?.stream?.destroy();
  } catch {
    // The client is already unusable; cleanup remains best effort.
  }
}
