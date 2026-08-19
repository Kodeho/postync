type FormAlertProps = {
  tone: "error" | "notice";
  children: React.ReactNode;
};

const TONE_CLASSES: Record<FormAlertProps["tone"], string> = {
  error: "border-danger/30 bg-danger-soft text-danger",
  notice: "border-success/30 bg-success-soft text-success",
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
