import test from 'ava';
import { GrabCraftLookupService } from '../src/grabcraft-lookup.js';
import { normalizeLandmarkSpec } from '../src/landmark-autonomy.js';

const EMPTY_CATALOG_HTML = `
  <html>
    <body>
      <h1 id="content-title">MineCraft Objects Database</h1>
      <div class="products row-size-4"></div>
    </body>
  </html>
`;

const CHRYSLER_SEARCH_HTML = `
  <html>
    <body>
      <h1 id="content-title">MineCraft Objects Database</h1>
      <div class="products row-size-4">
        <div class="product-box item-1">
          <div class="product-image">
            <a href="/minecraft/ny-chrysler-building/skyscrapers" class="image" title="NY Chrysler Building">
              <img src="https://www.grabcraft.com/files/products/thumb/thumb_ny-chrysler-building.png" alt="NY Chrysler Building" />
            </a>
          </div>
          <div class="text-info">
            <h3 class="name"><a href="/minecraft/ny-chrysler-building/skyscrapers" title="NY Chrysler Building">NY Chrysler Building</a></h3>
            <div class="product-description">An iconic American Art Deco skyscraper in New York.</div>
            <div class="price">
              <div class="regular-price"><b><i class="fa fa-cubes"></i>&nbsp;Block count:&nbsp;41592</b></div>
            </div>
            <a href="/minecraft/ny-chrysler-building/skyscrapers#general" class="button more-info details">Details</a>
            <a href="/minecraft/ny-chrysler-building/skyscrapers#blueprints" class="button more-info blueprints">Blueprints</a>
          </div>
        </div>
      </div>
    </body>
  </html>
`;

const EIFFEL_SEARCH_HTML = `
  <html>
    <body>
      <h1 id="content-title">MineCraft Objects Database</h1>
      <div class="products row-size-4">
        <div class="product-box item-1">
          <div class="product-image">
            <a href="/minecraft/eiffel-tower/sightseeing-buildings" class="image" title="Eiffel Tower">
              <img src="https://www.grabcraft.com/files/products/thumb/thumb_eiffel-tower.png" alt="Eiffel Tower" />
            </a>
          </div>
          <div class="text-info">
            <h3 class="name"><a href="/minecraft/eiffel-tower/sightseeing-buildings" title="Eiffel Tower">Eiffel Tower</a></h3>
            <div class="product-description">The iconic Paris landmark in France.</div>
            <div class="price">
              <div class="regular-price"><b><i class="fa fa-cubes"></i>&nbsp;Block count:&nbsp;18740</b></div>
            </div>
            <a href="/minecraft/eiffel-tower/sightseeing-buildings#general" class="button more-info details">Details</a>
            <a href="/minecraft/eiffel-tower/sightseeing-buildings#blueprints" class="button more-info blueprints">Blueprints</a>
          </div>
        </div>
      </div>
    </body>
  </html>
`;

function testSpec(id: string, name: string, culture: string, keywords: string[]) {
  return normalizeLandmarkSpec({
    schemaVersion: '1.0',
    id,
    name,
    culture,
    keywords,
    defaultStyle: 'default',
    styles: {
      default: {
        primary: 'minecraft:stone',
        secondary: 'minecraft:stone',
        accent: 'minecraft:stone',
        detail: 'minecraft:stone',
        roof: 'minecraft:stone',
        path: 'minecraft:stone',
        glass: 'minecraft:glass'
      }
    },
    components: [
      {
        id: 'base',
        label: 'Base',
        role: 'foundation',
        primaryTool: 'fill-region',
        offsetX: 0,
        offsetZ: 0,
        offsetY: 0,
        width: 5,
        depth: 5,
        height: 5,
        materialKey: 'primary',
        blockBudget: 125
      }
    ]
  });
}

test('GrabCraft lookup expands a broad USA prompt into usable queries and maps Chrysler result to local spec', async (t) => {
  const service = new GrabCraftLookupService({
    fetchText: async (url: string) => {
      if (url.includes('chrysler%20building')) {
        return CHRYSLER_SEARCH_HTML;
      }
      return EMPTY_CATALOG_HTML;
    }
  });

  const result = await service.lookupLandmarks({
    prompt: 'Build a famous USA structure',
    cultureHint: 'usa',
    specs: [testSpec('chrysler_building_us', 'Chrysler Building', 'us', ['chrysler', 'new york'])],
    limit: 5
  });

  t.true(result.queries.includes('chrysler building'));
  t.truthy(result.selected);
  t.is(result.selected?.title, 'NY Chrysler Building');
  t.is(result.selected?.mappedSpecId, 'chrysler_building_us');
});

test('GrabCraft lookup returns no selected candidate when every site query is empty', async (t) => {
  const service = new GrabCraftLookupService({
    fetchText: async () => EMPTY_CATALOG_HTML
  });

  const result = await service.lookupLandmarks({
    prompt: 'Build a famous USA structure',
    cultureHint: 'usa',
    specs: [testSpec('chrysler_building_us', 'Chrysler Building', 'us', ['chrysler'])],
    limit: 3
  });

  t.deepEqual(result.candidates, []);
  t.is(result.selected, undefined);
});

test('GrabCraft lookup expands a broad French prompt into Eiffel and maps it to the active French spec', async (t) => {
  const service = new GrabCraftLookupService({
    fetchText: async (url: string) => {
      if (url.includes('eiffel%20tower')) {
        return EIFFEL_SEARCH_HTML;
      }
      return EMPTY_CATALOG_HTML;
    }
  });

  const result = await service.lookupLandmarks({
    prompt: 'Build a famous French structure',
    cultureHint: 'france',
    specs: [testSpec('eiffel_tower_fr', 'Eiffel Tower', 'fr', ['eiffel', 'tower', 'france'])],
    limit: 5
  });

  t.true(result.queries.includes('eiffel tower'));
  t.truthy(result.selected);
  t.is(result.selected?.title, 'Eiffel Tower');
  t.is(result.selected?.mappedSpecId, 'eiffel_tower_fr');
});
