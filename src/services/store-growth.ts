export const STORE_LEVEL_THRESHOLDS = Object.freeze([
  0, 100, 300, 600, 1000,
] as const);
export const MAX_STORE_LEVEL = STORE_LEVEL_THRESHOLDS.length;

function assertValidPoints(points: number): void {
  if (!Number.isSafeInteger(points) || points < 0)
    throw new RangeError('Store points must be a non-negative safe integer.');
}

export function levelForPoints(points: number): number {
  assertValidPoints(points);
  for (let index = STORE_LEVEL_THRESHOLDS.length - 1; index >= 0; index -= 1) {
    if (points >= STORE_LEVEL_THRESHOLDS[index]!) return index + 1;
  }
  return 1;
}

export function growthProgress(points: number) {
  const level = levelForPoints(points);
  const isMaxLevel = level === MAX_STORE_LEVEL;
  if (isMaxLevel) {
    return {
      nextLevelPoints: 0,
      levelProgressPercent: 100,
      maxLevel: MAX_STORE_LEVEL,
      isMaxLevel,
    };
  }

  const currentThreshold = STORE_LEVEL_THRESHOLDS[level - 1]!;
  const nextThreshold = STORE_LEVEL_THRESHOLDS[level]!;
  return {
    nextLevelPoints: nextThreshold - points,
    levelProgressPercent: Math.floor(
      ((points - currentThreshold) * 100) / (nextThreshold - currentThreshold),
    ),
    maxLevel: MAX_STORE_LEVEL,
    isMaxLevel,
  };
}

export function storeGrowthState(points: number) {
  return {
    level: levelForPoints(points),
    points,
    ...growthProgress(points),
  };
}
