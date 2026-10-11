/** Keep generic CRUD payloads limited to explicitly selected fields. */
export function projectCrudResponse(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields
    .filter(field => Object.prototype.hasOwnProperty.call(row, field))
    .map(field => [field, row[field]]));
}
