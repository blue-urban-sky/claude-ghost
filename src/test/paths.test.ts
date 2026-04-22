import { test } from "node:test";
import * as assert from "node:assert/strict";
import { shellQuote } from "../paths";

test("shellQuote POSIX wraps in single quotes", () => {
  assert.equal(shellQuote("/tmp/foo.txt", "linux"), "'/tmp/foo.txt'");
  assert.equal(shellQuote("/tmp/foo.txt", "darwin"), "'/tmp/foo.txt'");
});

test("shellQuote POSIX escapes embedded single quote", () => {
  assert.equal(shellQuote("a'b", "linux"), "'a'\\''b'");
});

test("shellQuote PowerShell doubles single quotes", () => {
  assert.equal(shellQuote("C:\\Users\\Jo's File.txt", "win32"), "'C:\\Users\\Jo''s File.txt'");
});

test("shellQuote handles empty string", () => {
  assert.equal(shellQuote("", "linux"), "''");
  assert.equal(shellQuote("", "win32"), "''");
});
