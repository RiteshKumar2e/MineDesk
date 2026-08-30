import type { Prisma } from '@prisma/client';

/**
 * SQLite/libSQL has no array type, so columns that used to be native Postgres
 * `String[]` (two-factor backup codes, shared folders, granted capabilities)
 * are `Json` instead. Every one of them is always written as a plain string
 * array, so reading it back needs exactly this one narrow cast, not general
 * Json validation.
 */
export function asStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}
