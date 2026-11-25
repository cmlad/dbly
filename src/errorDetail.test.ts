import assert from "node:assert/strict";
import test from "node:test";
import { describeError } from "./errorDetail";

test("shows nested connection errors and their socket fields", () => {
  const refused = (address: string) =>
    Object.assign(new Error(`connect ECONNREFUSED ${address}:5433`), {
      code: "ECONNREFUSED",
      address,
      port: 5433,
    });
  const detail = describeError(
    new AggregateError([refused("::1"), refused("127.0.0.1")]),
  );

  assert.match(detail, /^AggregateError/);
  assert.match(detail, /Error: connect ECONNREFUSED ::1:5433/);
  assert.match(detail, /Error: connect ECONNREFUSED 127\.0\.0\.1:5433/);
  assert.match(detail, /code: ECONNREFUSED/);
  assert.match(detail, /address: 127\.0\.0\.1/);
});

test("never includes credentials or HTTP auth headers", () => {
  const detail = describeError(
    Object.assign(new Error("Access Denied"), {
      code: 403,
      password: "hunter2",
      config: { headers: { Authorization: "Bearer ya29.secret" } },
      errors: [{ reason: "accessDenied", message: "Access Denied" }],
      extra: { nested: { access_token: "ya29.secret" } },
    }),
  );

  assert.doesNotMatch(detail, /hunter2|ya29/);
  assert.match(detail, /code: 403/);
  assert.match(detail, /reason: accessDenied/);
});
