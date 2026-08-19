import { avatarToneClass, initials } from "@/features/workspaces/display";

type AvatarProps = {
  /** Nom affiché ou e-mail : sert aux initiales et au texte alternatif. */
  label: string;
  /** Graine de couleur (id stable), pour une teinte constante. */
  seed: string;
  /** URL d'image ; repli sur les initiales si absente. */
  src?: string | null;
  size?: "sm" | "md" | "lg";
  /** Carré arrondi (workspace) ou rond (utilisateur). */
  shape?: "square" | "circle";
};

const SIZES = {
  sm: "h-7 w-7 text-[11px]",
  md: "h-9 w-9 text-sm",
  lg: "h-11 w-11 text-base",
};

export function Avatar({
  label,
  seed,
  src,
  size = "md",
  shape = "circle",
}: AvatarProps) {
  const radius = shape === "circle" ? "rounded-full" : "rounded-md";
  const cls = `inline-flex shrink-0 items-center justify-center overflow-hidden font-semibold ${SIZES[size]} ${radius}`;

  if (src) {
    // eslint-disable-next-line @next/next/no-img-element -- URL externe libre, pas d'optimisation Next.
    return <img src={src} alt="" className={`${cls} object-cover`} />;
  }

  return (
    <span aria-hidden="true" className={`${cls} ${avatarToneClass(seed)}`}>
      {initials(label)}
    </span>
  );
}
