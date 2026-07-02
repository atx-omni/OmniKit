export type LineDiffPart = {
  type: 'same' | 'add' | 'remove';
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

function splitLines(value: string): string[] {
  if (!value) return [];
  return value.replace(/\r\n/g, '\n').split('\n');
}

export function lineDiff(before: string, after: string): LineDiffPart[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const dp = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      dp[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? dp[oldIndex + 1][newIndex + 1] + 1
        : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1]);
    }
  }

  const parts: LineDiffPart[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldLineNumber = 1;
  let newLineNumber = 1;

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      parts.push({
        type: 'same',
        text: oldLines[oldIndex],
        oldLineNumber,
        newLineNumber,
      });
      oldIndex += 1;
      newIndex += 1;
      oldLineNumber += 1;
      newLineNumber += 1;
    } else if (newIndex < newLines.length && (oldIndex === oldLines.length || dp[oldIndex][newIndex + 1] >= dp[oldIndex + 1][newIndex])) {
      parts.push({
        type: 'add',
        text: newLines[newIndex],
        newLineNumber,
      });
      newIndex += 1;
      newLineNumber += 1;
    } else if (oldIndex < oldLines.length) {
      parts.push({
        type: 'remove',
        text: oldLines[oldIndex],
        oldLineNumber,
      });
      oldIndex += 1;
      oldLineNumber += 1;
    }
  }

  return parts;
}

export function collapseUnchangedDiffRuns(parts: LineDiffPart[], contextLines = 3): LineDiffPart[] {
  if (parts.length === 0) return parts;
  const out: LineDiffPart[] = [];
  let index = 0;

  while (index < parts.length) {
    const part = parts[index];
    if (part.type !== 'same') {
      out.push(part);
      index += 1;
      continue;
    }

    const start = index;
    while (index < parts.length && parts[index].type === 'same') index += 1;
    const run = parts.slice(start, index);

    if (run.length <= contextLines * 2 + 1) {
      out.push(...run);
      continue;
    }

    out.push(...run.slice(0, contextLines));
    out.push({
      type: 'same',
      text: `... ${run.length - (contextLines * 2)} unchanged lines ...`,
      oldLineNumber: undefined,
      newLineNumber: undefined,
    });
    out.push(...run.slice(-contextLines));
  }

  return out;
}
