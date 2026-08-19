import type { ComponentPropsWithoutRef } from "react";

type PanelProps = ComponentPropsWithoutRef<"div"> & {
  as?: "div" | "section" | "article";
};

/** Surface de base : fond blanc, bordure fine, relief subtil. */
export function Panel({
  as: Tag = "div",
  className = "",
  children,
  ...rest
}: PanelProps) {
  return (
    <Tag
      className={`rounded-lg border border-border bg-surface shadow-soft ${className}`}
      {...rest}
    >
      {children}
    </Tag>
  );
}
