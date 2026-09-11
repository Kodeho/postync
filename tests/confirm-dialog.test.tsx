/**
 * Boîte de confirmation d'une action irréversible.
 *
 * Ce qui est vérifié ici n'est pas l'apparence : ce sont les garde-fous contre
 * la destruction accidentelle, et ils ne doivent pas pouvoir disparaître au
 * détour d'une retouche.
 *
 * Rendu en HTML statique (`renderToStaticMarkup`), comme les autres suites de
 * composants du dépôt. Conséquence à connaître : les effets ne s'exécutent pas,
 * donc l'ENTRÉE du focus sur « Annuler », le piégeage du focus et la touche
 * Échap ne sont pas couverts ici — les simuler demanderait `jsdom` et
 * `@testing-library`, deux dépendances que ce projet n'utilise pas et que je
 * n'ajoute pas de ma propre initiative. Ces trois points relèvent de la
 * vérification en navigateur.
 *
 * Ce qui EST couvert, et qui compte autant : la structure rendue à chaque
 * état, l'absence de formulaire, et le verrouillage des boutons pendant
 * l'opération.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";

function rendre(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  return renderToStaticMarkup(
    <ConfirmDialog
      open
      title="Supprimer cette vidéo ?"
      subject="vacances-2026.mp4"
      confirmLabel="Supprimer définitivement"
      pendingLabel="Suppression…"
      pending={false}
      onConfirm={() => {}}
      onCancel={() => {}}
      {...props}
    >
      <p>Le fichier sera définitivement supprimé du stockage.</p>
    </ConfirmDialog>,
  );
}

describe("ConfirmDialog — la confirmation", () => {
  it("fermée, elle ne rend rien", () => {
    expect(rendre({ open: false })).toBe("");
  });

  it("ouverte, c'est un alertdialog étiqueté et décrit", () => {
    const html = rendre();
    // `alertdialog` et non `dialog` : la conséquence doit être annoncée, pas
    // seulement le titre.
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="confirm-titre"');
    expect(html).toContain('aria-describedby="confirm-description"');
  });

  it("elle nomme le média concerné et décrit la portée réelle", () => {
    const html = rendre();
    expect(html).toContain("vacances-2026.mp4");
    expect(html).toContain("Le fichier sera définitivement supprimé du stockage.");
  });

  it("elle propose exactement deux actions, Annuler en premier", () => {
    const html = rendre();
    expect(html).toContain("Annuler");
    expect(html).toContain("Supprimer définitivement");
    // L'ordre du DOM compte : « Annuler » précède l'action destructrice, donc
    // la tabulation l'atteint d'abord.
    expect(html.indexOf("Annuler")).toBeLessThan(html.indexOf("Supprimer définitivement"));
  });
});

describe("ConfirmDialog — pas de validation accidentelle", () => {
  it("aucun formulaire : la touche Entrée ne peut rien soumettre", () => {
    const html = rendre();
    expect(html).not.toContain("<form");
  });

  it("les deux boutons sont de type button, jamais submit", () => {
    const html = rendre();
    expect(html).not.toContain('type="submit"');
    // Deux boutons, tous deux explicitement `type="button"`.
    expect(html.match(/type="button"/g) ?? []).toHaveLength(2);
  });
});

describe("ConfirmDialog — pendant l'opération", () => {
  it("les DEUX boutons sont verrouillés : un second clic est impossible", () => {
    const html = rendre({ pending: true });
    // C'est le garde-fou anti-double-clic au niveau du DOM. Le composant
    // appelant en porte un second, de réentrance, dans sa fonction.
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(2);
  });

  it("le bouton destructeur annonce l'attente et porte aria-busy", () => {
    const html = rendre({ pending: true });
    expect(html).toContain("Suppression…");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("postync-spin");
  });
});

describe("ConfirmDialog — échec", () => {
  it("la boîte RESTE ouverte, l'erreur est une alerte", () => {
    // Message volontairement sans apostrophe : `renderToStaticMarkup` échappe
    // `'` en `&#x27;`, et assertir sur l'entité testerait l'échappement de
    // React plutôt que le composant.
    const html = rendre({ error: "Le stockage est indisponible." });
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Le stockage est indisponible.");
  });

  it("l'action destructrice devient « Réessayer »", () => {
    const html = rendre({ error: "Échec." });
    expect(html).toContain("Réessayer");
    expect(html).not.toContain("Supprimer définitivement");
    // Et « Annuler » reste disponible : on ne piège personne dans la boîte.
    expect(html).toContain("Annuler");
  });
});

describe("ConfirmDialog — succès", () => {
  it("le succès est annoncé, et plus rien ne peut être détruit", () => {
    const html = rendre({ success: "Média supprimé." });
    expect(html).toContain('role="status"');
    expect(html).toContain("Média supprimé.");
    // Le bouton destructeur a disparu : il n'y a plus rien à supprimer, et le
    // laisser inviterait à un second appel sur un média déjà parti.
    expect(html).not.toContain("Supprimer définitivement");
    expect(html).not.toContain("Réessayer");
    expect(html).toContain("Fermer");
  });

  it("un seul bouton subsiste", () => {
    const html = rendre({ success: "Média supprimé." });
    expect(html.match(/type="button"/g) ?? []).toHaveLength(1);
  });
});
