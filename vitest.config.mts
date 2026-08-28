import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` lève une erreur hors React Server Components : neutralisé
      // pour les tests Node (la protection reste active dans l'application).
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    /**
     * Fichiers joués les uns après les autres.
     *
     * La plupart des suites d'intégration ouvrent de vraies sessions Supabase.
     * En parallèle, les connexions simultanées atteignent la limite de débit
     * de GoTrue (« Request rate limit reached ») et les suites échouent au
     * démarrage — un échec d'environnement, impossible à distinguer d'une
     * vraie régression dans le rapport. Séquentiel, c'est plus lent, mais le
     * verdict est fiable.
     */
    fileParallelism: false,
  },
});
