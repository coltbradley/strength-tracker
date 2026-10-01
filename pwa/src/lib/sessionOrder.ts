import type { ExerciseEntry } from "./entries";

interface EntryBlock {
  entries: ExerciseEntry[];
  start: number;
  firstSectionRun: string | null;
  lastSectionRun: string | null;
  firstSupersetRun: { group: number; id: string } | null;
  lastSupersetRun: { group: number; id: string } | null;
}

function groupNumber(entry: ExerciseEntry): number | null {
  const value = entry.brackets[0]?.superset_group;
  return typeof value === "number" && value > 0 ? value : null;
}

function sectionName(entry: ExerciseEntry): string | null {
  return entry.brackets[0]?.section || null;
}

function hasMixedSectionRamp(entries: readonly ExerciseEntry[]): boolean {
  return entries.some((entry) =>
    new Set(entry.brackets.map((bracket) => bracket.section ?? null)).size > 1,
  );
}

function blocksFor(entries: readonly ExerciseEntry[]): EntryBlock[] {
  if (entries.length === 0) return [];
  const parents = entries.map((_, index) => index);
  const find = (index: number): number => {
    if (parents[index] !== index) parents[index] = find(parents[index]);
    return parents[index];
  };
  const join = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parents[b] = a;
  };

  for (let index = 1; index < entries.length; index++) {
    const previous = entries[index - 1];
    const current = entries[index];
    const previousSection = sectionName(previous);
    const previousGroup = groupNumber(previous);
    if (
      (previousSection !== null && previousSection === sectionName(current)) ||
      (previousGroup !== null && previousGroup === groupNumber(current))
    ) join(index - 1, index);
  }

  let sectionRun = -1;
  let previousSection: string | null = null;
  let supersetRun = -1;
  let previousGroup: number | null = null;
  const sectionIds: Array<string | null> = [];
  const supersetIds: Array<{ group: number; id: string } | null> = [];
  for (const entry of entries) {
    const section = sectionName(entry);
    if (section !== previousSection) sectionRun++;
    sectionIds.push(section === null ? null : sectionRun + ":" + section);
    previousSection = section;

    const group = groupNumber(entry);
    if (group !== previousGroup) supersetRun++;
    supersetIds.push(group === null ? null : { group, id: supersetRun + ":" + group });
    previousGroup = group;
  }

  const blocks: EntryBlock[] = [];
  for (let index = 0; index < entries.length; index++) {
    const root = find(index);
    let block = blocks[blocks.length - 1];
    if (!block || find(block.start) !== root) {
      block = {
        entries: [],
        start: index,
        firstSectionRun: sectionIds[index],
        lastSectionRun: sectionIds[index],
        firstSupersetRun: supersetIds[index],
        lastSupersetRun: supersetIds[index],
      };
      blocks.push(block);
    }
    block.entries.push(entries[index]);
    block.lastSectionRun = sectionIds[index];
    block.lastSupersetRun = supersetIds[index];
  }
  return blocks;
}

function createsNewAdjacency(left: EntryBlock, right: EntryBlock): boolean {
  const leftGroup = left.lastSupersetRun;
  const rightGroup = right.firstSupersetRun;
  if (leftGroup && rightGroup && leftGroup.group === rightGroup.group && leftGroup.id !== rightGroup.id)
    return true;
  const leftSection = left.lastSectionRun;
  const rightSection = right.firstSectionRun;
  if (leftSection && rightSection && leftSection !== rightSection) {
    const leftName = leftSection.slice(leftSection.indexOf(":") + 1);
    const rightName = rightSection.slice(rightSection.indexOf(":") + 1);
    if (leftName === rightName) return true;
  }
  return false;
}

function safeOrder(blocks: EntryBlock[]): boolean {
  for (let index = 1; index < blocks.length; index++) {
    if (createsNewAdjacency(blocks[index - 1], blocks[index])) return false;
  }
  return true;
}

/** Restore a saved key sequence at whole navigation-block boundaries. Invalid
 * and duplicate keys are ignored; entries omitted by an older cache keep
 * their canonical order after the saved entries. */
export function reconcileEntryOrder(
  entries: readonly ExerciseEntry[],
  savedKeys: readonly string[],
): ExerciseEntry[] {
  if (hasMixedSectionRamp(entries)) return [...entries];
  const blocks = blocksFor(entries);
  const ranks = new Map<string, number>();
  for (const key of savedKeys) {
    if (typeof key === "string" && !ranks.has(key)) ranks.set(key, ranks.size);
  }
  const rank = (block: EntryBlock) => Math.min(
    ...block.entries.map((entry) => ranks.get(entry.key) ?? Number.POSITIVE_INFINITY),
  );
  const ordered = [...blocks].sort((left, right) =>
    rank(left) - rank(right) || left.start - right.start,
  );
  return (safeOrder(ordered) ? ordered : blocks).flatMap((block) => block.entries);
}

/** Return the legal insertion index for an arrow move, or null at a boundary
 * or when the move would join two originally separate named/superset runs. */
export function sessionEntryMoveIndex(
  entries: readonly ExerciseEntry[],
  key: string,
  direction: "up" | "down",
  currentKeys: readonly string[] = entries.map((entry) => entry.key),
): number | null {
  if (hasMixedSectionRamp(entries)) return null;
  const current = reconcileEntryOrder(entries, currentKeys);
  const blocks = blocksFor(current);
  const sourceIndex = blocks.findIndex((block) => block.entries.some((entry) => entry.key === key));
  if (sourceIndex < 0) return null;
  const destination = sourceIndex + (direction === "up" ? -1 : 1);
  if (destination < 0 || destination >= blocks.length) return null;
  const source = blocks[sourceIndex];
  const target = blocks[destination];
  const nextBlocks = [...blocks];
  nextBlocks.splice(sourceIndex, 1);
  nextBlocks.splice(destination, 0, source);
  if (!safeOrder(nextBlocks)) return null;

  if (direction === "up") return target.start;
  return target.start - source.entries.length + target.entries.length;
}

/** Move the block containing key to an insertion index in the resulting list.
 * The index is snapped to a block boundary, so a stale caller cannot split a
 * ramp, section run, or adjacent superset/circuit. currentKeys keeps block
 * identities anchored to the canonical entries sequence. */
export function moveSessionEntry(
  entries: readonly ExerciseEntry[],
  key: string,
  toIndex: number,
  currentKeys: readonly string[] = entries.map((entry) => entry.key),
): ExerciseEntry[] {
  const current = reconcileEntryOrder(entries, currentKeys);
  const blocks = blocksFor(current);
  const sourceIndex = blocks.findIndex((block) => block.entries.some((entry) => entry.key === key));
  if (sourceIndex < 0) return [...current];
  const source = blocks[sourceIndex];
  const remaining = [...blocks];
  remaining.splice(sourceIndex, 1);
  const remainingCount = remaining.reduce((sum, block) => sum + block.entries.length, 0);
  const requested = Math.min(remainingCount, Math.max(0, Math.trunc(toIndex)));
  let insertionBlock = 0;
  let insertionIndex = 0;
  while (insertionBlock < remaining.length) {
    const nextBoundary = insertionIndex + remaining[insertionBlock].entries.length;
    if (requested < nextBoundary) {
      if (requested - insertionIndex > nextBoundary - requested) insertionBlock++;
      break;
    }
    insertionIndex = nextBoundary;
    insertionBlock++;
  }
  const candidate = [...remaining];
  candidate.splice(insertionBlock, 0, source);
  if (!safeOrder(candidate)) return [...current];
  return candidate.flatMap((block) => block.entries);
}
