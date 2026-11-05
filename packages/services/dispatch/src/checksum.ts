import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function checksumVerifies(
  body: Record<string, unknown>,
): boolean {
  if (typeof body.checksum !== "string") return false;

  const { checksum: _omitted, ...rest } = body;

  const expected = createHash("sha256")
    .update(canonicalJson(rest))
    .digest("hex")
    .slice(0, 8);

  return body.checksum === expected;
}