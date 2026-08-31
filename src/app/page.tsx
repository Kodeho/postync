import type { Metadata } from "next";
import Link from "next/link";

import { PublicFooter } from "@/components/layout/public-footer";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/config/product";
import { PLANS, formatPlanPrice } from "@/config/plans";

/**
 * Page d'accueil publique — `https://postync.app`.
 *
 * C'est la page que Meta, TikTok et Google ouvrent en premier lors de leurs
 * examens, avant même les documents légaux. Trois partis pris en découlent :
 *
 * 1. elle décrit ce que le produit fait RÉELLEMENT aujourd'hui. Annoncer la
 *    publication sur quatre réseaux alors que seuls deux disposent d'un
 *    `publisher` serait un mensonge vérifiable en trente secondes par un
 *    examinateur, et le meilleur moyen de faire échouer une App Review ;
 * 2. les tarifs viennent de `PLANS`, comme les CGU : une grille qui diverge
 *    d'un écran à l'autre est un litige commercial en puissance ;
 * 3. les liens d'action pointent en relatif. Le proxy les enverra vers
 *    `app.postync.app` — la page ignore sur quel domaine elle est servie.
 */

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} — ${PRODUCT_TAGLINE}`,
  description:
    "POSTYNC publie vos vidéos sur vos réseaux sociaux depuis un seul endroit : " +
    "une préparation, une programmation, plusieurs plateformes.",
};

/**
 * Réseaux, et ce qui est vraiment disponible pour chacun.
 *
 * `publication` décrit ce qui est réellement OUVERT AU PUBLIC, ce qui est
 * plus exigeant que la seule existence d'un `publisher` :
 *
 *   · Instagram et Facebook publient effectivement ;
 *   · TikTok dispose bien d'un `tiktokPublisher` complet, mais la chaîne
 *     reste fermée en amont — le média doit être servi par un domaine que
 *     TikTok a vérifié, et l'application est encore en Sandbox. Annoncer
 *     « TikTok » ici serait donc faux tant que ces deux verrous tiennent ;
 *   · YouTube n'a pas encore de `publisher`.
 *
 * Cette liste passe à `true` quand la publication marche VRAIMENT, jamais
 * quand le code est prêt. Un examinateur vérifie en trente secondes.
 *
 * `attente` précise CE QU'ON ATTEND, quand ce n'est pas la même chose d'un
 * réseau à l'autre. « À venir » couvre le cas de YouTube, dont l'intégration
 * reste à écrire. Il décrivait mal TikTok, dont la chaîne technique est
 * terminée et éprouvée de bout en bout : ce qui manque là n'est pas du code,
 * c'est l'approbation de la plateforme. Le dire exactement évite deux
 * malentendus opposés — laisser croire que rien n'existe, et laisser croire
 * que le réseau est ouvert aux clients.
 */
const RESEAUX = [
  { nom: "Instagram", publication: true },
  { nom: "Facebook", publication: true },
  { nom: "TikTok", publication: false, attente: "en cours de validation par TikTok" },
  { nom: "YouTube", publication: false },
] as const;

const CAPACITES = [
  {
    titre: "Une préparation, plusieurs réseaux",
    texte:
      "Vous déposez la vidéo, écrivez la légende et choisissez les comptes. " +
      "POSTYNC se charge du reste, réseau par réseau, avec leurs contraintes propres.",
  },
  {
    titre: "Programmation et calendrier",
    texte:
      "Planifiez à la date et à l'heure de votre choix, dans le fuseau de votre " +
      "espace de travail. Le calendrier montre ce qui est prévu, publié ou en échec.",
  },
  {
    titre: "Médiathèque",
    texte:
      "Vos vidéos et visuels restent disponibles d'une publication à l'autre, " +
      "sans réimport.",
  },
  {
    titre: "Travail à plusieurs",
    texte:
      "Invitez votre équipe sur un espace de travail, avec des rôles distincts " +
      "entre ceux qui publient et ceux qui administrent.",
  },
] as const;

export default function Home() {
  return (
    <>
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <span className="text-lg font-semibold tracking-tight text-foreground">
            {PRODUCT_NAME}
          </span>
          <nav aria-label="Accès au compte" className="flex items-center gap-4 text-sm">
            <Link href="/login" className="text-muted underline-offset-4 hover:underline">
              Se connecter
            </Link>
            <Link
              href="/signup"
              className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary-hover"
            >
              Créer un compte
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="border-b border-border px-6 py-20">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center">
            <h1 className="text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-5xl">
              Publiez vos vidéos partout, sans tout refaire à chaque fois.
            </h1>
            <p className="max-w-xl text-lg text-balance text-muted">
              {PRODUCT_NAME} prépare, programme et publie vos contenus sur vos
              réseaux sociaux depuis un seul endroit.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/signup"
                className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
              >
                Commencer gratuitement
              </Link>
              <Link
                href="/login"
                className="rounded-md border border-border-strong px-5 py-2.5 text-sm font-medium text-foreground hover:bg-surface-muted"
              >
                J&apos;ai déjà un compte
              </Link>
            </div>
            <p className="text-xs text-muted-soft">
              Offre gratuite, sans carte bancaire.
            </p>
          </div>
        </section>

        <section
          aria-labelledby="capacites-titre"
          className="border-b border-border px-6 py-16"
        >
          <div className="mx-auto flex max-w-5xl flex-col gap-8">
            <h2
              id="capacites-titre"
              className="text-center text-2xl font-semibold tracking-tight text-foreground"
            >
              Ce que fait {PRODUCT_NAME}
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2">
              {CAPACITES.map((capacite) => (
                <li
                  key={capacite.titre}
                  className="rounded-lg border border-border bg-surface p-5 shadow-soft"
                >
                  <h3 className="text-base font-semibold text-foreground">{capacite.titre}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{capacite.texte}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          aria-labelledby="reseaux-titre"
          className="border-b border-border px-6 py-16"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            <div className="text-center">
              <h2
                id="reseaux-titre"
                className="text-2xl font-semibold tracking-tight text-foreground"
              >
                Réseaux pris en charge
              </h2>
              <p className="mt-2 text-sm text-muted">
                Nous préférons dire où nous en sommes plutôt que de laisser croire.
              </p>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2">
              {RESEAUX.map((reseau) => (
                <li
                  key={reseau.nom}
                  className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3"
                >
                  <span className="text-sm font-medium text-foreground">{reseau.nom}</span>
                  <span
                    className={
                      reseau.publication
                        ? "rounded-full bg-success-soft px-2.5 py-1 text-xs font-medium text-success"
                        : "rounded-full bg-surface-muted px-2.5 py-1 text-xs font-medium text-muted"
                    }
                  >
                    {reseau.publication
                      ? "Connexion et publication"
                      : `Connexion — publication ${"attente" in reseau ? reseau.attente : "à venir"}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="tarifs-titre" className="px-6 py-16">
          <div className="mx-auto flex max-w-5xl flex-col gap-8">
            <div className="text-center">
              <h2
                id="tarifs-titre"
                className="text-2xl font-semibold tracking-tight text-foreground"
              >
                Tarifs
              </h2>
              <p className="mt-2 text-sm text-muted">
                Deux mois offerts sur l&apos;engagement annuel. Sans engagement au mois.
              </p>
            </div>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {PLANS.map((plan) => (
                <li
                  key={plan.key}
                  className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5 shadow-soft"
                >
                  <div>
                    <h3 className="text-base font-semibold text-foreground">{plan.name}</h3>
                    <p className="mt-1 text-sm text-muted">{plan.description}</p>
                  </div>
                  <p className="text-2xl font-semibold text-foreground">
                    {formatPlanPrice(plan.monthlyPriceCents)}
                    <span className="text-sm font-normal text-muted"> / mois</span>
                  </p>
                  <ul className="flex flex-col gap-1 text-sm text-muted">
                    <li>{plan.quotas.socialAccounts} comptes sociaux</li>
                    <li>{plan.quotas.publicationsPerMonth} publications / mois</li>
                    <li>
                      {plan.quotas.members} membre{plan.quotas.members > 1 ? "s" : ""}
                    </li>
                    <li>{plan.quotas.storageGb} Go de médias</li>
                  </ul>
                </li>
              ))}
            </ul>
            <p className="text-center text-xs text-muted-soft">
              Les conditions détaillées figurent dans les{" "}
              <Link href="/terms" className="underline underline-offset-4">
                conditions d&apos;utilisation
              </Link>
              .
            </p>
          </div>
        </section>
      </main>

      <PublicFooter />
    </>
  );
}
