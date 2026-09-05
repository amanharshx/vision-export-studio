// Shared install-list helper (leaf module).
//
// Lives here instead of export-workspace so route-setup modules can use it
// without importing the workspace (which imports them back): backend-reported
// `install_package` remedies win, `missing_binary` rows fall back to their
// pip spec, and duplicates collapse.

import type { DepCheckResult, InstallableDependency } from "@/lib/types";
import { installSpecFromHint } from "./ultralytics-route-setup";

export function getInstallableMissingPackages(
  results: DepCheckResult[] | null,
): InstallableDependency[] {
  if (!results) return [];

  const packages = results.flatMap((result): InstallableDependency[] => {
    if (result.install_package) {
      return [{ package: result.install_package, prerelease: result.prerelease === true }];
    }
    if (result.status === "missing_binary") {
      const spec = installSpecFromHint(result.install_hint);
      return spec ? [{ package: spec, prerelease: false }] : [];
    }
    return [];
  });
  return packages.filter((dependency, index) =>
    packages.findIndex((candidate) => candidate.package === dependency.package) === index,
  );
}
