/**
 * Surcouche bloquante — les règles d'HONNÊTETÉ, verrouillées.
 *
 * Ce qui est vérifié ici n'est pas de l'apparence, c'est une promesse : la
 * surcouche ne doit jamais annoncer une progression qu'elle ne mesure pas, ni
 * proposer une annulation qui n'existe pas. Ces deux tentations reviennent à
 * chaque retouche d'interface — d'où des tests plutôt qu'un commentaire.
 *
 * Rendu en HTML statique (`renderToStaticMarkup`), comme les autres suites de
 * composants du dépôt : on inspecte les attributs réellement émis. Les effets
 * (piège de focus, avertissement de fermeture) ne s'exécutent pas dans ce mode
 * et relèvent de la vérification en navigateur.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BusyOverlay } from "@/components/ui/busy-overlay";
import { Progress } from "@/components/ui/progress";

describe("BusyOverlay — ce qui est affiché", () => {
  it("fermée, elle ne rend rien du tout", () => {
    const html = renderToStaticMarkup(
      <BusyOverlay open={false} title="Envoi" stepLabel="Téléversement" />,
    );
    expect(html).toBe("");
  });

  it("ouverte, elle est un dialogue modal étiqueté", () => {
    const html = renderToStaticMarkup(
      <BusyOverlay open title="Envoi de votre vidéo" stepLabel="Téléversement du fichier" />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="busy-overlay-titre"');
    expect(html).toContain("Envoi de votre vidéo");
  });

  it("l'étape vit dans une région vivante polie", () => {
    const html = renderToStaticMarkup(
      <BusyOverlay open title="Envoi" stepLabel="Vérification par le serveur…" />,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Vérification par le serveur…");
  });

  it("elle demande de garder la page ouverte", () => {
    const html = renderToStaticMarkup(<BusyOverlay open title="Envoi" stepLabel="…" />);
    expect(html).toContain("Gardez cette page ouverte");
  });
});

describe("BusyOverlay — jamais de progression inventée", () => {
  it("sans mesure : aucun pourcentage affiché, aucun aria-valuenow", () => {
    const html = renderToStaticMarkup(
      <BusyOverlay open title="Publication" stepLabel="Envoi vers vos réseaux…" />,
    );
    expect(html).toContain('role="progressbar"');
    // Le coeur du sujet : rien ne doit prétendre mesurer.
    expect(html).not.toContain("aria-valuenow");
    expect(html).not.toContain("aria-valuemax");
    // Le pourcentage visible vit dans un `<span class="… tabular-nums …">`.
    // On cible CET élément : chercher `\d+%` dans tout le HTML attraperait le
    // `%2F` des URL encodées de `next/image` et passerait pour un échec.
    expect(html).not.toContain("tabular-nums");
    // …mais la barre indique bien une activité.
    expect(html).toContain("postync-indeterminate");
  });

  it("avec mesure : le pourcentage est affiché ET porté par l'aria", () => {
    const html = renderToStaticMarkup(
      <BusyOverlay open title="Envoi" stepLabel="Téléversement" progress={42} />,
    );
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain("42%");
    expect(html).not.toContain("postync-indeterminate");
  });

  it("la mesure est bornée à 0–100 plutôt que rendue telle quelle", () => {
    expect(renderToStaticMarkup(<Progress value={150} label="x" />)).toContain(
      'aria-valuenow="100"',
    );
    expect(renderToStaticMarkup(<Progress value={-20} label="x" />)).toContain(
      'aria-valuenow="0"',
    );
  });

  it("une valeur non finie est traitée comme une absence de mesure", () => {
    const html = renderToStaticMarkup(<Progress value={Number.NaN} label="x" />);
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain("postync-indeterminate");
  });
});

describe("BusyOverlay — annulation et échec", () => {
  it("sans annulation possible, aucun bouton d'annulation n'est proposé", () => {
    const html = renderToStaticMarkup(
      <BusyOverlay open title="Publication" stepLabel="Envoi vers vos réseaux…" />,
    );
    expect(html).not.toContain("Annuler");
  });

  it("avec annulation réelle, le bouton apparaît", () => {
    const html = renderToStaticMarkup(
      <BusyOverlay
        open
        title="Envoi"
        stepLabel="Téléversement"
        onCancel={() => {}}
        cancelLabel="Annuler l'envoi"
      />,
    );
    expect(html).toContain("Annuler l&#x27;envoi");
  });

  it("en échec : le message est une alerte, et la progression disparaît", () => {
    const html = renderToStaticMarkup(
      <BusyOverlay
        open
        title="Envoi"
        stepLabel="Téléversement"
        progress={80}
        error="Le transfert du fichier a échoué."
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Le transfert du fichier a échoué.");
    expect(html).toContain("Réessayer");
    expect(html).toContain("Fermer");
    // Une barre qui continuerait d'avancer après un échec serait un mensonge.
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("80%");
  });

  it("sans rejeu possible, « Réessayer » n'est pas proposé", () => {
    const html = renderToStaticMarkup(
      <BusyOverlay open title="Envoi" stepLabel="…" error="Échec." onDismiss={() => {}} />,
    );
    expect(html).toContain("Fermer");
    expect(html).not.toContain("Réessayer");
  });
});
