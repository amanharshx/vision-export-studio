import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FolderOpen, UploadCloud } from "lucide-react";

export function DropZone() {
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
        <Button className="gap-2 bg-teal-700 text-white hover:bg-teal-800">
          <FolderOpen className="size-4" aria-hidden="true" />
          Choose file
        </Button>
      </CardContent>
    </Card>
  );
}
