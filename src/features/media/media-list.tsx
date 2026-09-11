"use client";

import { Badge } from "@/components/admin/badges";
import type { PlatformCompatibility } from "@/server/media/rules";

/**
 * Compatibilité d'un média avec chaque réseau, et la RAISON quand ça ne
 * passe pas. Expliquer avant vaut mieux qu'échouer après : une vidéo 16:9
 * part sur Instagram et sera refusée par Facebook.
 */
export function CompatibilityList({ report }: { report: PlatformCompatibility[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {report.map((entry) => (
        <li key={entry.platform} className="flex items-start gap-2 text-xs">
          <Badge tone={entry.compatible ? "success" : "warning"}>
            {entry.compatible ? "Compatible" : "Non compatible"}
          </Badge>
          <span className="min-w-0 flex-1">
            <span className="font-medium text-foreground">{entry.label}</span>
            {entry.reasons.length > 0 ? (
              <span className="block text-muted">{entry.reasons.join(" ")}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
