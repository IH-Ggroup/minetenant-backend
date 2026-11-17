import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  growthProgress,
  levelForPoints,
  MAX_STORE_LEVEL,
  STORE_LEVEL_THRESHOLDS,
} from '../src/services/store-growth.js';
import {
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
} from './helpers.js';

const boundaries = [
  [0, 1, 100, 0, false],
  [1, 1, 99, 1, false],
  [99, 1, 1, 99, false],
  [100, 2, 200, 0, false],
  [101, 2, 199, 0, false],
  [299, 2, 1, 99, false],
  [300, 3, 300, 0, false],
  [301, 3, 299, 0, false],
  [599, 3, 1, 99, false],
  [600, 4, 400, 0, false],
  [601, 4, 399, 0, false],
  [999, 4, 1, 99, false],
  [1000, 5, 0, 100, true],
  [1001, 5, 0, 100, true],
  [Number.MAX_SAFE_INTEGER, 5, 0, 100, true],
] as const;

describe('store growth calculation', () => {
  it('exposes the contracted thresholds and maximum level', () => {
    expect(STORE_LEVEL_THRESHOLDS).toEqual([0, 100, 300, 600, 1000]);
    expect(MAX_STORE_LEVEL).toBe(5);
  });

  it.each(boundaries)(
    'calculates points=%s from the contracted interval',
    (points, level, nextLevelPoints, levelProgressPercent, isMaxLevel) => {
      expect(levelForPoints(points)).toBe(level);
      expect(growthProgress(points)).toEqual({
        nextLevelPoints,
        levelProgressPercent,
        maxLevel: 5,
        isMaxLevel,
      });
    },
  );

  it.each([
    -1,
    -0.1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid points %s instead of rounding them', (points) => {
    expect(() => levelForPoints(points)).toThrow(RangeError);
    expect(() => growthProgress(points)).toThrow(RangeError);
  });

  it('always returns the same result for the same points', () => {
    expect(growthProgress(420)).toEqual(growthProgress(420));
    expect(levelForPoints(420)).toBe(levelForPoints(420));
  });

  it('keeps remaining points non-negative and progress within 0 to 100', () => {
    for (let points = 0; points <= 2000; points += 1) {
      const progress = growthProgress(points);
      expect(progress.nextLevelPoints).toBeGreaterThanOrEqual(0);
      expect(progress.levelProgressPercent).toBeGreaterThanOrEqual(0);
      expect(progress.levelProgressPercent).toBeLessThanOrEqual(100);
      if (!progress.isMaxLevel)
        expect(progress.levelProgressPercent).toBeLessThan(100);
    }
  });
});

describe('store API growth display', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });

  beforeEach(async () => {
    await test.reset();
  });

  afterAll(async () => {
    await test?.close();
  });

  it('uses points as the source without repairing a mismatched stored level', async () => {
    await test.db.execute(
      "UPDATE stores SET points = 420, level = 1 WHERE store_id = 'store-mine'",
    );
    const publicClient = createClient(test.app);
    const seller = createClient(test.app);
    await expectStatus(await seller.login('seller'), 200);

    const storeResponse = await publicClient.request(
      '/api/v1/stores/store-mine',
    );
    await expectStatus(storeResponse, 200);
    expect((await storeResponse.json()).data).toMatchObject({
      level: 3,
      points: 420,
    });

    const dashboardResponse = await seller.request(
      '/api/v1/stores/store-mine/dashboard',
    );
    await expectStatus(dashboardResponse, 200);
    const dashboard = await dashboardResponse.json();
    expect(dashboard.data.store).toMatchObject({ level: 3, points: 420 });
    expect(dashboard.data.stats).toMatchObject({
      nextLevelPoints: 180,
      levelProgressPercent: 40,
      maxLevel: 5,
      isMaxLevel: false,
    });

    const [stored] = await test.db.query<{ level: number }>(
      "SELECT level FROM stores WHERE store_id = 'store-mine'",
    );
    expect(stored?.level).toBe(1);
  });
});
