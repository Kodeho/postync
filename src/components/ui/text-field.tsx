type TextFieldProps = {
  label: string;
  name: string;
  type?: "text" | "email" | "password" | "url";
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  defaultValue?: string;
  placeholder?: string;
  /** Aide affichée sous le champ. */
  hint?: string;
};

export function TextField({
  label,
  name,
  type = "text",
  autoComplete,
  required = true,
  minLength,
  maxLength,
  defaultValue,
  placeholder,
  hint,
}: TextFieldProps) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="rounded-md border border-border bg-surface px-3 py-2 text-foreground shadow-soft transition-colors placeholder:text-muted-soft hover:border-border-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
      />
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}
