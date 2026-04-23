import { parseGrabCraftCatalogPage, type GrabCraftCatalogItem } from './grabcraft-import.js';
import type { LandmarkSpec } from './landmark-autonomy.js';

const GRABCRAFT_SEARCH_BASE_URL = 'https://www.grabcraft.com/search/';

const BROAD_PROMPT_TOKENS = new Set([
  'famous',
  'iconic',
  'landmark',
  'monument',
  'structure',
  'building',
  'build'
]);

const CULTURE_ALIASES: Record<string, string[]> = {
  fr: ['fr', 'france', 'french', 'paris'],
  france: ['fr', 'france', 'french', 'paris'],
  french: ['fr', 'france', 'french', 'paris'],
  it: ['it', 'italy', 'italian', 'rome', 'roman', 'pisa'],
  italy: ['it', 'italy', 'italian', 'rome', 'roman', 'pisa'],
  italian: ['it', 'italy', 'italian', 'rome', 'roman', 'pisa'],
  nl: ['nl', 'netherlands', 'dutch', 'holland', 'amsterdam'],
  netherlands: ['nl', 'netherlands', 'dutch', 'holland', 'amsterdam'],
  dutch: ['nl', 'netherlands', 'dutch', 'holland', 'amsterdam'],
  us: ['us', 'usa', 'american', 'america', 'new york', 'seattle', 'san francisco', 'philadelphia'],
  usa: ['us', 'usa', 'american', 'america', 'new york', 'seattle', 'san francisco', 'philadelphia'],
  american: ['us', 'usa', 'american', 'america', 'new york', 'seattle', 'san francisco', 'philadelphia'],
  uk: ['uk', 'united kingdom', 'british', 'england', 'london'],
  british: ['uk', 'united kingdom', 'british', 'england', 'london'],
  england: ['uk', 'united kingdom', 'british', 'england', 'london'],
  au: ['au', 'australia', 'australian', 'sydney'],
  australia: ['au', 'australia', 'australian', 'sydney'],
  australian: ['au', 'australia', 'australian', 'sydney'],
  ca: ['ca', 'canada', 'canadian', 'toronto'],
  canada: ['ca', 'canada', 'canadian', 'toronto'],
  canadian: ['ca', 'canada', 'canadian', 'toronto'],
  ae: ['ae', 'uae', 'dubai', 'emirates', 'arab'],
  uae: ['ae', 'uae', 'dubai', 'emirates', 'arab'],
  dubai: ['ae', 'uae', 'dubai', 'emirates', 'arab'],
  in: ['in', 'india', 'indian', 'agra', 'delhi'],
  india: ['in', 'india', 'indian', 'agra', 'delhi'],
  indian: ['in', 'india', 'indian', 'agra', 'delhi'],
  jp: ['jp', 'japan', 'japanese', 'tokyo', 'kyoto'],
  japan: ['jp', 'japan', 'japanese', 'tokyo', 'kyoto'],
  japanese: ['jp', 'japan', 'japanese', 'tokyo', 'kyoto'],
  kh: ['kh', 'cambodia', 'cambodian', 'khmer'],
  cambodia: ['kh', 'cambodia', 'cambodian', 'khmer'],
  cambodian: ['kh', 'cambodia', 'cambodian', 'khmer'],
  gr: ['gr', 'greece', 'greek', 'athens'],
  greece: ['gr', 'greece', 'greek', 'athens'],
  greek: ['gr', 'greece', 'greek', 'athens'],
  br: ['br', 'brazil', 'brazilian', 'rio'],
  brazil: ['br', 'brazil', 'brazilian', 'rio'],
  brazilian: ['br', 'brazil', 'brazilian', 'rio'],
  de: ['de', 'germany', 'german', 'bavarian', 'berlin', 'munich'],
  germany: ['de', 'germany', 'german', 'bavarian', 'berlin', 'munich'],
  german: ['de', 'germany', 'german', 'bavarian', 'berlin', 'munich'],
  eg: ['eg', 'egypt', 'egyptian', 'cairo', 'giza'],
  egypt: ['eg', 'egypt', 'egyptian', 'cairo', 'giza'],
  egyptian: ['eg', 'egypt', 'egyptian', 'cairo', 'giza'],
  pe: ['pe', 'peru', 'peruvian', 'inca', 'incan'],
  peru: ['pe', 'peru', 'peruvian', 'inca', 'incan'],
  peruvian: ['pe', 'peru', 'peruvian', 'inca', 'incan'],
  jo: ['jo', 'jordan', 'jordanian', 'petra'],
  jordan: ['jo', 'jordan', 'jordanian', 'petra'],
  jordanian: ['jo', 'jordan', 'jordanian', 'petra'],
  cn: ['cn', 'china', 'chinese', 'beijing', 'ming'],
  china: ['cn', 'china', 'chinese', 'beijing', 'ming'],
  chinese: ['cn', 'china', 'chinese', 'beijing', 'ming'],
  ru: ['ru', 'russia', 'russian', 'moscow'],
  russia: ['ru', 'russia', 'russian', 'moscow'],
  russian: ['ru', 'russia', 'russian', 'moscow'],
  es: ['es', 'spain', 'spanish', 'barcelona', 'madrid'],
  spain: ['es', 'spain', 'spanish', 'barcelona', 'madrid'],
  spanish: ['es', 'spain', 'spanish', 'barcelona', 'madrid'],
  mx: ['mx', 'mexico', 'mexican', 'mayan', 'aztec'],
  mexico: ['mx', 'mexico', 'mexican', 'mayan', 'aztec'],
  mexican: ['mx', 'mexico', 'mexican', 'mayan', 'aztec'],
  tr: ['tr', 'turkey', 'turkish', 'istanbul', 'ottoman'],
  turkey: ['tr', 'turkey', 'turkish', 'istanbul', 'ottoman'],
  turkish: ['tr', 'turkey', 'turkish', 'istanbul', 'ottoman'],
  kr: ['kr', 'korea', 'korean', 'seoul', 'south korea'],
  korea: ['kr', 'korea', 'korean', 'seoul', 'south korea'],
  korean: ['kr', 'korea', 'korean', 'seoul', 'south korea'],
  th: ['th', 'thailand', 'thai', 'bangkok', 'siam'],
  thailand: ['th', 'thailand', 'thai', 'bangkok', 'siam'],
  thai: ['th', 'thailand', 'thai', 'bangkok', 'siam']
};

const CULTURE_QUERY_PRESETS: Record<string, string[]> = {
  fr: ['arc de triomphe', 'eiffel tower', 'paris monument'],
  it: ['tower of pisa', 'colosseum'],
  nl: ['amsterdam canal house', 'dutch windmill'],
  us: ['chrysler building', 'statue of liberty', 'space needle', 'golden gate bridge'],
  uk: ['tower bridge', 'big ben', 'stonehenge'],
  au: ['sydney opera house'],
  ca: ['cn tower', 'toronto tower'],
  ae: ['burj khalifa', 'dubai tower'],
  in: ['taj mahal'],
  jp: ['japanese pagoda', 'temple japan'],
  kh: ['angkor wat', 'khmer temple'],
  gr: ['parthenon', 'greek temple'],
  br: ['christ redeemer', 'rio statue'],
  de: ['neuschwanstein castle', 'medieval castle'],
  eg: ['great pyramid', 'pyramid giza'],
  pe: ['machu picchu', 'inca ruins'],
  jo: ['petra treasury'],
  cn: ['great wall china', 'chinese temple', 'chinese tower'],
  ru: ['saint basil cathedral', 'russian cathedral', 'kremlin'],
  es: ['sagrada familia', 'spanish cathedral', 'barcelona'],
  mx: ['chichen itza', 'mayan pyramid', 'aztec temple'],
  tr: ['hagia sophia', 'mosque istanbul', 'blue mosque'],
  kr: ['korean palace', 'gyeongbokgung', 'korean temple'],
  th: ['wat arun', 'thai temple', 'bangkok temple']
};

const GRABCRAFT_SPEC_PATTERNS: Array<{ specId: string; patterns: RegExp[] }> = [
  { specId: 'arc_de_triomphe_fr', patterns: [/arc\s+de\s+triomphe/i] },
  { specId: 'eiffel_tower_fr', patterns: [/eiffel\s+tower/i, /eiffel-tower/i] },
  { specId: 'amsterdam_canal_house_nl', patterns: [/amsterdam/i, /canal\s+house/i] },
  { specId: 'dutch_windmill_nl', patterns: [/windmill/i] },
  { specId: 'tower_of_pisa_it', patterns: [/tower\s+of\s+pisa/i, /leaning\s+tower/i] },
  { specId: 'colosseum_it', patterns: [/colosseum/i, /coliseum/i] },
  { specId: 'statue_of_liberty_us', patterns: [/statue\s+of\s+liberty/i] },
  { specId: 'space_needle_us', patterns: [/space\s+needle/i] },
  { specId: 'golden_gate_bridge_us', patterns: [/golden\s+gate/i] },
  { specId: 'chrysler_building_us', patterns: [/chrysler/i] },
  { specId: 'big_ben_uk', patterns: [/big\s+ben/i, /elizabeth\s+tower/i] },
  { specId: 'stonehenge_uk', patterns: [/stonehenge/i] },
  { specId: 'sydney_opera_house_au', patterns: [/sydney\s+opera/i, /opera\s+house/i] },
  { specId: 'cn_tower_ca', patterns: [/cn\s+tower/i, /toronto\s+tower/i] },
  { specId: 'burj_khalifa_ae', patterns: [/burj\s+khalifa/i, /dubai\s+tower/i] },
  { specId: 'taj_mahal_in', patterns: [/taj\s+mahal/i] },
  { specId: 'japanese_pagoda_jp', patterns: [/pagoda/i, /japanese\s+temple/i] },
  { specId: 'angkor_wat_kh', patterns: [/angkor\s+wat/i] },
  { specId: 'parthenon_gr', patterns: [/parthenon/i, /greek\s+temple/i] },
  { specId: 'christ_redeemer_br', patterns: [/christ.*redeemer/i, /cristo.*redentor/i] },
  { specId: 'neuschwanstein_castle_de', patterns: [/neuschwanstein/i] },
  { specId: 'medieval_castle_eu', patterns: [/medieval\s+castle/i] },
  { specId: 'great_pyramid_eg', patterns: [/great\s+pyramid/i, /pyramid.*giza/i] },
  { specId: 'machu_picchu_pe', patterns: [/machu\s+picchu/i] },
  { specId: 'petra_treasury_jo', patterns: [/petra/i, /treasury/i] },
  { specId: 'great_wall_cn', patterns: [/great\s+wall/i, /chinese\s+wall/i] },
  { specId: 'saint_basils_cathedral_ru', patterns: [/saint\s+basil/i, /st\.?\s+basil/i, /basil.*cathedral/i] },
  { specId: 'sagrada_familia_es', patterns: [/sagrada\s+familia/i, /gaudi/i] },
  { specId: 'chichen_itza_mx', patterns: [/chichen\s+itza/i, /kukulkan/i, /el\s+castillo/i] },
  { specId: 'hagia_sophia_tr', patterns: [/hagia\s+sophia/i, /aya\s+sofya/i] },
  { specId: 'gyeongbokgung_kr', patterns: [/gyeongbokgung/i, /korean\s+palace/i] },
  { specId: 'wat_arun_th', patterns: [/wat\s+arun/i, /temple.*dawn/i, /thai\s+temple/i] }
];

export interface GrabCraftLookupCandidate {
  title: string;
  url: string;
  blockCount?: number;
  description?: string;
  query: string;
  score: number;
  matchedTokens: string[];
  mappedSpecId?: string;
}

export interface GrabCraftLookupResult {
  queries: string[];
  candidates: GrabCraftLookupCandidate[];
  selected?: GrabCraftLookupCandidate;
}

interface GrabCraftLookupOptions {
  fetchText?: (url: string) => Promise<string>;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizedTokenSet(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(value.trim());
  }
  return result;
}

function cultureAliases(value: string | undefined): string[] {
  const normalized = normalizeText(value ?? '');
  if (!normalized) {
    return [];
  }
  const direct = CULTURE_ALIASES[normalized];
  if (direct) {
    return direct;
  }

  const aliases = new Set<string>([normalized]);
  for (const [key, candidates] of Object.entries(CULTURE_ALIASES)) {
    if (candidates.some((candidate) => normalized.includes(candidate) || candidate.includes(normalized))) {
      aliases.add(key);
      for (const candidate of candidates) {
        aliases.add(candidate);
      }
    }
  }
  return [...aliases];
}

function inferCultureAlias(prompt: string, cultureHint?: string): string | undefined {
  const explicit = cultureAliases(cultureHint)[0];
  if (explicit) {
    return explicit;
  }

  const normalizedPrompt = normalizeText(prompt);
  for (const [culture, aliases] of Object.entries(CULTURE_ALIASES)) {
    if (aliases.some((alias) => normalizedPrompt.includes(alias))) {
      return culture;
    }
  }
  return undefined;
}

function buildPromptQuery(prompt: string, cultureHint?: string): string | undefined {
  const aliases = new Set(cultureAliases(cultureHint));
  const tokens = normalizeText(prompt)
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !BROAD_PROMPT_TOKENS.has(token))
    .filter((token) => !aliases.has(token));

  if (tokens.length === 0) {
    return undefined;
  }
  return tokens.join(' ');
}

function recommendGrabCraftQueries(prompt: string, cultureHint?: string): string[] {
  const inferredCulture = inferCultureAlias(prompt, cultureHint);
  const promptQuery = buildPromptQuery(prompt, cultureHint);
  const queries: string[] = [];

  if (promptQuery) {
    queries.push(promptQuery);
  }
  if (promptQuery && promptQuery !== normalizeText(prompt)) {
    queries.push(normalizeText(prompt));
  }
  if (inferredCulture && CULTURE_QUERY_PRESETS[inferredCulture]) {
    queries.push(...CULTURE_QUERY_PRESETS[inferredCulture]);
  }

  return uniqueStrings(queries).slice(0, 6);
}

function lookupUrlForQuery(query: string): string {
  return `${GRABCRAFT_SEARCH_BASE_URL}${encodeURIComponent(query)}`;
}

function mapGrabCraftCandidateToSpec(item: GrabCraftCatalogItem, specs: LandmarkSpec[]): string | undefined {
  const haystack = `${item.title} ${item.description ?? ''} ${item.url}`.toLowerCase();
  const specIds = new Set(specs.map((spec) => spec.id));
  for (const candidate of GRABCRAFT_SPEC_PATTERNS) {
    if (!specIds.has(candidate.specId)) {
      continue;
    }
    if (candidate.patterns.some((pattern) => pattern.test(haystack))) {
      return candidate.specId;
    }
  }
  return undefined;
}

function scoreGrabCraftCandidate(
  item: GrabCraftCatalogItem,
  query: string,
  promptTokens: Set<string>,
  cultureHint: string | undefined,
  mappedSpecId: string | undefined
): { score: number; matchedTokens: string[] } {
  const titleTokens = normalizedTokenSet(item.title);
  const descriptionTokens = normalizedTokenSet(item.description ?? '');
  const queryTokens = normalizedTokenSet(query);
  const cultureTokens = new Set(cultureAliases(cultureHint));
  const matchedTokens: string[] = [];
  let score = 0;

  for (const token of promptTokens) {
    if (titleTokens.has(token)) {
      matchedTokens.push(token);
      score += 5;
    } else if (descriptionTokens.has(token)) {
      matchedTokens.push(token);
      score += 2;
    }
  }

  for (const token of queryTokens) {
    if (titleTokens.has(token)) {
      if (!matchedTokens.includes(token)) {
        matchedTokens.push(token);
      }
      score += 4;
    }
  }

  for (const token of cultureTokens) {
    if (token.includes(' ') && item.title.toLowerCase().includes(token)) {
      score += 3;
    } else if (titleTokens.has(token) || descriptionTokens.has(token)) {
      score += 2;
    }
  }

  if (mappedSpecId) {
    score += 10;
  }

  const blockCount = item.blockCount ?? 0;
  if (blockCount > 0 && blockCount <= 18000) {
    score += 4;
  } else if (blockCount > 35000) {
    score -= 2;
  } else if (blockCount > 50000) {
    score -= 5;
  }

  return {
    score,
    matchedTokens
  };
}

function dedupeCandidates(candidates: GrabCraftLookupCandidate[]): GrabCraftLookupCandidate[] {
  const byUrl = new Map<string, GrabCraftLookupCandidate>();
  for (const candidate of candidates) {
    const existing = byUrl.get(candidate.url);
    if (!existing || candidate.score > existing.score) {
      byUrl.set(candidate.url, candidate);
    }
  }
  return [...byUrl.values()].sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.title.localeCompare(right.title);
  });
}

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'sam-minecraft-grabcraft-lookup/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

export class GrabCraftLookupService {
  private readonly fetchText: (url: string) => Promise<string>;

  constructor(options: GrabCraftLookupOptions = {}) {
    this.fetchText = options.fetchText ?? defaultFetchText;
  }

  async lookupLandmarks(input: {
    prompt: string;
    cultureHint?: string;
    specs: LandmarkSpec[];
    limit?: number;
  }): Promise<GrabCraftLookupResult> {
    const prompt = String(input.prompt);
    const queries = recommendGrabCraftQueries(prompt, input.cultureHint);
    const promptTokens = normalizedTokenSet(prompt);
    const candidates: GrabCraftLookupCandidate[] = [];

    for (const query of queries) {
      const pageUrl = lookupUrlForQuery(query);
      const html = await this.fetchText(pageUrl);
      const parsed = parseGrabCraftCatalogPage(html, pageUrl);

      for (const item of parsed.items) {
        const mappedSpecId = mapGrabCraftCandidateToSpec(item, input.specs);
        const scored = scoreGrabCraftCandidate(item, query, promptTokens, input.cultureHint, mappedSpecId);
        candidates.push({
          title: item.title,
          url: item.url,
          blockCount: item.blockCount,
          description: item.description,
          query,
          score: scored.score,
          matchedTokens: scored.matchedTokens,
          mappedSpecId
        });
      }
    }

    const ranked = dedupeCandidates(candidates).slice(0, Math.max(1, Math.min(10, input.limit ?? 5)));
    const selected = ranked.find((candidate) => candidate.mappedSpecId) ?? ranked[0];

    return {
      queries,
      candidates: ranked,
      selected
    };
  }
}
