import "server-only";

import { isTikTokConfigured, tiktokProvider } from "./tiktok";
import { registerProvider } from "./types";
import { isYouTubeConfigured, youtubeProvider } from "./youtube";

/**
 * Enregistrement des providers implémentés. Un provider n'est proposé que si
 * ses identifiants sont configurés côté serveur — sinon la plateforme reste
 * affichée « à venir » dans l'interface.
 *
 * C8.2 : YouTube. C8.3 : TikTok. (C8.4 Meta suivra, après vérification de sa
 * documentation officielle et validation de l'architecture retenue.)
 */
if (isYouTubeConfigured()) {
  registerProvider(youtubeProvider);
}
if (isTikTokConfigured()) {
  registerProvider(tiktokProvider);
}

export { getProvider, isProviderAvailable } from "./types";
