import "server-only";

import { registerProvider } from "./types";
import { isYouTubeConfigured, youtubeProvider } from "./youtube";

/**
 * Enregistrement des providers implémentés. Un provider n'est proposé que si
 * ses identifiants sont configurés côté serveur — sinon la plateforme reste
 * affichée « à venir » dans l'interface.
 *
 * C8.2 : YouTube. (C8.3 TikTok et C8.4 Meta suivront, chacun après
 * vérification de sa documentation officielle.)
 */
if (isYouTubeConfigured()) {
  registerProvider(youtubeProvider);
}

export { getProvider, isProviderAvailable } from "./types";
