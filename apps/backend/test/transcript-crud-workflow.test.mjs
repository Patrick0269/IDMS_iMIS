import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("transcript generic endpoints cannot edit lifecycle data or snapshot lines", async () => {
  const routes = await read("apps/backend/src/modules/transcripts/transcripts.routes.ts");
  const results = await read("apps/backend/src/modules/results/results.routes.ts");
  for (const source of [routes, results]) {
    const headerIndex = source.search(/entityType:\s*"student_transcripts"/);
    assert.notEqual(headerIndex, -1, "transcript header CRUD registration should exist");
    const header = source.slice(source.lastIndexOf("registerCrudResource", headerIndex), headerIndex + 1200);
    assert.match(header, /allowUpdate:\s*false/);
    assert.match(header, /allowDelete:\s*false/);
    assert.doesNotMatch(header, /transcriptStatus:\s*"transcript_status"|cgpa:\s*"cgpa"|issuedBy:\s*"issued_by"|verificationCode:\s*"verification_code"/);
    for (const entityType of ["student_transcript_semesters", "student_transcript_courses"]) {
      const index = source.indexOf(`entityType:"${entityType}"`);
      const spacedIndex = index < 0 ? source.indexOf(`entityType: "${entityType}"`) : index;
      if (spacedIndex < 0) continue;
      const registration = source.slice(source.lastIndexOf("registerCrudResource", spacedIndex), spacedIndex + 700);
      assert.match(registration, /allowCreate:\s*false/);
      assert.match(registration, /allowUpdate:\s*false/);
      assert.match(registration, /allowDelete:\s*false/);
    }
  }
  const workflows = await read("apps/backend/src/modules/workflows/workflow.routes.ts");
  for (const step of ["generate", "review", "approve", "issue", "revoke"]) assert.match(workflows, new RegExp(`/transcripts/:id/${step}`));
  assert.match(workflows, /rpc\("transition_student_transcript_atomic"/);
  assert.doesNotMatch(workflows, /updateById\(req, res, next, "student_transcripts"/);
  const lifecycle = await read("supabase/migrations/20261007260000_transcript_lifecycle_atomic.sql");
  assert.match(lifecycle, /FOR UPDATE/);
  assert.match(lifecycle, /generated_by = p_actor_id THEN RAISE EXCEPTION/);
  assert.match(lifecycle, /approved_by = p_actor_id THEN RAISE EXCEPTION/);
  assert.match(lifecycle, /INSERT INTO public.audit_logs/);
  assert.match(lifecycle, /GRANT EXECUTE ON FUNCTION public\.transition_student_transcript_atomic[\s\S]*TO service_role/);
  assert.match(routes, /listFields: \["transcript_number", "cumulative_earned_credits", "cgpa"/);
  assert.match(routes, /course_name/);
  assert.match(routes, /grade_code/);
  const workspace = await read("apps/frontend/assets/js/institutional-workspace.js");
  assert.match(workspace, /data-transcript-action/);
  assert.match(workspace, /transcript\.approve/);
  assert.match(workspace, /reason: reason/);
  assert.match(workspace, /transcripts\.manage/);
  assert.match(workspace, /code:\s*"draft"[\s\S]*?endpoint:\s*"\/transcripts"[\s\S]*?studentSearch/);
  assert.match(workspace, /bindTranscriptStudentSearch\(\)/);
  assert.match(workspace, /\/transcripts\/reference-data\/students\?search=/);
  assert.match(routes, /router\.get\("\/reference-data\/students",\s*requirePermission\(VIEW\)/);
  assert.match(routes, /search\.length\s*<\s*2/);
  assert.match(routes, /\.limit\(50\)/);
  assert.match(workspace, /data-transcript-view/);
  assert.match(workspace, /\/transcripts\/" \+ encodeURIComponent\(id\) \+ "\/snapshot/);
  assert.match(routes, /router\.get\("\/:id\/snapshot",\s*requirePermission\(VIEW\)/);
});
