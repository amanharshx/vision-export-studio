import { AppIcon } from "@/components/app-icon";
import { Button } from "@/components/ui/button";
import { UpdateChecker } from "@/components/update-checker";
import type { UpdaterController } from "@/features/updater/use-updater-controller";
import { ultralyticsRoutes } from "@/lib/routes";
import { ArrowRight, Layers, Lock, Zap } from "lucide-react";

interface LandingScreenProps {
  onGetStarted: () => void;
  settingsReady: boolean;
  updatesEnabled: boolean;
  updater: UpdaterController;
}

export function LandingScreen({
  onGetStarted,
  settingsReady,
  updatesEnabled,
  updater,
}: LandingScreenProps) {
  return (
    <div className="relative flex min-h-screen">
      {updatesEnabled ? (
        <div className="absolute right-4 top-4">
          <UpdateChecker updater={updater} />
        </div>
      ) : null}
      {/* Left — Branding */}
      <div className="flex flex-1 flex-col items-center justify-center bg-primary/5 px-12 py-8">
        <div className="flex w-full max-w-lg flex-col items-center">
          <AppIcon className="mb-8 h-24 w-24 drop-shadow-md" />
          <h1 className="mb-6 text-center text-4xl font-bold tracking-tight text-foreground">
            Vision Export Studio
          </h1>
          <p className="mb-10 max-w-sm text-center text-base leading-7 text-muted-foreground">
            Local export for Ultralytics YOLO and Roboflow RF-DETR. Fast,
            private, and runs entirely on your machine.
          </p>

          <div className="w-full max-w-sm space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <Zap className="h-4 w-4 text-primary" />
              </div>
              <span className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">Fast</span>{" "}
                local export — no cloud, no upload
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <Layers className="h-4 w-4 text-primary" />
              </div>
              <span className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{ultralyticsRoutes.length}</span>{" "}
                export targets across runtimes and vendors
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <Lock className="h-4 w-4 text-primary" />
              </div>
              <span className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">100%</span>{" "}
                private — weights never leave your machine
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Right — Targets + CTA */}
      <div className="flex flex-1 flex-col justify-center px-12 py-8">
        <div className="max-w-md space-y-6">
          <div>
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              EXPORT TARGETS
            </h3>
            <div className="flex flex-wrap gap-2">
              {ultralyticsRoutes.map((route) => (
                <span
                  key={route.id}
                  className="rounded-full bg-black/[0.04] px-3 py-1 text-xs font-medium text-secondary-foreground"
                >
                  {route.title}
                </span>
              ))}
            </div>
          </div>

          <Button
            onClick={onGetStarted}
            disabled={!settingsReady}
            size="lg"
            className="w-full py-6 text-lg"
          >
            Get Started
            <ArrowRight className="ml-2 h-5 w-5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
