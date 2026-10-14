import { splitPluginDisplayName } from "@bb/domain/plugin-display-name";

export function PluginExperimentalBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded border border-attention/50 bg-surface-attention px-1.5 py-0.5 align-middle text-2xs font-medium leading-none text-foreground">
      Experimental
    </span>
  );
}

export function PluginDisplayName({
  displayName,
  nameClassName,
}: {
  displayName: string;
  nameClassName?: string;
}) {
  const { name, experimental } = splitPluginDisplayName(displayName);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={nameClassName}>{name}</span>
      {experimental ? <PluginExperimentalBadge /> : null}
    </span>
  );
}
