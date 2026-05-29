/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { t } from "@/features/dashboard/i18n";

export type PackageListInputProps = {
  name: string;
  values: string[];
  placeholder?: string;
  alwaysIncludes?: string[];
  ariaLabel?: string;
};

export const PackageListInput: FC<PackageListInputProps> = ({
  name,
  values,
  placeholder,
  alwaysIncludes = [],
  ariaLabel,
}) => {
  const inputId = `package-list-${name}`;

  return (
    <div class="package-list-input space-y-2" data-pkg-list-container>
      {alwaysIncludes.length > 0 && (
        <div class="package-list-always flex flex-wrap items-center gap-2">
          <span class="text-xs font-medium text-neutral-500">{t("Always included")}</span>
          {alwaysIncludes.map((pkg) => (
            <span
              key={pkg}
              class="inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 font-mono text-xs font-medium text-neutral-600"
              data-pkg-list-always-chip
            >
              {pkg}
            </span>
          ))}
        </div>
      )}

      <textarea
        id={inputId}
        name={name}
        class="package-list-textarea block w-full rounded-md border border-neutral-300 bg-surface px-3 py-2 font-mono text-sm text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        data-pkg-list-input
        rows={Math.max(3, Math.min(8, values.length + 1))}
        placeholder={placeholder}
        aria-label={ariaLabel ?? `${name} ${t("package specs")}`}
        spellCheck={false}
      >
        {values.join("\n")}
      </textarea>
      <p class="text-xs text-neutral-500">
        {t("One package per line. Enhanced mode turns entries into removable chips.")}
      </p>
    </div>
  );
};
