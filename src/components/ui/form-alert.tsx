type FormAlertProps = {
  tone: "error" | "notice";
  children: React.ReactNode;
};

const TONE_CLASSES: Record<FormAlertProps["tone"], string> = {
  error: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  notice:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

export function FormAlert({ tone, children }: FormAlertProps) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border px-3 py-2 text-sm ${TONE_CLASSES[tone]}`}
    >
      {children}
    </p>
  );
}
