import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeMaterialQuantity,
  describeQuoteJob,
  estimateMaterials,
  saleUnitsFor,
  type EstimatedMaterial,
  type QuoteJob,
} from './material-estimator.ts';
import { decodeQuoteJobs, encodeQuoteJobs, quoteJobSchema, quoteJobsSchema } from './schemas/quote.ts';

const near = (lines: EstimatedMaterial[], material: string, expected: number, tolerance = 0.05) => {
  const line = lines.find((row) => row.material === material);
  assert.ok(line, `no ${material} in the result`);
  assert.ok(
    Math.abs(line.quantity - expected) <= tolerance,
    `${material}: expected about ${expected}, got ${line.quantity}`,
  );
};

/*
 * Worked by hand, independently of the code. 5% wastage on everything but tile.
 *
 * Wall, 10 × 1 m, 230 mm, modular brick: 2.3 m³ at 500 per m³ is 1,150 bricks,
 * 1,207.5 with wastage. They fill 1,150 × 0.001539 = 1.76985 m³, leaving 0.53015
 * of mortar, 0.70510 dry. At 1:6 that is 0.100728 m³ cement (145.05 kg, 152.30
 * with wastage) and 0.604371 m³ sand (21.343 cft, 22.41 with wastage).
 */
test('a modular brick wall in metres', () => {
  const lines = estimateMaterials([
    {
      kind: 'WALL',
      unit: 'M',
      length: 10,
      height: 1,
      openings: 0,
      masonry: 'BRICK_MODULAR',
      thicknessMm: 230,
      mix: '1:6',
    },
  ]);
  near(lines, 'BRICK', 1208, 0);
  near(lines, 'CEMENT', 152.3);
  near(lines, 'SAND', 22.41);
  assert.equal(lines.some((row) => row.material === 'STEEL'), false);
});

/*
 * AAC blocks, 10 × 3 m, 200 mm: 30 m² / (0.61 × 0.21) = 234.19 blocks, 245.9 with
 * wastage. They fill 234.19 × 0.024 = 5.62 of the 6 m³, leaving 0.3794 of mortar.
 */
test('a block wall is counted by its face, and needs less mortar', () => {
  const lines = estimateMaterials([
    {
      kind: 'WALL',
      unit: 'M',
      length: 10,
      height: 3,
      openings: 0,
      masonry: 'BLOCK_AAC',
      thicknessMm: 200,
      mix: '1:6',
    },
  ]);
  near(lines, 'BLOCK', 246, 0);
  // 0.3794 × 1.33 / 7 × 1440 × 1.05
  near(lines, 'CEMENT', 109, 1);
  assert.equal(lines.some((row) => row.material === 'BRICK'), false);
});

test('doors and windows come off the wall', () => {
  const wall = (openings: number): QuoteJob => ({
    kind: 'WALL',
    unit: 'M',
    length: 10,
    height: 3,
    openings,
    masonry: 'BRICK_MODULAR',
    thicknessMm: 230,
    mix: '1:6',
  });
  const full = estimateMaterials([wall(0)]).find((row) => row.material === 'BRICK')!;
  const less = estimateMaterials([wall(15)]).find((row) => row.material === 'BRICK')!;
  // Half the face, half the bricks.
  assert.ok(Math.abs(less.quantity - full.quantity / 2) <= 1);
});

test('feet and metres agree', () => {
  const metres = estimateMaterials([
    { kind: 'PLASTER', unit: 'M', area: 100, thicknessMm: 12, mix: '1:4' },
  ]);
  const feet = estimateMaterials([
    { kind: 'PLASTER', unit: 'FT', area: 1076.39, thicknessMm: 12, mix: '1:4' },
  ]);
  near(feet, 'CEMENT', metres[0]!.quantity, 0.1);
  near(feet, 'SAND', metres[1]!.quantity, 0.1);
});

/*
 * Plaster, 100 m² at 12 mm: 1.2 m³ wet, 1.44 with the allowance, 1.9152 dry. At
 * 1:4 that is 0.38304 m³ cement (551.58 kg, 579.16 with wastage) and 1.53216 m³
 * sand (54.108 cft, 56.81 with wastage).
 */
test('plaster', () => {
  const lines = estimateMaterials([
    { kind: 'PLASTER', unit: 'M', area: 100, thicknessMm: 12, mix: '1:4' },
  ]);
  near(lines, 'CEMENT', 579.16);
  near(lines, 'SAND', 56.81);
});

/*
 * Slab, 10 × 5 m × 125 mm: 6.25 m³, 9.625 dry. M20 is 5.5 parts: cement 1.75 m³
 * (2,520 kg, 2,646 with wastage), sand 2.625 m³ (92.70 cft, 97.34 with wastage),
 * aggregate 5.25 m³ (185.40 cft, 194.67). Steel 6.25 × 80 = 500 kg, 525.
 */
test('an RCC slab', () => {
  const lines = estimateMaterials([
    {
      kind: 'RCC',
      element: 'SLAB',
      unit: 'M',
      span: 10,
      width: 5,
      depth: 125,
      count: 1,
      grade: 'M20',
    },
  ]);
  near(lines, 'CEMENT', 2646);
  near(lines, 'SAND', 97.34);
  near(lines, 'AGGREGATE', 194.67);
  near(lines, 'STEEL', 525);
});

test('a slab in feet takes its depth in inches', () => {
  const metres = estimateMaterials([
    { kind: 'RCC', element: 'SLAB', unit: 'M', span: 3.048, width: 3.048, depth: 127, count: 1, grade: 'M25' },
  ]);
  const feet = estimateMaterials([
    { kind: 'RCC', element: 'SLAB', unit: 'FT', span: 10, width: 10, depth: 5, count: 1, grade: 'M25' },
  ]);
  near(feet, 'CEMENT', metres[0]!.quantity, 0.5);
});

/* Columns: 3 m tall, 230 × 300 mm, four of them = 0.828 m³. Steel 0.828 × 200 × 1.05. */
test('columns are counted, and carry more steel than a slab', () => {
  const lines = estimateMaterials([
    { kind: 'RCC', element: 'COLUMN', unit: 'M', span: 3, width: 230, depth: 300, count: 4, grade: 'M20' },
  ]);
  near(lines, 'STEEL', 173.88);
});

/*
 * Tiling, 100 sq ft = 9.2903 m². Tile 110 sq ft. Adhesive 9.2903 × 4 × 1.05 = 39.02
 * kg. A mortar bed instead: 0.23226 wet, 0.30890 dry, at 1:4 cement 0.06178 m³
 * (88.96 kg, 93.41) and sand 0.24712 m³ (8.727 cft, 9.16).
 */
test('tiling on adhesive', () => {
  const lines = estimateMaterials([
    { kind: 'TILING', unit: 'FT', area: 100, tileSize: '24x24', bed: 'ADHESIVE' },
  ]);
  near(lines, 'TILE', 110);
  near(lines, 'TILE_ADHESIVE', 39.02);
  assert.equal(lines.some((row) => row.material === 'CEMENT'), false);
});

test('tiling on a mortar bed', () => {
  const lines = estimateMaterials([
    { kind: 'TILING', unit: 'FT', area: 100, tileSize: '24x24', bed: 'MORTAR' },
  ]);
  near(lines, 'CEMENT', 93.41);
  near(lines, 'SAND', 9.16);
  assert.equal(lines.some((row) => row.material === 'TILE_ADHESIVE'), false);
});

test('several jobs merge by material', () => {
  const plaster: QuoteJob = { kind: 'PLASTER', unit: 'M', area: 100, thicknessMm: 12, mix: '1:4' };
  const once = estimateMaterials([plaster]);
  const twice = estimateMaterials([plaster, plaster]);
  assert.equal(twice.length, once.length);
  near(twice, 'CEMENT', once[0]!.quantity * 2, 0.01);
});

test('materials merge before they round, so small jobs do not each round up', () => {
  const small: QuoteJob = { kind: 'PLASTER', unit: 'M', area: 5, thicknessMm: 12, mix: '1:4' };
  const [cement] = estimateMaterials([small, small, small]);
  // 28.96 kg each. Three separate round-ups would be 3 bags; merged, 86.9 kg is 2.
  assert.equal(saleUnitsFor(cement!.quantity, 50), 2);
});

test('sale units round up, and float noise does not add a bag', () => {
  assert.equal(saleUnitsFor(100, 50), 2);
  assert.equal(saleUnitsFor(100.01, 50), 3);
  assert.equal(saleUnitsFor(50.0000000001, 50), 1);
  assert.equal(saleUnitsFor(0.1, 50), 1);
  assert.equal(saleUnitsFor(10, 0), 0);
});

test('quantities read the way a site does', () => {
  assert.equal(describeMaterialQuantity('CEMENT', 1250), '25 bags (1,250 kg)');
  assert.equal(describeMaterialQuantity('CEMENT', 20), '1 bag (20 kg)');
  assert.equal(describeMaterialQuantity('SAND', 42.4), '42.4 cft');
  assert.equal(describeMaterialQuantity('BRICK', 1208), '1,208 pieces');
  assert.equal(describeMaterialQuantity('CEMENT', 1250, 'hi'), '25 बोरी (1,250 किलो)');
});

test('a job says itself back in both languages', () => {
  const slab: QuoteJob = {
    kind: 'RCC',
    element: 'SLAB',
    unit: 'FT',
    span: 30,
    width: 20,
    depth: 5,
    count: 1,
    grade: 'M20',
  };
  assert.equal(describeQuoteJob(slab), 'Slab 30 × 20 ft, 5 in, M20');
  assert.equal(describeQuoteJob(slab, 'hi'), 'स्लैब 30 × 20 फ़ुट, 5 इंच, M20');
});

// --- links and bounds --------------------------------------------------------

const WALL: QuoteJob = {
  kind: 'WALL',
  unit: 'FT',
  length: 30,
  height: 10,
  openings: 21,
  masonry: 'BRICK_STANDARD',
  thicknessMm: 230,
  mix: '1:6',
};

test('a link round-trips, and is safe in a URL', () => {
  const jobs: QuoteJob[] = [
    WALL,
    { kind: 'PLASTER', unit: 'FT', area: 540, thicknessMm: 12, mix: '1:4' },
  ];
  const encoded = encodeQuoteJobs(jobs);
  assert.match(encoded, /^v1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeQuoteJobs(encoded), jobs);
});

test('a bad link is nobody, not an error', () => {
  assert.equal(decodeQuoteJobs(null), null);
  assert.equal(decodeQuoteJobs(''), null);
  assert.equal(decodeQuoteJobs('nonsense'), null);
  assert.equal(decodeQuoteJobs('v1.@@@'), null);
  assert.equal(decodeQuoteJobs(`v1.${btoa('{"not":"a list"}')}`), null);
  assert.equal(decodeQuoteJobs(`v1.${btoa('[]')}`), null);
  // Valid JSON, but a wall a mile long.
  assert.equal(decodeQuoteJobs(`v1.${btoa(JSON.stringify([{ ...WALL, length: 99999 }]))}`), null);
});

test('sizes are bounded', () => {
  assert.equal(quoteJobSchema.safeParse({ ...WALL, length: 0 }).success, false);
  assert.equal(quoteJobSchema.safeParse({ ...WALL, length: -3 }).success, false);
  assert.equal(quoteJobSchema.safeParse({ ...WALL, length: 2001 }).success, false);
  assert.equal(quoteJobSchema.safeParse({ ...WALL, mix: '1:99' }).success, false);
  assert.equal(quoteJobSchema.safeParse({ ...WALL, thicknessMm: 777 }).success, false);
  assert.equal(quoteJobsSchema.safeParse(Array(11).fill(WALL)).success, false);
  assert.ok(quoteJobsSchema.safeParse(Array(10).fill(WALL)).success);
});

test('a wall must be bigger than its openings, and thick enough for its block', () => {
  assert.equal(quoteJobSchema.safeParse({ ...WALL, openings: 300 }).success, false);
  assert.equal(
    quoteJobSchema.safeParse({ ...WALL, masonry: 'BLOCK_AAC', thicknessMm: 230 }).success,
    false,
  );
  assert.ok(quoteJobSchema.safeParse({ ...WALL, masonry: 'BLOCK_AAC', thicknessMm: 200 }).success);
});
