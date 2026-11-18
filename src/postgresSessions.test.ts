import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";
import type { Client, ClientConfig } from "pg";
import type { PostgresConnectionConfig } from "./config";
import { PostgresSessionRegistry } from "./postgresSessions";

const CONNECTION: PostgresConnectionConfig = {
  type: "postgres",
  host: "localhost",
  port: 5432,
  user: "dbly",
  database: "dbly_test",
  schema: "public",
};

class FakeClient {
  public readonly queryTexts: string[] = [];
  public readonly connection: { stream: { destroy: () => void } };
  public endCalls = 0;
  public destroyed = false;

  public constructor(
    private readonly queryHandler: (text: string) => Promise<unknown>,
    private readonly onClose: () => void = () => undefined,
  ) {
    this.connection = {
      stream: {
        destroy: () => {
          this.destroyed = true;
          this.onClose();
        },
      },
    };
  }

  public async connect(): Promise<void> {}

  public query(config: { text: string }): Promise<unknown> {
    this.queryTexts.push(config.text);
    if (config.text.startsWith("SELECT set_config")) {
      return Promise.resolve({ rows: [{ backend_pid: 4321 }] });
    }
    return this.queryHandler(config.text);
  }

  public async end(): Promise<void> {
    this.endCalls += 1;
    this.onClose();
  }

  public on(): this {
    return this;
  }
}

test("reuses one client and serializes runs for a document", async () => {
  const firstStarted = deferred<void>();
  const firstResult = deferred<unknown>();
  const session = new FakeClient((sql) => {
    if (sql === "SELECT first") {
      firstStarted.resolve();
      return firstResult.promise;
    }
    return Promise.resolve(queryResult(sql));
  });
  let clientsCreated = 0;
  const registry = new PostgresSessionRegistry(
    () => undefined,
    (_config: ClientConfig) => {
      clientsCreated += 1;
      return session as unknown as Client;
    },
  );

  const firstReservation = registry.reserve("file:///query.sql");
  const secondReservation = registry.reserve("file:///query.sql");
  const secondRun = secondReservation.execute(
    "local",
    CONNECTION,
    undefined,
    "SELECT second",
  );
  await waitForImmediate();
  assert.equal(clientsCreated, 0);

  const firstRun = firstReservation.execute(
    "local",
    CONNECTION,
    undefined,
    "SELECT first",
  );
  await firstStarted.promise;
  await waitForImmediate();
  assert.deepEqual(
    session.queryTexts.filter((text) => !text.startsWith("SELECT set_config")),
    ["SELECT first"],
  );

  firstResult.resolve(queryResult("first"));
  await Promise.all([firstRun, secondRun]);
  assert.equal(clientsCreated, 1);
  assert.deepEqual(
    session.queryTexts.filter((text) => !text.startsWith("SELECT set_config")),
    ["SELECT first", "SELECT second"],
  );
  await registry.disposeAll();
});

test("bounds reconnect termination, retains cleanup, and cancels queued runs", async () => {
  const queryStarted = deferred<void>();
  const activeQuery = deferred<unknown>();
  let activeClosed = false;
  const session = new FakeClient(
    (sql) => {
      assert.equal(sql, "SELECT slow");
      queryStarted.resolve();
      return activeQuery.promise;
    },
    () => {
      if (!activeClosed) {
        activeClosed = true;
        activeQuery.reject(new Error("session closed"));
      }
    },
  );
  const terminateStarted = deferred<void>();
  const terminateQuery = deferred<unknown>();
  let terminatorClosed = false;
  const terminator = new FakeClient(
    (sql) => {
      assert.equal(sql, "SELECT pg_terminate_backend($1) AS terminated");
      terminateStarted.resolve();
      return terminateQuery.promise;
    },
    () => {
      if (!terminatorClosed) {
        terminatorClosed = true;
        terminateQuery.reject(new Error("terminator closed"));
      }
    },
  );
  const clients = [session, terminator];
  const registry = new PostgresSessionRegistry(
    () => undefined,
    () => {
      const client = clients.shift();
      assert.ok(client, "unexpected PostgreSQL client creation");
      return client as unknown as Client;
    },
    { terminateConnectMs: 20, terminateQueryMs: 20, clientEndMs: 20 },
  );

  const activeRun = registry
    .reserve("file:///slow.sql")
    .execute("local", CONNECTION, undefined, "SELECT slow");
  await queryStarted.promise;
  const activeFailure = assert.rejects(activeRun, /session closed/);
  const queuedRun = registry
    .reserve("file:///slow.sql")
    .execute("local", CONNECTION, undefined, "SELECT queued");
  const queuedFailure = assert.rejects(queuedRun, /session reset/);

  const reconnect = registry.reconnect("file:///slow.sql");
  await terminateStarted.promise;
  const closeWhileReconnecting = registry.closeDocument("file:///slow.sql");
  const outcome = await reconnect;
  await closeWhileReconnecting;
  await Promise.all([activeFailure, queuedFailure]);

  assert.equal(outcome.hadSession, true);
  assert.match(outcome.terminateWarning ?? "", /timed out terminating/);
  assert.equal(terminator.destroyed, true);
  assert.equal(session.endCalls, 1);

  const preflight = registry.reserve("file:///preflight.sql");
  const noSession = await registry.reconnect("file:///preflight.sql");
  assert.equal(noSession.hadSession, false);
  await assert.rejects(
    preflight.execute("local", CONNECTION, undefined, "SELECT late"),
    /session reset/,
  );
});

function queryResult(value: string): unknown {
  return {
    fields: [{ name: "value" }],
    rows: [[value]],
    rowCount: 1,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
