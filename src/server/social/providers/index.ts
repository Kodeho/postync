import "server-only";

import { isInstagramConfigured, instagramProvider } from "./instagram";
import { isTikTokConfigured, tiktokProvider } from "./tiktok";
import { registerProvider } from "./types";
import { isYouTubeConfigured, youtubeProvider } from "./youtube";

/**
 * Enregistrement des providers implémentés. Un provider n'est proposé que si
 * ses identifiants sont configurés côté serveur — sinon la plateforme reste
 * affichée « à venir » dans l'interface.
 *
 * C8.2 : YouTube. C8.3 : TikTok. C8.4a : Instagram, via « Instagram API with
 * Instagram Login » (arbitrage docs/META_ARCHITECTURE.md). Facebook fera
 * l'objet de sa propre sous-étape, avec son flux Pages distinct.
 */
if (isYouTubeConfigured()) {
  registerProvider(youtubeProvider);
}
if (isTikTokConfigured()) {
  registerProvider(tiktokProvider);
}
if (isInstagramConfigured()) {
  registerProvider(instagramProvider);
}

export { getProvider, isProviderAvailable } from "./types";
