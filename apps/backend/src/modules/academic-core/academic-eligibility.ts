type Row = Record<string, any>;
export function periodMappings(rows: Row[], semesterNumber: number): Row[] {
  if (!Number.isInteger(semesterNumber) || semesterNumber < 1) throw new Error("A valid registration semester is required.");
  const selected = rows.filter(row => Number(row.semester_number) === semesterNumber);
  const credits = new Map<string, number | null>();
  const categories = new Map<string, string>();
  for (const row of selected) {
    const value = row.credit_units == null ? null : Number(row.credit_units);
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error("Invalid curriculum credits. Contact Academic Management.");
    if (credits.has(row.course_id) && credits.get(row.course_id) !== value) throw new Error("Conflicting credits in active curricula. Academic Management must resolve the target curriculum.");
    const policy = JSON.stringify([row.course_category ?? null, row.is_compulsory ?? null]);
    if (categories.has(row.course_id) && categories.get(row.course_id) !== policy) throw new Error("Conflicting course category/compulsory policy in active curricula. Academic Management must resolve the target curriculum.");
    categories.set(row.course_id, policy);
    credits.set(row.course_id, value);
  }
  return selected;
}
export function offeringAllowed(offering: Row, programmeId: string, versionId: string | null, sharedIds: Set<string>): boolean {
  if (sharedIds.has(offering.course_id)) return true;
  return offering.programme_id === programmeId && (!offering.programme_version_id || offering.programme_version_id === versionId);
}
