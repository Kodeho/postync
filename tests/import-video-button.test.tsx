/**
 * « Importer une vidéo » — un raccourci, pas un second système d'upload.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUE CES TESTS PROTÈGENT VRAIMENT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Le risque de cette fonctionnalité n'est pas visuel. Il est qu'un jour,
 * pressé, quelqu'un recopie trois lignes d'envoi dans le bouton « pour aller
 * plus vite ». À partir de cet instant, deux parcours coexistent : on corrige
 * le transport dans l'un, on oublie l'autre, et personne ne s'en aperçoit
 * avant qu'un utilisateur ne perde un fichier de 200 Mo.
 *
 * Les assertions structurelles ci-dessous verrouillent donc l'ARCHITECTURE :
 * les deux points d'entrée passent par le même hook, et aucun des deux ne
 * parle directement au transport ni aux actions serveur.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POURQUOI PAS UN RENDU DU COMPOSANT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `ImportVideoButton` consomme `useRouter` et importe les Server Actions de la
 * médiathèque, elles-mêmes marquées `server-only`. Le rendre ici exigerait de
 * simuler la moitié du cadre Next, et l'on testerait alors ces simulacres
 * plutôt que le composant. Ce qui EST rendu ci-dessous est la surcouche, qui
 * ne dépend que de ses propriétés — et c'est elle qui porte les promesses
 * d'honnêteté.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SurcoucheTeleversement } from "@/features/media/upload-overlay";
import type {
  CommandesTeleversement,
  EtatTeleversement,
} from "@/features/media/use-televersement";
import { MAX_BYTE_SIZE, VIDEO_MIME_TYPES, isAllowedMimeType } from "@/server/media/rules";

const BOUTON = readFileSync("src/features/media/import-video-button.tsx", "utf8");
const FORMULAIRE = readFileSync("src/features/media/upload-form.tsx", "utf8");
const PAGE_VUE = readFileSync("src/app/app/[workspaceSlug]/page.tsx", "utf8");

describe("un seul parcours d'upload", () => {
  it("les DEUX points d'entrée passent par le hook partagé", () => {
    expect(BOUTON).toContain("useTeleversementMedia");
    expect(FORMULAIRE).toContain("useTeleversementMedia");
  });

  it("aucun des deux ne parle directement au transport", () => {
    // `televerser` et `messageDeRefus` n'appartiennent qu'au hook. Les voir
    // ici signalerait un parcours parallèle en train de naître.
    for (const source of [BOUTON, FORMULAIRE]) {
      expect(source).not.toContain("televerser(");
      expect(source).not.toContain("messageDeRefus");
    }
  });

  it("aucun des deux n'appelle les Server Actions de la médiathèque", () => {
    for (const source of [BOUTON, FORMULAIRE]) {
      expect(source).not.toContain("requestUploadAction");
      expect(source).not.toContain("finalizeUploadAction");
    }
  });

  it("les deux affichent la MÊME surcouche", () => {
    expect(BOUTON).toContain("SurcoucheTeleversement");
    expect(FORMULAIRE).toContain("SurcoucheTeleversement");
  });
});

describe("le bouton de la vue d'ensemble", () => {
  it("porte exactement le libellé demandé", () => {
    expect(BOUTON).toContain("Importer une vidéo");
  });

  it("est un bouton PRIMAIRE — donc noir sur blanc, selon la charte", () => {
    expect(BOUTON).toContain('variant="primary"');
  });

  it("porte une icône d'import, masquée aux lecteurs d'écran", () => {
    // L'icône double le libellé : l'annoncer ajouterait du bruit sans information.
    expect(BOUTON).toContain("Upload");
    expect(BOUTON).toContain('aria-hidden="true"');
  });

  it("est branché dans la zone d'actions de la vue d'ensemble", () => {
    expect(PAGE_VUE).toContain("ImportVideoButton");
    // Dans `actions`, donc dans l'en-tête, et non perdu en bas de page.
    const actions = PAGE_VUE.slice(PAGE_VUE.indexOf("actions={"));
    expect(actions.slice(0, 600)).toContain("ImportVideoButton");
  });

  it("ouvre un sélecteur restreint à la VIDÉO, comme son libellé le promet", () => {
    expect(BOUTON).toContain("VIDEO_MIME_TYPES");
    expect(VIDEO_MIME_TYPES).toEqual(["video/mp4", "video/quicktime"]);
    // Le sous-ensemble reste cohérent avec la liste de référence.
    for (const type of VIDEO_MIME_TYPES) expect(isAllowedMimeType(type)).toBe(true);
  });

  it("le champ de fichier est hors tabulation et muet pour les lecteurs d'écran", () => {
    // C'est le bouton qui porte le nom et l'action ; annoncer les deux
    // produirait une commande fantôme juste après la vraie.
    expect(BOUTON).toContain("tabIndex={-1}");
    expect(BOUTON).toContain('className="sr-only"');
  });

  it("ne publie rien : aucun appel de diffusion n'est atteignable depuis ce bouton", () => {
    // La promesse tenue à l'utilisateur : la vidéo rejoint la médiathèque, et
    // aucun réseau n'est contacté.
    expect(BOUTON).not.toContain("publish");
    expect(BOUTON).not.toContain("broadcast");
    expect(BOUTON).not.toContain("Publication");
  });

  it("annonce la limite réelle, sans la coder en dur une seconde fois", () => {
    expect(BOUTON).toContain("MAX_BYTE_SIZE");
    expect(BOUTON).not.toContain("300 Mo");
    expect(MAX_BYTE_SIZE).toBe(314_572_800);
  });
});

// ---------------------------------------------------------------------------
// La surcouche partagée
// ---------------------------------------------------------------------------

function etat(
  partiel: Partial<EtatTeleversement & CommandesTeleversement> = {},
): EtatTeleversement & CommandesTeleversement {
  return {
    phase: "uploading",
    progress: 42,
    octets: { envoyes: 42, total: 100 },
    message: null,
    error: null,
    filename: "vacances.mp4",
    occupe: true,
    reprenable: true,
    dernierFichier: null,
    surcouche: true,
    progressionAffichable: 42,
    etape: "Téléversement du fichier — 42 o sur 100 o",
    choisir: () => {},
    reprendre: () => {},
    fermerSurcouche: () => {},
    reinitialiser: () => {},
    ...partiel,
  };
}

describe("SurcoucheTeleversement", () => {
  it("fermée, elle ne rend rien", () => {
    expect(renderToStaticMarkup(<SurcoucheTeleversement etat={etat({ surcouche: false })} />)).toBe(
      "",
    );
  });

  it("elle nomme le fichier et l'étape réelle", () => {
    const html = renderToStaticMarkup(<SurcoucheTeleversement etat={etat()} />);
    expect(html).toContain("vacances.mp4");
    expect(html).toContain("Téléversement du fichier");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });

  it("le pourcentage n'apparaît QUE lorsqu'il est mesuré", () => {
    const mesure = renderToStaticMarkup(<SurcoucheTeleversement etat={etat()} />);
    expect(mesure).toContain('aria-valuenow="42"');

    // Phase serveur : aucune mesure possible, donc barre indéterminée.
    const inconnu = renderToStaticMarkup(
      <SurcoucheTeleversement
        etat={etat({ phase: "finalizing", progressionAffichable: undefined })}
      />,
    );
    expect(inconnu).not.toContain("aria-valuenow");
  });

  it("« Reprendre l'envoi » n'est proposé que si l'envoi reprend vraiment", () => {
    const gros = renderToStaticMarkup(
      <SurcoucheTeleversement etat={etat({ phase: "error", error: "Coupure.", reprenable: true })} />,
    );
    expect(gros).toContain("Reprendre l&#x27;envoi");

    // Petit fichier : il repartira de zéro. Promettre une reprise serait faux.
    const petit = renderToStaticMarkup(
      <SurcoucheTeleversement
        etat={etat({ phase: "error", error: "Coupure.", reprenable: false })}
      />,
    );
    expect(petit).toContain("Réessayer");
    expect(petit).not.toContain("Reprendre");
  });

  it("un échec est annoncé comme une alerte, et la surcouche reste ouverte", () => {
    const html = renderToStaticMarkup(
      <SurcoucheTeleversement etat={etat({ phase: "error", error: "Le stockage a refusé." })} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Le stockage a refusé.");
  });
});
