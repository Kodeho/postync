/**
 * Barre de progression — déterminée ou indéterminée.
 *
 * LA DISTINCTION EST LE SUJET, pas un détail d'affichage.
 *
 * `value` renseigné : le navigateur MESURE réellement l'avancement. C'est le
 * cas du téléversement d'un média, où `XMLHttpRequest.upload.onprogress` rend
 * des octets envoyés sur octets totaux. Le pourcentage affiché est alors vrai.
 *
 * `value` absent : rien n'est mesurable. C'est le cas de la publication, qui
 * part en UNE action serveur — le navigateur ne voit ni l'envoi vers la
 * plateforme, ni son traitement. On montre alors une progression indéterminée
 * et le NOM de l'étape en cours. Afficher un pourcentage ici reviendrait à
 * inventer une mesure, et une barre qui atteint 90 % pour y rester est pire
 * qu'une barre qui n'annonce rien.
 */
type ProgressProps = {
  /** 0 à 100. Omis = progression indéterminée. */
  value?: number;
  /** Nom accessible de la barre. Décrit CE QUI progresse. */
  label: string;
  /** Piste plus claire, pour les fonds sombres (surcouche). */
  tone?: "light" | "dark";
  className?: string;
};

export function Progress({ value, label, tone = "light", className = "" }: ProgressProps) {
  const determine = typeof value === "number" && Number.isFinite(value);
  const pourcent = determine ? Math.max(0, Math.min(100, Math.round(value))) : undefined;

  const piste = tone === "dark" ? "bg-white/20" : "bg-surface-muted";
  const barre = tone === "dark" ? "bg-white" : "bg-primary";

  return (
    <div
      role="progressbar"
      aria-label={label}
      // Les trois bornes ne sont posées QUE si la mesure existe. Un
      // `aria-valuenow` inventé ferait annoncer un pourcentage faux par un
      // lecteur d'écran ; son absence fait annoncer « en cours », ce qui est
      // exactement l'information disponible.
      aria-valuenow={pourcent}
      aria-valuemin={determine ? 0 : undefined}
      aria-valuemax={determine ? 100 : undefined}
      className={`h-1.5 w-full overflow-hidden rounded-full ${piste} ${className}`.trim()}
    >
      {determine ? (
        <div
          className={`h-full rounded-full ${barre} transition-[width] duration-200 ease-out`}
          style={{ width: `${pourcent}%` }}
        />
      ) : (
        // Un segment court qui balaie la piste : il dit « ça travaille » sans
        // prétendre dire « on en est là ».
        <div className={`postync-indeterminate h-full w-1/3 rounded-full ${barre}`} />
      )}
    </div>
  );
}
