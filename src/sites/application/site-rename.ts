/** Existing website rename semantics: trim, then retain at most 60 UTF-16 code units. */
export function normalizeSiteRename(value: unknown): string {
  if (typeof value !== "string") throw Object.assign(new Error("A site name is required"), { code: "INVALID_REQUEST" });
  const name = value.trim().slice(0, 60);
  if (!name) throw Object.assign(new Error("A site name is required"), { code: "INVALID_REQUEST" });
  return name;
}
