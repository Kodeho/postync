import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/config/product";

/**
 * Coquille commune à tous les courriels POSTYNC.
 *
 * POURQUOI CE HTML RESSEMBLE À 2005. Les clients de messagerie ne sont pas des
 * navigateurs : Outlook rend le HTML avec le moteur de Word, Gmail retire la
 * balise `<style>` de l'en-tête sur certaines vues, et la mise en page par
 * grille ou flexbox n'y survit pas. On revient donc au seul dénominateur
 * commun qui tienne partout : des tableaux imbriqués, des styles EN LIGNE, des
 * largeurs en pixels, et aucune dépendance externe.
 *
 * RESPONSIVE SANS MÉDIA QUERY. La largeur maximale est fixée à 600 px — la
 * valeur qu'acceptent tous les clients — et le tableau extérieur occupe 100 %.
 * Sur mobile, le contenu se réduit donc de lui-même, sans règle qu'un client
 * pourrait ignorer.
 *
 * PAS D'IMAGE. La plupart des clients bloquent les images par défaut : un
 * en-tête qui repose sur un logo s'affiche alors vide. Le nom du produit est
 * du texte, il arrive toujours.
 */

const COULEUR_TEXTE = "#111827";
const COULEUR_ATTENUEE = "#6b7280";
const COULEUR_BORDURE = "#e5e7eb";
const COULEUR_PRIMAIRE = "#2563eb";
const COULEUR_FOND = "#f9fafb";

/** Police système : aucune police distante, aucun appel réseau depuis un courriel. */
const POLICE =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export type EmailBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "button"; label: string; href: string }
  /** Le lien en clair, pour qui ne peut pas cliquer sur un bouton. */
  | { kind: "fallback-link"; href: string }
  | { kind: "note"; text: string };

/**
 * Échappement HTML.
 *
 * Le nom d'un workspace ou d'une personne arrive ici depuis la base : c'est
 * une saisie utilisateur. Sans échappement, un workspace nommé
 * `<script>` produirait un message malformé — et, dans un client permissif,
 * bien pire.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBlock(block: EmailBlock): string {
  switch (block.kind) {
    case "paragraph":
      return `<p style="margin:0 0 16px;font-family:${POLICE};font-size:15px;line-height:24px;color:${COULEUR_TEXTE};">${escapeHtml(block.text)}</p>`;

    case "button":
      // Bouton en tableau : un `<a>` stylé en bloc n'est pas cliquable sur
      // toute sa surface dans Outlook.
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
  <tr>
    <td align="center" bgcolor="${COULEUR_PRIMAIRE}" style="border-radius:6px;">
      <a href="${escapeHtml(block.href)}" style="display:inline-block;padding:12px 22px;font-family:${POLICE};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(block.label)}</a>
    </td>
  </tr>
</table>`;

    case "fallback-link":
      return `<p style="margin:0 0 16px;font-family:${POLICE};font-size:13px;line-height:20px;color:${COULEUR_ATTENUEE};">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><span style="color:${COULEUR_PRIMAIRE};word-break:break-all;">${escapeHtml(block.href)}</span></p>`;

    case "note":
      return `<p style="margin:0 0 16px;font-family:${POLICE};font-size:13px;line-height:20px;color:${COULEUR_ATTENUEE};">${escapeHtml(block.text)}</p>`;
  }
}

/** Assemble un courriel complet à partir de ses blocs. */
export function renderEmail(input: { title: string; blocks: EmailBlock[] }): string {
  const corps = input.blocks.map(renderBlock).join("\n");

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${COULEUR_FOND};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COULEUR_FOND};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid ${COULEUR_BORDURE};border-radius:10px;">
        <tr>
          <td style="padding:28px 32px 8px;">
            <p style="margin:0;font-family:${POLICE};font-size:18px;font-weight:700;letter-spacing:0.02em;color:${COULEUR_TEXTE};">${PRODUCT_NAME}</p>
            <p style="margin:2px 0 0;font-family:${POLICE};font-size:12px;color:${COULEUR_ATTENUEE};">${PRODUCT_TAGLINE}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 8px;">
            <h1 style="margin:0 0 16px;font-family:${POLICE};font-size:20px;line-height:28px;font-weight:600;color:${COULEUR_TEXTE};">${escapeHtml(input.title)}</h1>
${corps}
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 28px;border-top:1px solid ${COULEUR_BORDURE};">
            <p style="margin:16px 0 0;font-family:${POLICE};font-size:12px;line-height:18px;color:${COULEUR_ATTENUEE};">Cet e-mail vous a été envoyé par ${PRODUCT_NAME}. Si vous n'êtes pas concerné, vous pouvez l'ignorer.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * Version texte, obligatoire.
 *
 * Ce n'est pas une politesse : un message envoyé en HTML seul est un signal
 * de pourriel pour la plupart des filtres, et certains clients n'affichent
 * que cette version. Elle est construite à partir des MÊMES blocs, donc les
 * deux versions ne peuvent pas diverger.
 */
export function renderText(input: { title: string; blocks: EmailBlock[] }): string {
  const lignes: string[] = [`${PRODUCT_NAME}`, "", input.title, ""];

  for (const block of input.blocks) {
    switch (block.kind) {
      case "paragraph":
      case "note":
        lignes.push(block.text, "");
        break;
      case "button":
        lignes.push(`${block.label} : ${block.href}`, "");
        break;
      case "fallback-link":
        // Le lien figure déjà en entier dans le bouton ci-dessus : le répéter
        // n'apporterait rien en texte brut.
        break;
    }
  }

  lignes.push(
    `Cet e-mail vous a été envoyé par ${PRODUCT_NAME}. Si vous n'êtes pas concerné, vous pouvez l'ignorer.`,
  );
  return lignes.join("\n");
}
