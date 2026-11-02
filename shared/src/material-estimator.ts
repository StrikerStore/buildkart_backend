/**
 * Works out the materials a construction job needs.
 *
 * Pure, and free of anything server-side, so the website and the phone app run
 * the same arithmetic the API does. Quantities come out in base units: kg of
 * cement, cft of sand, pieces of brick. Turning those into something the shop
 * sells, such as 50 kg bags, is the API's job, because only the admin knows what
 * one sale unit of a given product covers.
 *
 * **The constants below are common rules of thumb and have not been reviewed
 * against a standard.** A civil engineer should check them before customers rely
 * on them: a wrong figure here means someone buys the wrong quantity.
 */

// --- constants ---------------------------------------------------------------

const CFT_PER_M3 = 35.3147;
const SQFT_PER_M2 = 10.7639;
const M_PER_FT = 0.3048;
const MM_PER_IN = 25.4;

/** Loose bulk density of cement. */
const CEMENT_KG_PER_M3 = 1440;
export const CEMENT_KG_PER_BAG = 50;

/** Dry materials shrink into a wet mix: volume of dry material per volume laid. */
const MORTAR_DRY_FACTOR = 1.33;
const CONCRETE_DRY_FACTOR = 1.54;

/** The mortar joint around each brick or block. */
const JOINT_M = 0.01;

/** Plaster fills uneven walls and joints, so it takes more than area × thickness. */
const PLASTER_UNEVEN_ALLOWANCE = 1.2;

/** Cut, spilled and broken material. */
const WASTAGE = 1.05;
const TILE_WASTAGE = 1.1;

/** Typical steel in reinforced concrete, kg per m³. Real figures come from the drawings. */
const STEEL_KG_PER_M3: Record<RccElement, number> = { SLAB: 80, BEAM: 160, COLUMN: 200 };

const TILE_ADHESIVE_KG_PER_M2 = 4;
const TILE_MORTAR_BED_M = 0.025;
const TILE_MORTAR_PARTS_SAND = 4;

// --- the vocabulary ----------------------------------------------------------

export const QUOTE_MATERIALS = [
  'CEMENT',
  'SAND',
  'AGGREGATE',
  'STEEL',
  'BRICK',
  'BLOCK',
  'TILE',
  'TILE_ADHESIVE',
] as const;
export type QuoteMaterial = (typeof QUOTE_MATERIALS)[number];

export type MaterialBaseUnit = 'kg' | 'cft' | 'piece' | 'sqft';

export const QUOTE_MATERIAL_UNITS: Record<QuoteMaterial, MaterialBaseUnit> = {
  CEMENT: 'kg',
  SAND: 'cft',
  AGGREGATE: 'cft',
  STEEL: 'kg',
  BRICK: 'piece',
  BLOCK: 'piece',
  TILE: 'sqft',
  TILE_ADHESIVE: 'kg',
};

export const QUOTE_MATERIAL_LABELS: Record<QuoteMaterial, { en: string; hi: string }> = {
  CEMENT: { en: 'Cement', hi: 'सीमेंट' },
  SAND: { en: 'Sand', hi: 'रेत' },
  AGGREGATE: { en: 'Aggregate', hi: 'गिट्टी' },
  STEEL: { en: 'Steel (sariya)', hi: 'सरिया' },
  BRICK: { en: 'Bricks', hi: 'ईंट' },
  BLOCK: { en: 'Blocks', hi: 'ब्लॉक' },
  TILE: { en: 'Tiles', hi: 'टाइल' },
  TILE_ADHESIVE: { en: 'Tile adhesive', hi: 'टाइल एडहेसिव' },
};

export const QUOTE_JOB_KINDS = ['WALL', 'PLASTER', 'RCC', 'TILING'] as const;
export type QuoteJobKind = (typeof QUOTE_JOB_KINDS)[number];

export const QUOTE_JOB_LABELS: Record<QuoteJobKind, { en: string; hi: string }> = {
  WALL: { en: 'Brick or block wall', hi: 'ईंट या ब्लॉक की दीवार' },
  PLASTER: { en: 'Plaster', hi: 'प्लास्टर' },
  RCC: { en: 'RCC slab, beam or column', hi: 'आरसीसी स्लैब, बीम या कॉलम' },
  TILING: { en: 'Floor tiling', hi: 'फ़र्श पर टाइल' },
};

/** Long dimensions in feet or metres. Short ones, like a slab's depth, in inches or mm. */
export const QUOTE_LENGTH_UNITS = ['FT', 'M'] as const;
export type QuoteLengthUnit = (typeof QUOTE_LENGTH_UNITS)[number];

export const MASONRY_UNITS = {
  BRICK_STANDARD: {
    material: 'BRICK',
    lengthMm: 230,
    widthMm: 110,
    heightMm: 75,
    thicknesses: [115, 230],
    label: { en: 'Standard brick (9 × 4.5 × 3 in)', hi: 'साधारण ईंट (9 × 4.5 × 3 इंच)' },
  },
  BRICK_MODULAR: {
    material: 'BRICK',
    lengthMm: 190,
    widthMm: 90,
    heightMm: 90,
    thicknesses: [115, 230],
    label: { en: 'Modular brick (190 × 90 × 90 mm)', hi: 'मॉड्यूलर ईंट (190 × 90 × 90 मिमी)' },
  },
  BLOCK_AAC: {
    material: 'BLOCK',
    lengthMm: 600,
    widthMm: null,
    heightMm: 200,
    thicknesses: [100, 150, 200],
    label: { en: 'AAC block (600 × 200 mm face)', hi: 'एएसी ब्लॉक (600 × 200 मिमी)' },
  },
  BLOCK_SOLID: {
    material: 'BLOCK',
    lengthMm: 400,
    widthMm: null,
    heightMm: 200,
    thicknesses: [100, 150, 200],
    label: { en: 'Solid block (400 × 200 mm face)', hi: 'सॉलिड ब्लॉक (400 × 200 मिमी)' },
  },
} as const;
export type MasonryUnit = keyof typeof MASONRY_UNITS;
export const MASONRY_UNIT_KEYS = Object.keys(MASONRY_UNITS) as MasonryUnit[];

export const WALL_THICKNESSES_MM = [100, 115, 150, 200, 230] as const;
export type WallThicknessMm = (typeof WALL_THICKNESSES_MM)[number];

export const WALL_THICKNESS_LABELS: Record<WallThicknessMm, { en: string; hi: string }> = {
  100: { en: '4 in (100 mm)', hi: '4 इंच (100 मिमी)' },
  115: { en: '4.5 in (115 mm)', hi: '4.5 इंच (115 मिमी)' },
  150: { en: '6 in (150 mm)', hi: '6 इंच (150 मिमी)' },
  200: { en: '8 in (200 mm)', hi: '8 इंच (200 मिमी)' },
  230: { en: '9 in (230 mm)', hi: '9 इंच (230 मिमी)' },
};

/** Cement to sand: "1:6" is one part cement to six of sand. */
export const WALL_MIXES = ['1:4', '1:6'] as const;
export type WallMix = (typeof WALL_MIXES)[number];

export const PLASTER_MIXES = ['1:3', '1:4', '1:6'] as const;
export type PlasterMix = (typeof PLASTER_MIXES)[number];

export const PLASTER_THICKNESSES_MM = [6, 12, 15, 20] as const;
export type PlasterThicknessMm = (typeof PLASTER_THICKNESSES_MM)[number];

export const RCC_ELEMENTS = ['SLAB', 'BEAM', 'COLUMN'] as const;
export type RccElement = (typeof RCC_ELEMENTS)[number];

export const RCC_ELEMENT_LABELS: Record<RccElement, { en: string; hi: string }> = {
  SLAB: { en: 'Slab', hi: 'स्लैब' },
  BEAM: { en: 'Beam', hi: 'बीम' },
  COLUMN: { en: 'Column', hi: 'कॉलम' },
};

/** Nominal mixes, cement : sand : aggregate. */
export const RCC_GRADES = {
  M20: { sand: 1.5, aggregate: 3 },
  M25: { sand: 1, aggregate: 2 },
} as const;
export type RccGrade = keyof typeof RCC_GRADES;
export const RCC_GRADE_KEYS = Object.keys(RCC_GRADES) as RccGrade[];

/** Width × length in inches. */
export const TILE_SIZES = ['12x12', '12x18', '16x16', '24x24', '24x48'] as const;
export type TileSize = (typeof TILE_SIZES)[number];

export const TILE_BEDS = ['ADHESIVE', 'MORTAR'] as const;
export type TileBed = (typeof TILE_BEDS)[number];

export const TILE_BED_LABELS: Record<TileBed, { en: string; hi: string }> = {
  ADHESIVE: { en: 'Tile adhesive', hi: 'टाइल एडहेसिव' },
  MORTAR: { en: 'Cement and sand bed', hi: 'सीमेंट और रेत का बेड' },
};

export type WallJob = {
  kind: 'WALL';
  unit: QuoteLengthUnit;
  length: number;
  height: number;
  /** Doors and windows to take off: sq ft, or sq m in metres. */
  openings: number;
  masonry: MasonryUnit;
  thicknessMm: WallThicknessMm;
  mix: WallMix;
};

export type PlasterJob = {
  kind: 'PLASTER';
  unit: QuoteLengthUnit;
  /** Sq ft, or sq m in metres. */
  area: number;
  thicknessMm: PlasterThicknessMm;
  mix: PlasterMix;
};

/**
 * One shape for the three elements. `span` is a slab or beam's length, or a
 * column's height, in feet or metres. `depth` is always short: inches or mm.
 * `width` is short too, except on a slab, where it is a floor dimension.
 */
export type RccJob = {
  kind: 'RCC';
  element: RccElement;
  unit: QuoteLengthUnit;
  span: number;
  width: number;
  depth: number;
  count: number;
  grade: RccGrade;
};

export type TilingJob = {
  kind: 'TILING';
  unit: QuoteLengthUnit;
  /** Sq ft, or sq m in metres. */
  area: number;
  tileSize: TileSize;
  bed: TileBed;
};

export type QuoteJob = WallJob | PlasterJob | RccJob | TilingJob;

export type EstimatedMaterial = {
  material: QuoteMaterial;
  /** In `unit`. Includes wastage, and is not yet rounded to anything sellable. */
  quantity: number;
  unit: MaterialBaseUnit;
};

// --- the arithmetic ----------------------------------------------------------

const longToMetres = (value: number, unit: QuoteLengthUnit) =>
  unit === 'FT' ? value * M_PER_FT : value;

const shortToMetres = (value: number, unit: QuoteLengthUnit) =>
  unit === 'FT' ? (value * MM_PER_IN) / 1000 : value / 1000;

const areaToM2 = (value: number, unit: QuoteLengthUnit) =>
  unit === 'FT' ? value / SQFT_PER_M2 : value;

/** The sand in "1:6". */
const sandParts = (mix: string) => Number(mix.split(':')[1]);

type Tally = Partial<Record<QuoteMaterial, number>>;

function addMortar(tally: Tally, wetM3: number, partsSand: number, wastage: number) {
  const dry = wetM3 * MORTAR_DRY_FACTOR;
  const parts = 1 + partsSand;
  tally.CEMENT = (tally.CEMENT ?? 0) + (dry / parts) * CEMENT_KG_PER_M3 * wastage;
  tally.SAND = (tally.SAND ?? 0) + ((dry * partsSand) / parts) * CFT_PER_M3 * wastage;
}

function addWall(tally: Tally, job: WallJob) {
  const spec = MASONRY_UNITS[job.masonry];
  const thickness = job.thicknessMm / 1000;
  const openingsM2 = areaToM2(job.openings, job.unit);
  const faceM2 = Math.max(
    0,
    longToMetres(job.length, job.unit) * longToMetres(job.height, job.unit) - openingsM2,
  );
  const volume = faceM2 * thickness;
  const unitLength = spec.lengthMm / 1000;
  const unitHeight = spec.heightMm / 1000;

  /*
   * A brick is counted by volume, because a 9-inch wall lays them both ways. A
   * block is as thick as the wall, so it is counted by the face it covers.
   */
  let count: number;
  let unitVolume: number;
  if (spec.widthMm === null) {
    count = faceM2 / ((unitLength + JOINT_M) * (unitHeight + JOINT_M));
    unitVolume = unitLength * thickness * unitHeight;
  } else {
    const unitWidth = spec.widthMm / 1000;
    count = volume / ((unitLength + JOINT_M) * (unitWidth + JOINT_M) * (unitHeight + JOINT_M));
    unitVolume = unitLength * unitWidth * unitHeight;
  }

  tally[spec.material] = (tally[spec.material] ?? 0) + count * WASTAGE;
  addMortar(tally, Math.max(0, volume - count * unitVolume), sandParts(job.mix), WASTAGE);
}

function addPlaster(tally: Tally, job: PlasterJob) {
  const wet = areaToM2(job.area, job.unit) * (job.thicknessMm / 1000) * PLASTER_UNEVEN_ALLOWANCE;
  addMortar(tally, wet, sandParts(job.mix), WASTAGE);
}

function addRcc(tally: Tally, job: RccJob) {
  const span = longToMetres(job.span, job.unit);
  const width =
    job.element === 'SLAB'
      ? longToMetres(job.width, job.unit)
      : shortToMetres(job.width, job.unit);
  const volume = span * width * shortToMetres(job.depth, job.unit) * job.count;

  const mix = RCC_GRADES[job.grade];
  const parts = 1 + mix.sand + mix.aggregate;
  const dry = volume * CONCRETE_DRY_FACTOR;

  tally.CEMENT = (tally.CEMENT ?? 0) + (dry / parts) * CEMENT_KG_PER_M3 * WASTAGE;
  tally.SAND = (tally.SAND ?? 0) + ((dry * mix.sand) / parts) * CFT_PER_M3 * WASTAGE;
  tally.AGGREGATE = (tally.AGGREGATE ?? 0) + ((dry * mix.aggregate) / parts) * CFT_PER_M3 * WASTAGE;
  tally.STEEL = (tally.STEEL ?? 0) + volume * STEEL_KG_PER_M3[job.element] * WASTAGE;
}

function addTiling(tally: Tally, job: TilingJob) {
  const m2 = areaToM2(job.area, job.unit);
  tally.TILE = (tally.TILE ?? 0) + m2 * SQFT_PER_M2 * TILE_WASTAGE;

  if (job.bed === 'ADHESIVE') {
    tally.TILE_ADHESIVE = (tally.TILE_ADHESIVE ?? 0) + m2 * TILE_ADHESIVE_KG_PER_M2 * WASTAGE;
  } else {
    addMortar(tally, m2 * TILE_MORTAR_BED_M, TILE_MORTAR_PARTS_SAND, WASTAGE);
  }
}

/**
 * Totals the materials for a list of jobs.
 *
 * Merged by material before anything is rounded, so three small jobs that each
 * want 0.4 of a bag ask for 2 bags between them, not 3.
 */
export function estimateMaterials(jobs: readonly QuoteJob[]): EstimatedMaterial[] {
  const tally: Tally = {};
  for (const job of jobs) {
    if (job.kind === 'WALL') addWall(tally, job);
    else if (job.kind === 'PLASTER') addPlaster(tally, job);
    else if (job.kind === 'RCC') addRcc(tally, job);
    else addTiling(tally, job);
  }

  return QUOTE_MATERIALS.flatMap((material) => {
    const quantity = tally[material];
    if (quantity === undefined || quantity <= 0) return [];
    const unit = QUOTE_MATERIAL_UNITS[material];
    return [
      {
        material,
        // Whole pieces only. The rest to 3 places, so float noise cannot tip a
        // later round-up into one more bag than anyone needs.
        quantity: unit === 'piece' ? Math.ceil(quantity) : Math.round(quantity * 1000) / 1000,
        unit,
      },
    ];
  });
}

/**
 * Whole sale units for a base quantity, rounded up: nobody buys half a bag.
 *
 * Six places first, because 50.000000001 / 50 must be 1 bag, not 2.
 */
export function saleUnitsFor(baseQuantity: number, baseUnitsPerSaleUnit: number): number {
  if (baseUnitsPerSaleUnit <= 0) return 0;
  return Math.ceil(Number((baseQuantity / baseUnitsPerSaleUnit).toFixed(6)));
}

// --- saying it back ----------------------------------------------------------

type Lang = 'en' | 'hi';

const formatNumber = (value: number) => {
  const rounded = Math.round(value * 10) / 10;
  return rounded.toLocaleString('en-IN');
};

/** "25 bags (1,250 kg)", "42 cft", "1,208 pieces". What the job needs, before any product. */
export function describeMaterialQuantity(
  material: QuoteMaterial,
  quantity: number,
  lang: Lang = 'en',
): string {
  const hi = lang === 'hi';
  if (material === 'CEMENT') {
    const bags = saleUnitsFor(quantity, CEMENT_KG_PER_BAG);
    return hi
      ? `${bags.toLocaleString('en-IN')} बोरी (${formatNumber(quantity)} किलो)`
      : `${bags.toLocaleString('en-IN')} ${bags === 1 ? 'bag' : 'bags'} (${formatNumber(quantity)} kg)`;
  }
  const unit = QUOTE_MATERIAL_UNITS[material];
  if (unit === 'kg') return `${formatNumber(quantity)} ${hi ? 'किलो' : 'kg'}`;
  if (unit === 'cft') return `${formatNumber(quantity)} ${hi ? 'घन फ़ुट' : 'cft'}`;
  if (unit === 'sqft') return `${formatNumber(quantity)} ${hi ? 'वर्ग फ़ुट' : 'sq ft'}`;
  return hi ? `${formatNumber(quantity)} नग` : `${formatNumber(quantity)} pieces`;
}

/** One line about a job, for the list, a printed sheet and the admin's enquiry. */
export function describeQuoteJob(job: QuoteJob, lang: Lang = 'en'): string {
  const hi = lang === 'hi';
  const long = job.unit === 'FT' ? (hi ? 'फ़ुट' : 'ft') : hi ? 'मीटर' : 'm';
  const short = job.unit === 'FT' ? (hi ? 'इंच' : 'in') : hi ? 'मिमी' : 'mm';
  const area = job.unit === 'FT' ? (hi ? 'वर्ग फ़ुट' : 'sq ft') : hi ? 'वर्ग मीटर' : 'sq m';
  const mm = hi ? 'मिमी' : 'mm';

  if (job.kind === 'WALL') {
    const opening = job.openings > 0 ? `, ${hi ? 'खुला हिस्सा' : 'less'} ${job.openings} ${area}` : '';
    return `${hi ? 'दीवार' : 'Wall'} ${job.length} × ${job.height} ${long}${opening}, ${WALL_THICKNESS_LABELS[job.thicknessMm][lang]}, ${MASONRY_UNITS[job.masonry].label[lang]}, ${hi ? 'मसाला' : 'mortar'} ${job.mix}`;
  }
  if (job.kind === 'PLASTER') {
    return `${hi ? 'प्लास्टर' : 'Plaster'} ${job.area} ${area}, ${job.thicknessMm} ${mm}, ${hi ? 'मसाला' : 'mix'} ${job.mix}`;
  }
  if (job.kind === 'RCC') {
    const count = job.count > 1 ? ` × ${job.count}` : '';
    const label = RCC_ELEMENT_LABELS[job.element][lang];
    const size =
      job.element === 'SLAB'
        ? `${job.span} × ${job.width} ${long}, ${job.depth} ${short}`
        : `${job.span} ${long}, ${job.width} × ${job.depth} ${short}`;
    return `${label}${count} ${size}, ${job.grade}`;
  }
  const [width, length] = job.tileSize.split('x');
  return `${hi ? 'टाइल' : 'Tiling'} ${job.area} ${area}, ${width} × ${length} ${hi ? 'इंच' : 'in'}, ${TILE_BED_LABELS[job.bed][lang]}`;
}

// --- links -------------------------------------------------------------------

/** The version in front keeps old shared links working if the shape ever changes. */
const LINK_PREFIX = 'v1.';

/** Jobs as a URL value. Measurements only: nothing about a person, and no prices. */
export function encodeQuoteJobsPayload(jobs: readonly QuoteJob[]): string {
  const base64 = btoa(JSON.stringify(jobs));
  return LINK_PREFIX + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The raw decoded value, or null. Callers validate it: a link is anyone's to edit. */
export function decodeQuoteJobsPayload(raw: string | null | undefined): unknown {
  if (!raw || !raw.startsWith(LINK_PREFIX) || raw.length > 8000) return null;
  try {
    const base64 = raw.slice(LINK_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}
