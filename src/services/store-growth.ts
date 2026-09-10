const levelThresholds: Readonly<Record<number, number>> = {
  1: 0,
  2: 100,
  3: 300,
  4: 600,
  5: 1000,
};

export function levelForPoints(points: number): number {
  let level = 1;
  for (const [candidate, threshold] of Object.entries(levelThresholds)) {
    if (points >= threshold) level = Number(candidate);
  }
  return level;
}

export function growthProgress(level: number, points: number) {
  const currentThreshold = levelThresholds[level] ?? 0;
  const nextThreshold = levelThresholds[level + 1];
  if (nextThreshold === undefined)
    return { nextLevelPoints: 0, levelProgressPercent: 100 };
  return {
    nextLevelPoints: Math.max(0, nextThreshold - points),
    levelProgressPercent: Math.min(
      100,
      Math.round(
        (Math.max(0, points - currentThreshold) /
          Math.max(1, nextThreshold - currentThreshold)) *
          100,
      ),
    ),
  };
}
