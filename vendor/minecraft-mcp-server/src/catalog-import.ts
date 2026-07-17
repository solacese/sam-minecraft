import { promises as fs } from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const CATALOG_ORIGIN = 'https://models.example.invalid';

interface CatalogDimensions {
  x: number;
  y: number;
  z: number;
}

interface CatalogRenderBlock {
  x: number;
  y: number | string;
  z: number | string;
  hex?: string;
  rgb?: number[];
  name: string;
  mat_id: string | number;
  file?: string;
  transparent: boolean;
  opacity: number;
  texture?: string;
}

interface CatalogPaletteEntry {
  paletteKey: string;
  materialId: string;
  name: string;
  texture?: string;
  hex?: string;
  rgb?: number[];
  transparent: boolean;
  opacity: number;
  count: number;
}

interface CatalogLayerSummary {
  y: number;
  blockCount: number;
  paletteKeys: string[];
  blueprintImageUrl?: string;
}

interface CatalogImportedBlock {
  x: number;
  y: number;
  z: number;
  paletteKey: string;
}

interface CatalogBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface CatalogModelArtifact {
  schemaVersion: '1.0';
  kind: 'catalog-model';
  source: {
    pageUrl: string;
    fetchedAt: string;
    title: string;
    blockCount?: number;
    dimensions?: CatalogDimensions;
    renderObjectScriptUrl?: string;
    layerMapScriptUrl?: string;
    blueprintBaseUrl?: string;
    blueprintLayerCount?: number;
  };
  stats: {
    importedBlocks: number;
    paletteSize: number;
    layerCount: number;
    bounds: CatalogBounds | null;
  };
  palette: CatalogPaletteEntry[];
  layers: CatalogLayerSummary[];
  blocks: CatalogImportedBlock[];
}

export interface CatalogCatalogItem {
  title: string;
  url: string;
  imageUrl?: string;
  blockCount?: number;
  description?: string;
  detailsUrl?: string;
  blueprintsUrl?: string;
}

export interface CatalogCatalogArtifact {
  schemaVersion: '1.0';
  kind: 'catalog-catalog';
  source: {
    pageUrl: string;
    fetchedAt: string;
    title: string;
  };
  stats: {
    itemsOnPage: number;
  };
  items: CatalogCatalogItem[];
}

interface CatalogObjectPageMeta {
  title: string;
  blockCount?: number;
  dimensions?: CatalogDimensions;
  renderObjectScriptUrl?: string;
  layerMapScriptUrl?: string;
  blueprintBaseUrl?: string;
  blueprintLayerCount?: number;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '));
}

function absoluteCatalogUrl(urlOrPath: string, baseUrl = CATALOG_ORIGIN): string {
  return new URL(urlOrPath, baseUrl).toString();
}

function extractMatch(pattern: RegExp, input: string): string | undefined {
  const match = input.match(pattern);
  return match?.[1];
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const digits = value.replace(/[^\d-]/g, '');
  if (!digits) {
    return undefined;
  }

  return Number.parseInt(digits, 10);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function extractJsonAssignment<T>(scriptText: string, variableName: string): T {
  const pattern = new RegExp(`var\\s+${variableName}\\s*=\\s*(\\{[\\s\\S]*\\})\\s*;?\\s*$`);
  const payload = extractMatch(pattern, scriptText);
  if (!payload) {
    throw new Error(`Could not parse ${variableName} payload.`);
  }

  return JSON.parse(payload) as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'sam-minecraft-catalog-importer/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

export function parseCatalogObjectPage(html: string, pageUrl: string): CatalogObjectPageMeta {
  const title =
    stripTags(
      extractMatch(/<h1[^>]*id="content-title"[^>]*>([\s\S]*?)<\/h1>/i, html) ??
        extractMatch(/<title>([\s\S]*?)<\/title>/i, html) ??
        'Untitled Model Object'
    ) || 'Untitled Model Object';

  const blockCount = parseInteger(extractMatch(/class="value block_count">([\d,]+)<\/td>/i, html));
  const dimX = parseInteger(extractMatch(/var\s+dimX\s*=\s*(\d+)\s*;/i, html));
  const dimY = parseInteger(extractMatch(/var\s+dimY\s*=\s*(\d+)\s*;/i, html));
  const dimZ = parseInteger(extractMatch(/var\s+dimZ\s*=\s*(\d+)\s*;/i, html));
  const blueprintLayerCount = parseInteger(extractMatch(/var\s+totalPositions\s*=\s*(\d+)\s*;/i, html));

  const dimensions =
    dimX !== undefined && dimY !== undefined && dimZ !== undefined
      ? { x: dimX, y: dimY, z: dimZ }
      : undefined;

  const renderObjectPath = extractMatch(
    /<script\s+src="([^"]*\/js\/RenderObject\/myRenderObject_[^"]+\.js)"><\/script>/i,
    html
  );
  const layerMapPath = extractMatch(
    /<script\s+src="([^"]*\/js\/LayerMap\/LayerMap_[^"]+\.js)"><\/script>/i,
    html
  );
  const blueprintBaseUrl = extractMatch(/var\s+base_url\s*=\s*"([^"]+)";/i, html);

  return {
    title,
    blockCount,
    dimensions,
    renderObjectScriptUrl: renderObjectPath ? absoluteCatalogUrl(renderObjectPath, pageUrl) : undefined,
    layerMapScriptUrl: layerMapPath ? absoluteCatalogUrl(layerMapPath, pageUrl) : undefined,
    blueprintBaseUrl,
    blueprintLayerCount
  };
}

export function parseCatalogCatalogPage(html: string, pageUrl: string): CatalogCatalogArtifact {
  const title =
    stripTags(
      extractMatch(/<h1[^>]*id="content-title"[^>]*>([\s\S]*?)<\/h1>/i, html) ??
        extractMatch(/<title>([\s\S]*?)<\/title>/i, html) ??
        'Untitled Model Catalog'
    ) || 'Untitled Model Catalog';

  const productPattern =
    /<div class="product-box[\s\S]*?<a href="([^"]+)" class="image" title="([^"]+)">[\s\S]*?<img src="([^"]+)"[^>]*alt="([^"]*)"[\s\S]*?<div class="product-description">([\s\S]*?)<\/div>[\s\S]*?<div class="regular-price"><b><i class="fa fa-cubes"><\/i>&nbsp;Block count:&nbsp;([\d,]+)<\/b><\/div>[\s\S]*?<a href="([^"]+)" class="button more-info details">Details<\/a>[\s\S]*?<a href="([^"]+)" class="button more-info blueprints">Blueprints<\/a>/gi;

  const items: CatalogCatalogItem[] = [];
  let match: RegExpExecArray | null;
  while ((match = productPattern.exec(html)) !== null) {
    items.push({
      title: decodeHtmlEntities(match[2] || match[4]),
      url: absoluteCatalogUrl(match[1], pageUrl),
      imageUrl: absoluteCatalogUrl(match[3], pageUrl),
      blockCount: parseInteger(match[6]),
      description: stripTags(match[5]),
      detailsUrl: absoluteCatalogUrl(match[7], pageUrl),
      blueprintsUrl: absoluteCatalogUrl(match[8], pageUrl)
    });
  }

  return {
    schemaVersion: '1.0',
    kind: 'catalog-catalog',
    source: {
      pageUrl,
      fetchedAt: new Date().toISOString(),
      title
    },
    stats: {
      itemsOnPage: items.length
    },
    items
  };
}

export function flattenRenderObject(renderObject: Record<string, Record<string, Record<string, CatalogRenderBlock>>>): {
  blocks: CatalogImportedBlock[];
  layers: CatalogLayerSummary[];
  palette: CatalogPaletteEntry[];
  bounds: CatalogBounds | null;
} {
  const blocks: CatalogImportedBlock[] = [];
  const paletteMap = new Map<string, CatalogPaletteEntry>();
  const layerMap = new Map<number, { blockCount: number; paletteKeys: Set<string> }>();

  let bounds: CatalogBounds | null = null;

  const sortedY = Object.keys(renderObject)
    .map((value) => Number.parseInt(value, 10))
    .sort((left, right) => left - right);

  for (const y of sortedY) {
    const byX = renderObject[String(y)] ?? {};
    const sortedX = Object.keys(byX)
      .map((value) => Number.parseInt(value, 10))
      .sort((left, right) => left - right);

    for (const x of sortedX) {
      const byZ = byX[String(x)] ?? {};
      const sortedZ = Object.keys(byZ)
        .map((value) => Number.parseInt(value, 10))
        .sort((left, right) => left - right);

      for (const z of sortedZ) {
        const block = byZ[String(z)];
        const paletteKey = `${block.mat_id}:${block.texture ?? ''}:${block.name}`;
        const blockY = Number.parseInt(String(block.y), 10);
        const blockZ = Number.parseInt(String(block.z), 10);
        const blockX = Number.parseInt(String(block.x), 10);

        blocks.push({
          x: blockX,
          y: blockY,
          z: blockZ,
          paletteKey
        });

        const paletteEntry = paletteMap.get(paletteKey);
        if (paletteEntry) {
          paletteEntry.count += 1;
        } else {
          paletteMap.set(paletteKey, {
            paletteKey,
            materialId: String(block.mat_id),
            name: block.name,
            texture: block.texture,
            hex: block.hex,
            rgb: block.rgb,
            transparent: Boolean(block.transparent),
            opacity: Number(block.opacity),
            count: 1
          });
        }

        const layerSummary = layerMap.get(blockY) ?? { blockCount: 0, paletteKeys: new Set<string>() };
        layerSummary.blockCount += 1;
        layerSummary.paletteKeys.add(paletteKey);
        layerMap.set(blockY, layerSummary);

        if (!bounds) {
          bounds = {
            minX: blockX,
            maxX: blockX,
            minY: blockY,
            maxY: blockY,
            minZ: blockZ,
            maxZ: blockZ
          };
        } else {
          bounds.minX = Math.min(bounds.minX, blockX);
          bounds.maxX = Math.max(bounds.maxX, blockX);
          bounds.minY = Math.min(bounds.minY, blockY);
          bounds.maxY = Math.max(bounds.maxY, blockY);
          bounds.minZ = Math.min(bounds.minZ, blockZ);
          bounds.maxZ = Math.max(bounds.maxZ, blockZ);
        }
      }
    }
  }

  const layers = Array.from(layerMap.entries())
    .sort(([left], [right]) => left - right)
    .map(([y, summary]) => ({
      y,
      blockCount: summary.blockCount,
      paletteKeys: Array.from(summary.paletteKeys).sort()
    }));

  const palette = Array.from(paletteMap.values()).sort((left, right) => right.count - left.count);

  return {
    blocks,
    layers,
    palette,
    bounds
  };
}

export async function importCatalogModel(pageUrl: string): Promise<CatalogModelArtifact> {
  const html = await fetchText(pageUrl);
  const meta = parseCatalogObjectPage(html, pageUrl);

  if (!meta.renderObjectScriptUrl) {
    throw new Error(`No render object script found on ${pageUrl}.`);
  }

  const renderScriptText = await fetchText(meta.renderObjectScriptUrl);
  const renderObject = extractJsonAssignment<Record<string, Record<string, Record<string, CatalogRenderBlock>>>>(
    renderScriptText,
    'myRenderObject'
  );

  const flattened = flattenRenderObject(renderObject);

  const layerMapScriptText = meta.layerMapScriptUrl ? await fetchText(meta.layerMapScriptUrl) : undefined;
  if (layerMapScriptText) {
    // Validate that the layer map payload is machine-readable. The imported artifact already keeps blueprint URLs.
    extractJsonAssignment<Record<string, unknown>>(layerMapScriptText, 'layerMap');
  }

  const layers = flattened.layers.map((layer) => ({
    ...layer,
    blueprintImageUrl:
      meta.blueprintBaseUrl && meta.blueprintLayerCount && layer.y <= meta.blueprintLayerCount
        ? `${meta.blueprintBaseUrl}${layer.y}.png`
        : undefined
  }));

  return {
    schemaVersion: '1.0',
    kind: 'catalog-model',
    source: {
      pageUrl,
      fetchedAt: new Date().toISOString(),
      title: meta.title,
      blockCount: meta.blockCount,
      dimensions: meta.dimensions,
      renderObjectScriptUrl: meta.renderObjectScriptUrl,
      layerMapScriptUrl: meta.layerMapScriptUrl,
      blueprintBaseUrl: meta.blueprintBaseUrl,
      blueprintLayerCount: meta.blueprintLayerCount
    },
    stats: {
      importedBlocks: flattened.blocks.length,
      paletteSize: flattened.palette.length,
      layerCount: layers.length,
      bounds: flattened.bounds
    },
    palette: flattened.palette,
    layers,
    blocks: flattened.blocks
  };
}

export async function importCatalogCatalog(pageUrl: string): Promise<CatalogCatalogArtifact> {
  const html = await fetchText(pageUrl);
  return parseCatalogCatalogPage(html, pageUrl);
}

async function writeArtifact(outputDir: string, pageUrl: string, artifact: CatalogModelArtifact | CatalogCatalogArtifact): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const defaultName =
    artifact.kind === 'catalog-model'
      ? `${slugify(artifact.source.title)}.model.json`
      : `${slugify(artifact.source.title)}.catalog.json`;
  const filePath = path.join(outputDir, defaultName);
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), 'utf8');
  return filePath;
}

async function runCli(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('catalog-import')
    .usage('$0 --url <catalog-url> [--type auto|model|catalog] [--output-dir path]')
    .option('url', {
      type: 'string',
      demandOption: true,
      describe: 'Model object or category URL'
    })
    .option('type', {
      type: 'string',
      default: 'auto',
      choices: ['auto', 'model', 'catalog'] as const,
      describe: 'Force import mode or detect from page structure'
    })
    .option('output-dir', {
      type: 'string',
      default: path.resolve(process.cwd(), 'catalog_samples'),
      describe: 'Directory where imported JSON artifacts will be written'
    })
    .strict()
    .help()
    .parse();

  const pageUrl = argv.url;
  const html = await fetchText(pageUrl);
  const inferredType =
    argv.type !== 'auto'
      ? argv.type
      : /\/js\/RenderObject\/myRenderObject_/i.test(html)
        ? 'model'
        : 'catalog';

  const artifact =
    inferredType === 'model'
      ? await importCatalogModel(pageUrl)
      : parseCatalogCatalogPage(html, pageUrl);

  const filePath = await writeArtifact(path.resolve(argv['output-dir']), pageUrl, artifact);
  const summary =
    artifact.kind === 'catalog-model'
      ? `Imported ${artifact.source.title}: ${artifact.stats.importedBlocks} blocks, ${artifact.stats.paletteSize} palette entries.`
      : `Imported ${artifact.source.title}: ${artifact.stats.itemsOnPage} catalog items.`;

  process.stdout.write(`${summary}\nSaved to ${filePath}\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).toString()) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
