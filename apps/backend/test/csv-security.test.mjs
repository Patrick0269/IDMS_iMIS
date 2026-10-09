import assert from "node:assert/strict";
import test from "node:test";
import { escapeCsvCell } from "../dist/utils/csv.js";

test("CSV cells neutralize formula prefixes after whitespace", () => {
  for (const formula of ["=1+1", "+1+1", "-1+1", "@SUM(A1:A2)", "\t=1+1", "  =1+1", "\r@SUM(A1)"]) {
    assert.equal(escapeCsvCell(formula), `"'${formula}"`);
  }
});

test("CSV cells preserve values while escaping delimiters, quotes and line breaks", () => {
  assert.equal(escapeCsvCell('North, "Main"\nCampus'), '"North, ""Main""\nCampus"');
  assert.equal(escapeCsvCell(null), '""');
  assert.equal(escapeCsvCell(0), '"0"');
});
