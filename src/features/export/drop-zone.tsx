import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Card, CardContent } from "@/components/ui/card";
import { UploadCloud } from "lucide-react";
import { openModelFilePicker } from "@/lib/tauri/dialog";

interface DropZoneProps {
  path: string;
  onFileSelect: (path: string) => void;
  errorMsg?: string | null;
}

// Derive display name from a full path — show only the basename.
function basename(fullPath: string): string {
  return fullPath.split(/[\\/]/).pop() ?? fullPath;
}

export function DropZone({ path, onFileSelect, errorMsg }: DropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  // Register Tauri window drag-drop listener.
  // NOTE: onFileSelect should be wrapped in useCallback at the call site to
  // avoid re-registering the listener on every render.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (
          event.payload.type === "enter" ||
          event.payload.type === "over"
        ) {
          setIsDragOver(true);
        } else if (event.payload.type === "drop") {
          setIsDragOver(false);
          const paths = event.payload.paths;
          if (paths.length > 0) {
            // Vision Export Studio is single-source: only the first dropped file is used.
            onFileSelect(paths[0]);
          }
        } else {
          // "leave" or any future variant
          setIsDragOver(false);
        }
      })
      .then((fn) => {
        if (cancelled) fn(); // already unmounted — unlisten immediately
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onFileSelect]);

  async function handleBrowse() {
    const selected = await openModelFilePicker();
    if (selected !== null) {
      onFileSelect(selected);
    }
  }

  const hasFile = path.trim().length > 0;

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={handleBrowse}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleBrowse(); }}
      className={[
        "ring-0 border-2 border-dashed shadow-sm transition-colors cursor-pointer",
        isDragOver
          ? "border-primary bg-primary/5"
          : "border-zinc-300 bg-white/75 hover:border-primary hover:bg-primary/[0.02]",
      ].join(" ")}
    >
      <CardContent className="flex min-h-[236px] flex-col items-center justify-center gap-5 px-6 py-9 text-center">
        <span
          className={[
            "flex size-16 items-center justify-center rounded-md shadow-sm transition-colors",
            isDragOver ? "bg-primary" : "bg-zinc-950",
            "text-white",
          ].join(" ")}
        >
          <UploadCloud className="size-7" aria-hidden="true" />
        </span>

        <div>
          {hasFile ? (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Selected model
              </p>
              <h2
                className="mt-1 max-w-sm truncate text-xl font-semibold text-zinc-950"
                title={path}
              >
                {basename(path)}
              </h2>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-semibold text-zinc-950">
                {isDragOver ? "Release to select" : "Drop .pt model"}
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-600">
                Ultralytics YOLO weights stay local. Export commands run in
                selected Python environment.
              </p>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleBrowse(); }}
          className="rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-primary/40 active:bg-zinc-700"
        >
          {hasFile ? "Change file" : "Browse file"}
        </button>

        {errorMsg && <p className="text-xs text-red-600">{errorMsg}</p>}
      </CardContent>
    </Card>
  );
}
