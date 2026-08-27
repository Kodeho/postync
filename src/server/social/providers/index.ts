import "server-only";

import { facebookProvider, isFacebookConfigured } from "./facebook";
import { isInstagramConfigured, instagramProvider } from "./instagram";
import { isTikTokConfigured, tiktokProvider } from "./tiktok";
import { registerProvider } from "./types";
import { isYouTubeConfigured, youtubeProvider } from "./youtube";

/**
 * Enregistrement des providers implémentés. Un provider n'est proposé que si
 * ses identifiants sont configurés côté serveur — sinon la plateforme reste
 * affichée « à venir » dans l'interface.
 *
 * C8.2 : YouTube. C8.3 : TikTok. C8.4a/b : Instagram, via « Instagram API
 * with Instagram Login » (arbitrage docs/META_ARCHITECTURE.md). C8.4c :
 * Facebook, flux Pages distinct — une autorisation y donne PLUSIEURS comptes
 * publiables, d'où la sélection d'actifs.
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
if (isFacebookConfigured()) {
  registerProvider(facebookProvider);
}

export { getProvider, isProviderAvailable } from "./types";
