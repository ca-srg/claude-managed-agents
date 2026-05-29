/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { t } from "@/features/dashboard/i18n";

export type StatusBadgeProps = {
  status: "success" | "failure" | "in-progress" | "pending" | "info";
  id?: string;
  label?: string;
};

const statusMap = {
  success: "completed",
  failure: "failed",
  "in-progress": "running",
  pending: "queued",
  info: "running",
} as const;

export const StatusBadge: FC<StatusBadgeProps> = (props) => {
  const { status, label } = props;
  const displayLabel = t(label ?? status);
  const pulseClass = status === "in-progress" ? " animate-pulse" : "";
  const mappedStatus = statusMap[status];

  return (
    <span
      id={props.id}
      class={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-status-${mappedStatus}-bg text-status-${mappedStatus}-fg border-status-${mappedStatus}-border${pulseClass}`}
    >
      {displayLabel}
    </span>
  );
};
