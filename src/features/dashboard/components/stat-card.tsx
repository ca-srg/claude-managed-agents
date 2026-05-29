/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";

export type StatCardProps = {
  label: string;
  value: string | number;
  hint?: string;
  variant?: "default" | "success" | "warning" | "danger";
};

export const StatCard: FC<StatCardProps> = (props) => {
  const { label, value, hint, variant = "default" } = props;

  const variantClasses = {
    default: "bg-surface border-neutral-200 text-neutral-900",
    success: "bg-success-50 border-success-200 text-success-900",
    warning: "bg-warning-50 border-warning-200 text-warning-900",
    danger: "bg-danger-50 border-danger-200 text-danger-900",
  };

  return (
    <div class={`p-4 rounded-lg border ${variantClasses[variant]}`}>
      <div class="text-sm font-medium text-neutral-500 mb-1">{label}</div>
      <div class="text-2xl font-semibold font-mono">{value}</div>
      {hint && <div class="text-xs text-neutral-400 mt-1">{hint}</div>}
    </div>
  );
};
