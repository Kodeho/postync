import Link from "next/link";

import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/config/product";

type AuthShellProps = {
  title: string;
  children: React.ReactNode;
};

/** Cadre commun aux pages publiques d'authentification. */
export function AuthShell({ title, children }: AuthShellProps) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="text-2xl font-semibold tracking-tight hover:opacity-80"
          >
            {PRODUCT_NAME}
          </Link>
          <p className="mt-1 text-sm opacity-70">{PRODUCT_TAGLINE}</p>
        </div>

        <h1 className="mb-6 text-lg font-medium">{title}</h1>

        {children}
      </div>
    </main>
  );
}
