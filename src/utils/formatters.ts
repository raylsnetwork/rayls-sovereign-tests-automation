/**
 * Takes a ContractFactory instance and returns the base contract name
 * (e.g. "MyToken" for "MyToken__factory").
 */
export function formatFactoryName(factory: string | { name: string }): string {
  const name =
    typeof factory === 'string'
      ? factory
      : factory.name;

  return name.endsWith("__factory") ? name.replace(/__factory$/, "") : name;
}

/**
 * Truncates a long hex string (address, resourceId, txHash, etc.) for compact log display.
 * Default: 8 hex chars after the `0x` + 4 trailing chars (e.g. `0x12345678…abcd`).
 * Non-hex strings pass through unchanged. Strings shorter than the requested window also pass through.
 */
export function shortHex(s: string, prefix = 8, suffix = 4): string {
  if (typeof s !== 'string' || !s.startsWith('0x')) return s;
  if (s.length <= 2 + prefix + suffix + 1) return s; // already short enough — no point truncating
  return `${s.slice(0, 2 + prefix)}…${s.slice(-suffix)}`;
}