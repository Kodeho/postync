import Link from "next/link";

import { PRODUCT_NAME } from "@/config/product";

/**
 * Pied de page des écrans publics.
 *
 * Les documents légaux doivent être accessibles depuis TOUTE page publique,
 * sans authentification : une page de politique de confidentialité qu'on ne
 * peut atteindre qu'une fois connecté ne remplit pas son office, et les
 * plateformes sociales exigent des URL publiques stables pour leur audit.
 */

export const LEGAL_LINKS = [
  { href: "/legal", label: "Mentions légales" },
  { href: "/terms", label: "Conditions d'utilisation" },
  { href: "/privacy", label: "Confidentialité" },
] as const;

export function PublicFooter() {
  return (
    <footer className="border-t border-border px-6 py-6">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 text-xs text-muted sm:flex-row sm:justify-between">
        <p>
          © {new Date().getFullYear()} {PRODUCT_NAME}
        </p>
        <nav aria-label="Informations légales">
          <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            {LEGAL_LINKS.map((lien) => (
              <li key={lien.href}>
                <Link href={lien.href} className="underline-offset-4 hover:underline">
                  {lien.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
