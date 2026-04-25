import type { ExportOptions, RouteSpec } from "@/lib/types";

export interface OptionsPanelProps {
  route: RouteSpec;
  options: ExportOptions;
  onOptionsChange: (options: ExportOptions) => void;
}

export function useOptionSetter(
  options: ExportOptions,
  onOptionsChange: (options: ExportOptions) => void,
) {
  return <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) => {
    onOptionsChange({ ...options, [key]: value });
  };
}

export function OptionRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <p className="font-medium text-zinc-900">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function InputRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div>
        <p className="font-medium text-zinc-900">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      {children}
    </div>
  );
}
