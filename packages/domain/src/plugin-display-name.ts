const EXPERIMENTAL_SUFFIX = /\s*\[experimental\]\s*$/i;

export function splitPluginDisplayName(displayName: string): {
  name: string;
  experimental: boolean;
} {
  const name = displayName.replace(EXPERIMENTAL_SUFFIX, "");
  if (name === displayName || name.length === 0) {
    return { name: displayName, experimental: false };
  }
  return { name, experimental: true };
}
