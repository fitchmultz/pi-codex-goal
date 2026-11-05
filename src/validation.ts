/** Object-shaped input at JSON and extension-event boundaries, including legacy arrays. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
