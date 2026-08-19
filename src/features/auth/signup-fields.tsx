import { TextField } from "@/components/ui/text-field";

import type { SignupPreservedValues } from "./state";
import { DISPLAY_NAME_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./validation";

type SignupFieldsProps = {
  /** Valeurs non sensibles renvoyées par le serveur après une erreur. */
  values?: SignupPreservedValues;
};

/**
 * Champs du formulaire d'inscription.
 *
 * Composant pur (sans hook) afin de pouvoir vérifier son rendu en test.
 *
 * Après une erreur, React réinitialise le formulaire : chaque champ reprend
 * son `defaultValue`. Le nom et l'e-mail reçoivent donc la valeur renvoyée
 * par le serveur, tandis que les champs mot de passe, qui n'ont aucun
 * `defaultValue`, sont systématiquement vidés.
 */
export function SignupFields({ values }: SignupFieldsProps) {
  return (
    <>
      <TextField
        label="Nom"
        name="displayName"
        autoComplete="name"
        maxLength={DISPLAY_NAME_MAX_LENGTH}
        defaultValue={values?.displayName}
      />
      <TextField
        label="Adresse e-mail"
        name="email"
        type="email"
        autoComplete="email"
        defaultValue={values?.email}
      />
      <TextField
        label="Mot de passe"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
      />
      <TextField
        label="Confirmation du mot de passe"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
      />
    </>
  );
}
