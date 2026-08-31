/**
 * Livraison des médias — isolation de l'hôte.
 *
 * L'enjeu tient en une phrase : basculer les médias de `*.supabase.co` vers
 * `api.postync.app` doit être UNE VARIABLE D'ENVIRONNEMENT, et rien d'autre.
 * Si cette bascule exigeait de retoucher la logique de publication, elle
 * serait faite dans l'urgence, le jour où TikTok refuse une URL — c'est-à-dire
 * au pire moment.
 *
 * Ces tests verrouillent donc les deux états, AVANT et APRÈS bascule, et les
 * cas où la réécriture ne doit surtout PAS avoir lieu.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkVerifiedDelivery,
  isHostWithinDomain,
  mediaDeliveryOrigin,
  toDeliveryUrl,
} from "@/server/media/delivery";

const PROJET = "https://abcdefghijkl.supabase.co";
const SIGNEE = `${PROJET}/storage/v1/object/sign/media/ws-1/asset.mp4?token=eyJhbGciOi.SIGNATURE`;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = PROJET;
  delete process.env.MEDIA_DELIVERY_ORIGIN;
});

afterEach(() => {
  delete process.env.MEDIA_DELIVERY_ORIGIN;
});

describe("état actuel — aucun domaine personnalisé", () => {
  it("l'URL signée ressort intacte", () => {
    // Le comportement d'aujourd'hui, inchangé : Instagram et Facebook
    // continuent de recevoir exactement ce qu'ils recevaient.
    expect(mediaDeliveryOrigin()).toBeNull();
    expect(toDeliveryUrl(SIGNEE)).toBe(SIGNEE);
  });
});

describe("après bascule — api.postync.app", () => {
  beforeEach(() => {
    process.env.MEDIA_DELIVERY_ORIGIN = "https://api.postync.app";
  });

  it("réécrit l'autorité et RIEN d'autre", () => {
    // Supabase signe le CHEMIN, pas l'hôte : le jeton reste valide sous le
    // domaine personnalisé, qui sert le même projet. Toucher au chemin ou à
    // la requête invaliderait la signature.
    expect(toDeliveryUrl(SIGNEE)).toBe(
      "https://api.postync.app/storage/v1/object/sign/media/ws-1/asset.mp4?token=eyJhbGciOi.SIGNATURE",
    );
  });

  it("une barre finale ou un chemin dans la variable ne fuit pas dans l'URL", () => {
    process.env.MEDIA_DELIVERY_ORIGIN = "https://api.postync.app/";
    expect(toDeliveryUrl(SIGNEE)).not.toContain("app//");
    process.env.MEDIA_DELIVERY_ORIGIN = "https://api.postync.app/inutile";
    expect(toDeliveryUrl(SIGNEE)).toContain("/storage/v1/object/sign/");
    expect(toDeliveryUrl(SIGNEE)).not.toContain("inutile");
  });

  it("ne détourne PAS une URL qui ne vient pas du projet Supabase", () => {
    // Chemin historique : une URL publique saisie à la main. La réécrire
    // pointerait notre domaine vers un objet qui n'y est pas.
    const externe = "https://cdn.exemple.test/video.mp4";
    expect(toDeliveryUrl(externe)).toBe(externe);
  });

  it("laisse passer ce qui n'est pas une URL, sans rien casser", () => {
    expect(toDeliveryUrl("pas-une-url")).toBe("pas-une-url");
  });

  it("refuse une origine en clair : un média en HTTP serait rejeté partout", () => {
    process.env.MEDIA_DELIVERY_ORIGIN = "http://api.postync.app";
    expect(mediaDeliveryOrigin()).toBeNull();
    expect(toDeliveryUrl(SIGNEE)).toBe(SIGNEE);
  });

  it("une variable illisible retombe sur le comportement actuel", () => {
    // Mieux vaut continuer à servir depuis Supabase qu'émettre des URL
    // fabriquées à partir d'une valeur inutilisable.
    process.env.MEDIA_DELIVERY_ORIGIN = "n'importe quoi";
    expect(toDeliveryUrl(SIGNEE)).toBe(SIGNEE);
  });
});

describe("appartenance à un domaine vérifié", () => {
  it("couvre le domaine et ses sous-domaines", () => {
    expect(isHostWithinDomain("postync.app", "postync.app")).toBe(true);
    expect(isHostWithinDomain("api.postync.app", "postync.app")).toBe(true);
    expect(isHostWithinDomain("media.cdn.postync.app", "postync.app")).toBe(true);
  });

  it("REFUSE un domaine qui se contente de finir pareil", () => {
    // L'erreur classique — une comparaison par suffixe nu — enverrait nos URL
    // signées chez un tiers qui aurait pris soin d'acheter le bon nom.
    expect(isHostWithinDomain("evilpostync.app", "postync.app")).toBe(false);
    expect(isHostWithinDomain("postync.app.attaquant.test", "postync.app")).toBe(false);
  });

  it("insensible à la casse et au point final absolu", () => {
    expect(isHostWithinDomain("API.Postync.App", "postync.app")).toBe(true);
    expect(isHostWithinDomain("api.postync.app.", "postync.app")).toBe(true);
  });

  it("ne valide rien sur des valeurs vides", () => {
    expect(isHostWithinDomain("", "postync.app")).toBe(false);
    expect(isHostWithinDomain("api.postync.app", "")).toBe(false);
  });
});

describe("contrôle avant transfert « la plateforme tire »", () => {
  it("accepte une URL signée servie par le domaine vérifié", () => {
    expect(
      checkVerifiedDelivery("https://api.postync.app/storage/x.mp4?token=s", "postync.app"),
    ).toBeNull();
  });

  it("nomme précisément chaque motif de refus", () => {
    // Un motif précis évite de chercher au mauvais endroit le jour où TikTok
    // refuse une publication.
    expect(checkVerifiedDelivery("pas-une-url", "postync.app")).toBe("malformed");
    expect(checkVerifiedDelivery("http://api.postync.app/x.mp4", "postync.app")).toBe("not_https");
    expect(checkVerifiedDelivery("https://u:p@api.postync.app/x.mp4", "postync.app")).toBe(
      "embedded_credentials",
    );
    expect(checkVerifiedDelivery(`${PROJET}/storage/x.mp4`, "postync.app")).toBe(
      "host_not_verified",
    );
  });
});
