/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";

export type DiffLine = {
  type: "context" | "add" | "remove";
  oldLineNo: number | null;
  newLineNo: number | null;
  content: string;
};

type DiffOperation = {
  type: DiffLine["type"];
  content: string;
};

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function lineAt(lines: readonly string[], index: number): string {
  const line = lines[index];
  if (line === undefined) {
    throw new RangeError(`Line index out of range: ${index}`);
  }
  return line;
}

export function computeUnifiedDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length === 0 && newLines.length === 0) {
    return [];
  }

  const columns = newLines.length + 1;
  const cellCount = (oldLines.length + 1) * columns;
  const table =
    Math.min(oldLines.length, newLines.length) > 65_535
      ? new Uint32Array(cellCount)
      : new Uint16Array(cellCount);

  for (let oldIndex = 1; oldIndex <= oldLines.length; oldIndex += 1) {
    const oldLine = lineAt(oldLines, oldIndex - 1);
    const rowOffset = oldIndex * columns;
    const previousRowOffset = (oldIndex - 1) * columns;

    for (let newIndex = 1; newIndex <= newLines.length; newIndex += 1) {
      const cellIndex = rowOffset + newIndex;

      if (oldLine === newLines[newIndex - 1]) {
        table[cellIndex] = (table[previousRowOffset + newIndex - 1] ?? 0) + 1;
        continue;
      }

      const fromOld = table[previousRowOffset + newIndex] ?? 0;
      const fromNew = table[rowOffset + newIndex - 1] ?? 0;
      table[cellIndex] = fromOld >= fromNew ? fromOld : fromNew;
    }
  }

  const operations: DiffOperation[] = [];
  let oldIndex = oldLines.length;
  let newIndex = newLines.length;

  while (oldIndex > 0 || newIndex > 0) {
    if (oldIndex > 0 && newIndex > 0) {
      const oldLine = lineAt(oldLines, oldIndex - 1);
      const newLine = lineAt(newLines, newIndex - 1);

      if (oldLine === newLine) {
        operations.push({ type: "context", content: oldLine });
        oldIndex -= 1;
        newIndex -= 1;
        continue;
      }
    }

    const fromOld = oldIndex > 0 ? (table[(oldIndex - 1) * columns + newIndex] ?? 0) : -1;
    const fromNew = newIndex > 0 ? (table[oldIndex * columns + newIndex - 1] ?? 0) : -1;

    if (newIndex > 0 && (oldIndex === 0 || fromNew >= fromOld)) {
      operations.push({ type: "add", content: lineAt(newLines, newIndex - 1) });
      newIndex -= 1;
      continue;
    }

    if (oldIndex > 0) {
      operations.push({ type: "remove", content: lineAt(oldLines, oldIndex - 1) });
      oldIndex -= 1;
    }
  }

  operations.reverse();

  const diffLines: DiffLine[] = [];
  let oldLineNo = 1;
  let newLineNo = 1;

  for (const operation of operations) {
    if (operation.type === "context") {
      diffLines.push({
        type: "context",
        oldLineNo,
        newLineNo,
        content: operation.content,
      });
      oldLineNo += 1;
      newLineNo += 1;
      continue;
    }

    if (operation.type === "remove") {
      diffLines.push({
        type: "remove",
        oldLineNo,
        newLineNo: null,
        content: operation.content,
      });
      oldLineNo += 1;
      continue;
    }

    diffLines.push({
      type: "add",
      oldLineNo: null,
      newLineNo,
      content: operation.content,
    });
    newLineNo += 1;
  }

  return diffLines;
}

export type DiffViewerProps = {
  oldText: string;
  newText: string;
};

export const DiffViewer: FC<DiffViewerProps> = ({ oldText, newText }) => {
  const lines = computeUnifiedDiff(oldText, newText);

  return (
    <table class="diff-viewer w-full border border-neutral-200 rounded-lg overflow-hidden font-mono text-xs">
      <tbody>
        {lines.map((line, idx) => (
          <tr
            key={idx}
            class={`diff-row diff-${line.type} ${
              line.type === "context"
                ? "bg-surface text-neutral-500"
                : line.type === "add"
                  ? "bg-success-50 text-success-700"
                  : "bg-danger-50 text-danger-700"
            }`}
          >
            <td class="diff-lineno diff-lineno-old text-right pr-2 w-12 text-neutral-400 select-none border-r border-neutral-200">
              {line.oldLineNo ?? ""}
            </td>
            <td class="diff-lineno diff-lineno-new text-right pr-2 w-12 text-neutral-400 select-none border-r border-neutral-200">
              {line.newLineNo ?? ""}
            </td>
            <td class="diff-marker w-6 text-center select-none">
              {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
            </td>
            <td class="diff-content py-1 pr-2">
              <pre class="m-0 whitespace-pre-wrap font-mono">{line.content}</pre>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
