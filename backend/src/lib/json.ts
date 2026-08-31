/**
 * SQLite/libSQL has no array or Json column type (confirmed against Prisma
 * 5.22 - `prisma generate` refuses to validate a schema with a Json field on
 * the sqlite provider), so columns that used to be native Postgres
 * `String[]`/`Json` (two-factor backup codes, shared folders, granted
 * capabilities, audit log metadata) are plain `String` columns holding JSON
 * text instead. These three helpers are the one place that serialization
 * happens, so every read/write site stays a one-line call rather than
 * hand-rolled `JSON.parse`/`JSON.stringify` scattered through the routes.
 */

export function toJsonText(value: unknown): string {
  return JSON.stringify(value);
}

export function asStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
