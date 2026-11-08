import { zipSync, Zippable } from "fflate";

import { DigimonPackage } from "./exporter";

export function zipPackages(packages: DigimonPackage[]): Uint8Array {
  const entries: Zippable = {};

  packages.forEach((pkg) => {
    Object.entries(pkg.files).forEach(([path, bytes]) => {
      entries[`${pkg.folder}/${path}`] = bytes;
    });
  });

  // PNG and glb are already compressed; level 1 keeps the zip step quick
  return zipSync(entries, { level: 1 });
}

export function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
