import { Card, CardContent } from "@/components/ui/card";
import { UploadCloud } from "lucide-react";

interface DropZoneProps {
  path: string;
  onFileSelect: (path: string) => void;
  errorMsg?: string | null;
}

export function DropZone({ path, onFileSelect, errorMsg }: DropZoneProps) {
  return (
    <Card className="border-dashed border-zinc-900/25 bg-white/75 shadow-sm">
      <CardContent className="flex min-h-[236px] flex-col items-center justify-center gap-5 px-6 py-9 text-center">
        <span className="flex size-16 items-center justify-center rounded-md bg-zinc-950 text-white shadow-sm">
          <UploadCloud className="size-7" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-2xl font-semibold text-zinc-950">Drop .pt model</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-600">
            Ultralytics YOLO weights stay local. Export commands run in selected Python environment.
          </p>
        </div>
        <div className="w-full max-w-md space-y-1">
          <input
            type="text"
            placeholder="/path/to/best.pt"
            value={path}
            onChange={(e) => onFileSelect(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 placeholder-zinc-400 shadow-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
          />
          {errorMsg && (
            <p className="text-xs text-red-600">{errorMsg}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
