import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formats } from "@/lib/routes";
import type { ExportOptions, ExportStatus, RouteSpec } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Play, Square } from "lucide-react";
import { DependencyPanel } from "./dependency-panel";
import { ExportLog } from "./export-log";
import { OptionsPanel } from "./options-panel";
import { categoryTone, routeBadges } from "./route-card";

interface RouteDetailsProps {
  route: RouteSpec;
  sourcePath: string;
  exportStatus: ExportStatus;
  logLines: string[];
  options: ExportOptions;
  onOptionsChange: (options: ExportOptions) => void;
  onExport: () => void;
  onCancel: () => void;
}

export function RouteDetails({
  route,
  sourcePath,
  exportStatus,
  logLines,
  options,
  onOptionsChange,
  onExport,
  onCancel,
}: RouteDetailsProps) {
  const format = formats[route.targetFormat];

  const exportDisabled = exportStatus === "running" || !sourcePath;
  const cancelDisabled = exportStatus !== "running";

  return (
    <aside className="space-y-5">
      <Card className="border-zinc-900/10 bg-white/85 shadow-sm">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg text-zinc-950">{route.title}</CardTitle>
              <p className="mt-2 text-sm leading-6 text-zinc-600">{route.displayPath}</p>
            </div>
            <Badge variant="outline" className={cn("rounded-md", categoryTone(format.category))}>
              {format.category}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {routeBadges(route).map((badge) => (
              <Badge key={badge} variant="outline" className="rounded-md border-zinc-200 bg-zinc-50 text-zinc-700">
                {badge}
              </Badge>
            ))}
          </div>
          <p className="text-sm leading-6 text-zinc-700">{route.notes}</p>
        </CardContent>
      </Card>

      <Card className="border-zinc-900/10 bg-white/85 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-zinc-950">Options</CardTitle>
        </CardHeader>
        <CardContent>
          <OptionsPanel route={route} options={options} onOptionsChange={onOptionsChange} />
        </CardContent>
      </Card>

      <Card className="border-zinc-900/10 bg-white/85 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-zinc-950">Dependencies</CardTitle>
        </CardHeader>
        <CardContent>
          <DependencyPanel route={route} />
        </CardContent>
      </Card>

      <div className="rounded-md border border-zinc-900/10 bg-zinc-950 p-5 shadow-sm">
        <ExportLog lines={logLines} status={exportStatus} route={route} />
        <Separator className="my-4 bg-zinc-800" />
        <div className="flex gap-2">
          <Button
            className="gap-2 bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50"
            disabled={exportDisabled}
            onClick={onExport}
          >
            <Play className="size-4" aria-hidden="true" />
            Export
          </Button>
          <Button
            variant="outline"
            className="gap-2 border-zinc-700 bg-transparent text-zinc-200 hover:bg-zinc-900 hover:text-white disabled:opacity-50"
            disabled={cancelDisabled}
            onClick={onCancel}
          >
            <Square className="size-4" aria-hidden="true" />
            Cancel
          </Button>
        </div>
      </div>
    </aside>
  );
}
