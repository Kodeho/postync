import type { SocialPlatform } from "@/types/platform";

/**
 * Logos officiels des réseaux, en SVG local et inline.
 *
 * PROVENANCE. Les tracés sont les MARQUES OFFICIELLES de chaque plateforme
 * (glyphes distribués par leurs centres de marque : YouTube, Instagram,
 * Facebook, TikTok), reproduits tels quels — proportions inchangées, aucune
 * déformation. Ils identifient nominativement le réseau connecté ; c'est un
 * usage descriptif conforme aux règles d'usage des marques (ne pas altérer la
 * forme, ne pas suggérer un partenariat).
 *
 * LISIBILITÉ SUR TOUT FOND. Chaque logo est autoportant :
 *   · YouTube  — bouton rouge + triangle blanc explicite ;
 *   · Facebook — disque bleu + « f » blanc explicite ;
 *   · Instagram— dégradé officiel de la marque ;
 *   · TikTok   — sa variante OFFICIELLE une couleur (`currentColor`), qui suit
 *                la couleur du texte : noir sur clair, clair sur sombre. Sa
 *                version multicolore (corps noir + échos cyan/magenta)
 *                disparaîtrait sur fond sombre — la variante une couleur est
 *                la seule qui reste lisible partout.
 *
 * Le composant ne porte aucune logique : purement présentiel, utilisable en
 * Server comme en Client Component. Dimension via les classes `className`
 * (par exemple `h-6 w-6`).
 */

type SocialIconProps = {
  platform: SocialPlatform;
  /**
   * Nom accessible. À fournir UNIQUEMENT quand l'icône représente seule le
   * réseau. Quand un libellé texte adjacent le nomme déjà, l'omettre : l'icône
   * est alors décorative (`aria-hidden`) et n'est pas annoncée deux fois.
   */
  title?: string;
  className?: string;
};

export function SocialIcon({ platform, title, className }: SocialIconProps) {
  const a11y = title
    ? { role: "img" as const, "aria-label": title }
    : { "aria-hidden": true as const };
  const common = {
    viewBox: "0 0 24 24",
    width: 20,
    height: 20,
    className,
    ...a11y,
  };

  switch (platform) {
    case "youtube":
      return (
        <svg {...common}>
          <path
            fill="#FF0000"
            d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"
          />
          <path fill="#FFFFFF" d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
        </svg>
      );

    case "instagram":
      return (
        <svg {...common}>
          <defs>
            <linearGradient
              id="postync-social-instagram"
              x1="0"
              y1="1"
              x2="1"
              y2="0"
            >
              <stop offset="0" stopColor="#FEDA77" />
              <stop offset="0.25" stopColor="#F58529" />
              <stop offset="0.5" stopColor="#DD2A7B" />
              <stop offset="0.75" stopColor="#8134AF" />
              <stop offset="1" stopColor="#515BD4" />
            </linearGradient>
          </defs>
          <path
            fill="url(#postync-social-instagram)"
            d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"
          />
        </svg>
      );

    case "facebook":
      return (
        <svg {...common}>
          <path
            fill="#1877F2"
            d="M24 12c0-6.627-5.373-12-12-12S0 5.373 0 12c0 5.99 4.388 10.954 10.125 11.854V15.47H7.078V12h3.047V9.356c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874V12h3.328l-.532 3.47h-2.796v8.385C19.612 22.954 24 17.99 24 12z"
          />
          <path
            fill="#FFFFFF"
            d="M16.671 15.47 17.203 12h-3.328V9.749c0-.949.465-1.874 1.956-1.874h1.513V4.922s-1.374-.235-2.686-.235c-2.741 0-4.533 1.662-4.533 4.669V12H7.078v3.47h3.047v8.385a12.14 12.14 0 0 0 3.75 0V15.47h2.796z"
          />
        </svg>
      );

    case "tiktok":
      return (
        <svg {...common}>
          <path
            fill="currentColor"
            d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"
          />
        </svg>
      );
  }
}
