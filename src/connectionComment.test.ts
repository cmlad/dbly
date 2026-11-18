import assert from "node:assert/strict";
import test from "node:test";
import {
  formatConnectionComment,
  parseConnectionName,
} from "./connectionComment";

test("parses canonical markers including names with spaces", () => {
  assert.equal(parseConnectionName("-- dbly: local app\nSELECT 1"), "local app");
});

test("trims harmless marker whitespace", () => {
  assert.equal(parseConnectionName("  --  dbly:   warehouse  \n"), "warehouse");
});

test("rejects missing, malformed, empty, and non-first-line markers", () => {
  assert.equal(parseConnectionName("SELECT 1"), undefined);
  assert.equal(parseConnectionName("-- dbly warehouse"), undefined);
  assert.equal(parseConnectionName("-- dbly:   "), undefined);
  assert.equal(parseConnectionName("SELECT 1\n-- dbly: local"), undefined);
});

test("formats the exact canonical marker", () => {
  assert.equal(formatConnectionComment("local app"), "-- dbly: local app");
});
