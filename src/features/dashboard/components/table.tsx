/** @jsxImportSource hono/jsx */
import type { FC, PropsWithChildren } from "hono/jsx";

export type SortDirection = "asc" | "desc";

export type TableProps = PropsWithChildren<{
  columns: string[];
  caption?: string;
  sortedColumn?: string;
  sortDirection?: SortDirection;
}>;

export const Table: FC<TableProps> = (props) => {
  const { columns, children, caption, sortedColumn, sortDirection } = props;

  return (
    <div class="w-full overflow-x-auto border border-neutral-200 rounded-lg bg-surface shadow-sm">
      {caption && (
        <div class="px-4 py-3 border-b border-neutral-200 text-sm font-medium text-neutral-700 bg-surface-muted">
          {caption}
        </div>
      )}
      <table class="w-full text-left border-collapse whitespace-nowrap">
        <thead>
          <tr class="bg-surface-muted border-b border-neutral-200">
            {columns.map((col) => {
              const isSorted = col === sortedColumn;
              return (
                <th
                  key={col}
                  class="px-4 py-3 text-xs font-medium text-neutral-500 uppercase tracking-wider"
                >
                  <div class="flex items-center gap-1">
                    {col}
                    {isSorted && (
                      <span class="text-brand-600">{sortDirection === "desc" ? "↓" : "↑"}</span>
                    )}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody class="divide-y divide-neutral-200">{children}</tbody>
      </table>
    </div>
  );
};
