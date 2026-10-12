import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const read = relative => fs.readFile(path.join(root, "apps/frontend", relative), "utf8");

test("Admissions workspace separates long work areas into accessible tabs", async () => {
  const [html, script, styles] = await Promise.all([
    read("admissions.html"),
    read("assets/js/admissions-workspace.js"),
    read("assets/css/admissions-enhancements.css"),
  ]);
  for (const page of ["pending", "applications", "offers", "registration", "photos"]) {
    assert.match(html, new RegExp(`data-admission-tab="${page}"`));
    assert.match(html, new RegExp(`data-admission-page="${page}"`));
  }
  assert.match(script, /activateWorkspace\(location\.hash\.slice\(1\), false\)/);
  assert.match(script, /setAttribute\("aria-selected"/);
  assert.match(styles, /\.admission-workspace-page\[hidden\]\{display:none!important\}/);
  assert.match(styles, /\.historical-queue/);
});

test("Admissions sidebar reserves content space and collapses into navigation on narrow screens", async () => {
  const [html, css, enhancements] = await Promise.all([
    read("admissions.html"),
    read("assets/css/admissions-reference.css"),
    read("assets/css/admissions-enhancements.css"),
  ]);
  assert.match(html, /admissions-reference\.css\?v=20261012-sidebar-layout-fix/);
  assert.match(css, /\.staff-view \.portal-shell\.wide\{width:auto;max-width:none;margin:0 0 0 274px/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.staff-view \.portal-shell\.wide\{width:auto;margin:0/);
  assert.doesNotMatch(enhancements, /\.admissions-sidebar\{display:none!important\}/);
});

test("dashboard combines Applications and Admissions and Applicant Portal does not link to Student Portal", async () => {
  const [dashboard, html, script] = await Promise.all([
    read("assets/js/dashboard.js"),
    read("applicant-portal.html"),
    read("assets/js/applicant-wizard.js"),
  ]);
  assert.match(dashboard, /title: "Admissions & Applications"/);
  assert.match(dashboard, /permissionsAny: \["admissions\.view", "applications\.view"\]/);
  assert.doesNotMatch(dashboard, /page: "applications\.html"/);
  assert.doesNotMatch(html + script, /Open Student Portal/);
});
