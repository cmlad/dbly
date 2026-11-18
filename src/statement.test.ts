import assert from "node:assert/strict";
import test from "node:test";
import { findStatementAtLine } from "./statement";

test("returns a complete multi-line paragraph from each line", () => {
  const sql = "SELECT 1\nFROM example\nWHERE active";
  for (const line of [0, 1, 2]) {
    assert.equal(findStatementAtLine(sql, line), sql);
  }
});

test("whitespace-only lines split paragraphs and are not statements", () => {
  const sql = "SELECT 1\n  \t\nSELECT 2";
  assert.equal(findStatementAtLine(sql, 0), "SELECT 1");
  assert.equal(findStatementAtLine(sql, 1), undefined);
  assert.equal(findStatementAtLine(sql, 2), "SELECT 2");
});

test("handles first and last paragraphs with CRLF boundaries", () => {
  const sql = "SELECT 1\r\n\r\nSELECT 2\r\nFROM example";
  assert.equal(findStatementAtLine(sql, 0), "SELECT 1");
  assert.equal(findStatementAtLine(sql, 2), "SELECT 2\nFROM example");
  assert.equal(findStatementAtLine(sql, 3), "SELECT 2\nFROM example");
});
