/**
 * Fixtures for tests, demo mode and E2E.
 *
 * The placeholder motif is *generated*, not downloaded: a seeded gradient with
 * value noise and a vignette. That keeps the pipeline exercisable with no
 * network and no binary checked into the repository, and — because the seed is
 * fixed — makes the fixture byte-identical on every machine, which is what lets
 * the determinism test mean anything.
 *
 * Nothing here pretends a real image model ran. The provenance says
 * `fixture:gradient-noise`, so a fixture creative can never be mistaken for a
 * generated one.
 */

import sharp from 'sharp';
import type { BrandProfile, CreativeConcept } from '@am/domain';
import { brandProfileSchema, creativeConceptSchema } from '@am/domain';
import { altTextForConcept } from './alt-text';
import { contentFromConcept } from './content';
import {
  A_AND_M_DEFAULT_COLORS,
  RENDERER_VERSION,
  creativeRenderRequestSchema,
  motifFromBuffer,
  type CreativeRenderRequest,
  type TemplateId,
} from './types';
import { parseHex } from './color';

/** Recorded as the image model for every fixture creative. */
export const FIXTURE_IMAGE_MODEL = 'fixture:gradient-noise';
export const FIXTURE_SEED = 20260825;
/** Fixed timestamp so a fixture render is reproducible byte for byte. */
export const FIXTURE_RENDERED_AT = '2026-01-15T09:00:00.000Z';

/* -------------------------------------------------------------------------- */
/* Placeholder motif                                                           */
/* -------------------------------------------------------------------------- */

export interface PlaceholderMotifOptions {
  width?: number;
  height?: number;
  seed?: number;
  /** Gradient endpoints. Deliberately not brand colours — this is a photo stand-in. */
  from?: string;
  to?: string;
  /** 0 = flat gradient, 1 = heavy grain. */
  noise?: number;
}

/** Deterministic 32-bit PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bilinearly interpolated value noise over a coarse grid. */
function valueNoiseGrid(size: number, random: () => number): number[][] {
  const grid: number[][] = [];
  for (let y = 0; y <= size; y++) {
    const row: number[] = [];
    for (let x = 0; x <= size; x++) row.push(random());
    grid.push(row);
  }
  return grid;
}

function sampleNoise(grid: number[][], size: number, u: number, v: number): number {
  const gx = u * size;
  const gy = v * size;
  const x0 = Math.min(size, Math.floor(gx));
  const y0 = Math.min(size, Math.floor(gy));
  const x1 = Math.min(size, x0 + 1);
  const y1 = Math.min(size, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  const sx = smooth(tx);
  const sy = smooth(ty);
  const top = grid[y0]![x0]! * (1 - sx) + grid[y0]![x1]! * sx;
  const bottom = grid[y1]![x0]! * (1 - sx) + grid[y1]![x1]! * sx;
  return top * (1 - sy) + bottom * sy;
}

/**
 * Builds a synthetic base motif as PNG bytes.
 *
 * Bright enough in places to make the contrast solver do real work — a flat grey
 * rectangle would let every scrim pass and the AA check would prove nothing.
 */
export async function createPlaceholderMotif(
  options: PlaceholderMotifOptions = {},
): Promise<Buffer> {
  const width = options.width ?? 1600;
  const height = options.height ?? 1600;
  const seed = options.seed ?? FIXTURE_SEED;
  const from = parseHex(options.from ?? '#1B2A3A');
  const to = parseHex(options.to ?? '#E8D9C2');
  const noiseAmount = options.noise ?? 0.28;

  const random = mulberry32(seed);
  const gridSize = 10;
  const grid = valueNoiseGrid(gridSize, random);

  const pixels = Buffer.allocUnsafe(width * height * 3);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1 || 1);
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1 || 1);
      const t = Math.min(1, Math.max(0, (u * 0.45 + v * 0.55)));
      const n = (sampleNoise(grid, gridSize, u, v) - 0.5) * noiseAmount;
      // Radial falloff keeps the corners darker, like a real photograph.
      const dx = u - 0.5;
      const dy = v - 0.5;
      const vignette = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy) * 0.9) * 0.35;
      const channel = (a: number, b: number): number => {
        const base = a + (b - a) * t;
        return Math.min(255, Math.max(0, Math.round((base + n * 255) * vignette)));
      };
      pixels[offset++] = channel(from.r, to.r);
      pixels[offset++] = channel(from.g, to.g);
      pixels[offset++] = channel(from.b, to.b);
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

/** A deliberately near-white motif — makes white-on-white contrast fail. */
export async function createBrightMotif(size = 800): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 252, g: 252, b: 250 },
    },
  })
    .png()
    .toBuffer();
}

/* -------------------------------------------------------------------------- */
/* Brand and concepts                                                          */
/* -------------------------------------------------------------------------- */

export const FIXTURE_BRAND_PROFILE: BrandProfile = brandProfileSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'A&M',
  positioning:
    'A&M begleitet mittelständische Unternehmen dabei, ihre Vertriebs- und Marketingprozesse messbar profitabel zu machen.',
  toneOfVoice:
    'Sachlich, direkt und belegorientiert. Keine Superlative, keine Rabattsprache, immer mit Bezug auf nachvollziehbare Zahlen.',
  avoidTerms: ['günstig', 'billig', 'garantiert'],
  preferredTerms: ['messbar', 'nachvollziehbar', 'Potenzialanalyse'],
  colors: A_AND_M_DEFAULT_COLORS,
  logoAssetPath: null,
});

/** A second profile to prove the templates carry foreign tokens. */
export const FIXTURE_ALT_BRAND_PROFILE: BrandProfile = brandProfileSchema.parse({
  ...FIXTURE_BRAND_PROFILE,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Nordwerk',
  colors: {
    primary: '#0A5C36',
    foreground: '#12211A',
    background: '#F7F5EF',
    accent: '#04160E',
  },
});

export const FIXTURE_CONCEPT: CreativeConcept = creativeConceptSchema.parse({
  key: 'concept_1',
  name: 'Potenzialanalyse Handwerk',
  principle: 'PROOF_CASE_DATAPOINT',
  visualIdea:
    'Werkstattleitung steht an einem Stehpult und prüft eine Auftragsübersicht, weiches Seitenlicht, ruhige Farben, keine Schrift im Bild.',
  imagePrompt:
    'Dokumentarische Aufnahme einer Werkstattleitung an einem Stehpult, weiches Seitenlicht von links, gedeckte Farben, realistische Tiefenschärfe, keinerlei Text, keine Logos, keine Bildschirminhalte.',
  copy: {
    primaryText:
      'Die meisten Handwerksbetriebe verlieren Anfragen nicht im Vertrieb, sondern in den 48 Stunden davor. Die Potenzialanalyse zeigt in 90 Sekunden, wo Ihre Anfragen versickern.',
    headline: '38 % mehr qualifizierte Anfragen',
    description: 'Kostenlose Potenzialanalyse für Betriebe mit 10 bis 50 Mitarbeitenden.',
    callToAction: 'Analyse starten',
  },
  hypothesis:
    'Eine konkrete, belegte Kennzahl schlägt eine allgemeine Nutzenaussage bei Entscheiderinnen und Entscheidern im Handwerk.',
  rationale:
    'Die Zielgruppe misst Erfolg in Aufträgen pro Monat. Eine überprüfbare Prozentzahl macht das Versprechen prüfbar statt werblich.',
  proofUsed: 'Auswertung von 42 Betrieben nach zwölf Wochen Begleitung, Zeitraum 2025.',
  funnelPromise: 'In 90 Sekunden sehen, wo Anfragen verloren gehen.',
  altText:
    'Werkstattleitung prüft eine Auftragsübersicht, daneben die Aussage 38 Prozent mehr qualifizierte Anfragen.',
  aspectRatios: ['1:1', '4:5'],
  claims: [
    {
      text: '38 % mehr qualifizierte Anfragen nach zwölf Wochen.',
      evidence: {
        evidenceItemId: null,
        kind: 'HISTORICAL_PERFORMANCE',
        summary: 'Auswertung von 42 begleiteten Betrieben, 2025.',
        sourceRef: 'internal-benchmark-2025',
      },
      confidence: 'INDICATION',
      requiresHypothesisLabel: false,
    },
  ],
});

export const FIXTURE_COMPARISON_CONCEPT: CreativeConcept = creativeConceptSchema.parse({
  ...FIXTURE_CONCEPT,
  key: 'concept_2',
  name: 'Vergleich Anfrageprozess',
  principle: 'COMPARISON_ALTERNATIVE',
  copy: {
    primaryText:
      'Anfragen landen in einem Postfach, werden am Abend gesichtet und am nächsten Tag zurückgerufen. Bis dahin hat der Wettbewerb längst einen Termin.',
    headline: 'Anfrage heute, Termin morgen',
    description: 'Strukturierte Qualifizierung statt Rückruf aus dem Bauch heraus.',
    callToAction: 'Vergleich ansehen',
  },
  altText:
    'Gegenüberstellung des heutigen Anfrageprozesses mit einem strukturierten Qualifizierungsprozess.',
});

/* -------------------------------------------------------------------------- */
/* Example requests                                                            */
/* -------------------------------------------------------------------------- */

export interface ExampleRequestOptions {
  template?: TemplateId;
  concept?: CreativeConcept;
  brand?: BrandProfile;
  ratios?: CreativeRenderRequest['ratios'];
  motif?: Buffer;
  focusPoint?: { x: number; y: number };
}

/** A complete, valid render request built entirely from fixtures. */
export async function exampleRenderRequest(
  options: ExampleRequestOptions = {},
): Promise<CreativeRenderRequest> {
  const concept = options.concept ?? FIXTURE_CONCEPT;
  const brand = options.brand ?? FIXTURE_BRAND_PROFILE;
  const template = options.template ?? 'bold-statement';
  const motif = options.motif ?? (await createPlaceholderMotif());
  const content = contentFromConcept(concept, { brandName: brand.name });
  const altText = altTextForConcept(concept, template, content);

  return creativeRenderRequestSchema.parse({
    conceptKey: concept.key,
    template,
    ratios: options.ratios ?? ['1:1', '4:5'],
    motif: motifFromBuffer(motif),
    focusPoint: options.focusPoint ?? { x: 0.5, y: 0.42 },
    brand,
    copy: concept.copy,
    content,
    altText: altText.text,
    provenance: {
      imageModel: FIXTURE_IMAGE_MODEL,
      imagePrompt: concept.imagePrompt,
      imageParameters: { seed: FIXTURE_SEED, size: '1600x1600' },
      creativeVersion: 1,
      conceptKey: concept.key,
      principle: concept.principle,
      promptVersionId: null,
      aiJobId: null,
      rendererVersion: RENDERER_VERSION,
      renderedAt: FIXTURE_RENDERED_AT,
    },
    reviewState: 'DRAFT',
  });
}

/** One request per template, sharing a single motif — for demos and E2E. */
export async function exampleRenderRequests(): Promise<CreativeRenderRequest[]> {
  const motif = await createPlaceholderMotif();
  const templates: TemplateId[] = [
    'bold-statement',
    'split-panel',
    'data-point',
    'quote-proof',
    'comparison',
  ];
  return Promise.all(
    templates.map((template) =>
      exampleRenderRequest({
        template,
        motif,
        concept: template === 'comparison' ? FIXTURE_COMPARISON_CONCEPT : FIXTURE_CONCEPT,
        ratios: ['1:1', '4:5', '9:16'],
      }),
    ),
  );
}

/** A very long German headline, for the auto-fit tests. */
export const LONG_GERMAN_HEADLINE =
  'Wirtschaftlichkeitsberechnung und Instandhaltungsplanung für mittelständische Produktionsbetriebe in unter neunzig Sekunden';
