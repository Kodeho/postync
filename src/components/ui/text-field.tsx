type TextFieldProps = {
  label: string;
  name: string;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  defaultValue?: string;
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
}: TextFieldProps) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        defaultValue={defaultValue}
        className="rounded-md border border-black/15 bg-transparent px-3 py-2 outline-none focus:border-black/50 dark:border-white/20 dark:focus:border-white/60"
      />
    </label>
  );
}
