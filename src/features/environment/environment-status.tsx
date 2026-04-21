import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  BadgeCheck,
  CircleDashed,
  CircleX,
  TriangleAlert,
} from "lucide-react";
import type { EnvironmentInfo, EnvironmentStatus } from "@/lib/types";
import { detectEnvironment } from "@/lib/tauri/environment";

function statusIcon(status: EnvironmentStatus) {
  switch (status) {
    case "ok":
      return BadgeCheck;
    case "partial":
      return TriangleAlert;
    case "missing":
    case "error":
      return CircleX;
    case "loading":
    default:
      return CircleDashed;
  }
}

interface StatusItem {
  label: string;
  value: string;
  status: EnvironmentStatus;
}

function buildItems(
  env: EnvironmentInfo | null,
  loadError: string | null,
): StatusItem[] {
  if (loadError !== null) {
    const truncated =
      loadError.length > 40 ? loadError.slice(0, 40) + "…" : loadError;
    return [
      { label: "Python", value: truncated, status: "error" },
      { label: "YOLO CLI", value: truncated, status: "error" },
      { label: "Backend", value: "Tauri v2", status: "ok" },
    ];
  }

  if (env === null) {
    return [
      { label: "Python", value: "Detecting…", status: "loading" },
      { label: "YOLO CLI", value: "Detecting…", status: "loading" },
      { label: "Backend", value: "Detecting…", status: "loading" },
    ];
  }

  const pythonStatus: EnvironmentStatus = env.python_version
    ? "ok"
    : "missing";
  const yoloStatus: EnvironmentStatus = env.yolo_path
    ? "ok"
    : env.python_version
      ? "partial"
      : "missing";

  return [
    {
      label: "Python",
      value: env.python_version || "Not found",
      status: pythonStatus,
    },
    {
      label: "YOLO CLI",
      value: env.yolo_path || "Not found",
      status: yoloStatus,
    },
    { label: "Backend", value: "Tauri v2", status: "ok" },
  ];
}

export function EnvironmentStatus() {
  const [envInfo, setEnvInfo] = useState<EnvironmentInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    detectEnvironment()
      .then(setEnvInfo)
      .catch((e: unknown) => setLoadError(String(e)));
  }, []);

  const items = buildItems(envInfo, loadError);

  return (
    <div className="grid min-w-[280px] grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
      {items.map((item) => {
        const Icon = statusIcon(item.status);
        return (
          <Card
            key={item.label}
            className="border-zinc-900/10 bg-white/75 py-3 shadow-sm"
          >
            <CardContent className="flex items-center gap-3 px-3">
              <span className="flex size-9 items-center justify-center rounded-md bg-zinc-950 text-white">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-xs text-zinc-500">{item.label}</span>
                <span className="block text-sm font-medium text-zinc-950">
                  {item.value}
                </span>
              </span>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
