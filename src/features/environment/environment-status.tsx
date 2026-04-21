import { Card, CardContent } from "@/components/ui/card";
import { BadgeCheck, CircleDashed } from "lucide-react";

const statusItems = [
  { label: "Python", value: "Not detected", icon: CircleDashed },
  { label: "YOLO CLI", value: "Pending", icon: CircleDashed },
  { label: "Backend", value: "Tauri v2", icon: BadgeCheck },
];

export function EnvironmentStatus() {
  return (
    <div className="grid min-w-[280px] grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
      {statusItems.map((item) => {
        const Icon = item.icon;
        return (
          <Card key={item.label} className="border-zinc-900/10 bg-white/75 py-3 shadow-sm">
            <CardContent className="flex items-center gap-3 px-3">
              <span className="flex size-9 items-center justify-center rounded-md bg-zinc-950 text-white">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-xs text-zinc-500">{item.label}</span>
                <span className="block text-sm font-medium text-zinc-950">{item.value}</span>
              </span>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
