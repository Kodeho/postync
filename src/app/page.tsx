import Link from "next/link";

import { PublicFooter } from "@/components/layout/public-footer";
import { PRODUCT_NAME } from "@/config/product";

export default function Home() {
  return (
    <>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          {PRODUCT_NAME}
        </h1>
        <p className="text-lg text-balance sm:text-xl">
          Create once.
          <br />
          Publish everywhere.
        </p>
        <p className="text-sm opacity-70">Project bootstrap complete.</p>

        <div className="flex items-center gap-4 text-sm">
          <Link href="/login" className="underline underline-offset-4">
            Se connecter
          </Link>
          <Link href="/signup" className="underline underline-offset-4">
            Créer un compte
          </Link>
        </div>
      </main>
      <PublicFooter />
    </>
  );
}
