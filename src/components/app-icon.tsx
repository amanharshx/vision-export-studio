import appIconUrl from "../../src-tauri/icons/icon_source_1024.png";

import { cn } from "@/lib/utils";

interface AppIconProps {
  className?: string;
  alt?: string;
}

export function AppIcon({ className, alt = "Vision Export Studio icon" }: AppIconProps) {
  return <img src={appIconUrl} alt={alt} className={cn("block", className)} />;
}
