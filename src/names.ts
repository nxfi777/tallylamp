const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;

export function isValidName(name: string): boolean {
  return typeof name === "string" && NAME_RE.test(name);
}

export function assertValidName(name: string): void {
  if (!isValidName(name)) {
    throw new Error(
      `invalid name '${name}': 1-48 chars, lowercase letters/digits/dashes, no leading or trailing dash`,
    );
  }
}

export function slugify(input: string, fallback: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return isValidName(s) ? s : fallback;
}
