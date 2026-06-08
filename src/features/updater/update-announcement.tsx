import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UpdaterController } from "./use-updater-controller";

export function UpdateAnnouncement({
  open,
  updater,
  onOpenChange,
}: {
  open: boolean;
  updater: UpdaterController;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Update available</DialogTitle>
          <DialogDescription>
            Version {updater.version} is available. Download will begin now and a restart
            will be required after install.
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-end">
          <Button onClick={() => void updater.beginInstall()}>
            Update now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
