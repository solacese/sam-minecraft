import test from 'ava';
import {
  flattenRenderObject,
  parseCatalogCatalogPage,
  parseCatalogObjectPage
} from '../src/catalog-import.js';

test('parseCatalogObjectPage extracts object metadata from page HTML', (t) => {
  const html = `
    <html>
      <head>
        <title>Arc de Triomphe, Paris - Catalog</title>
      </head>
      <body>
        <h1 id="content-title">Arc de Triomphe, Paris</h1>
        <table>
          <tr><td class="parameter">Block Count</td><td class="value block_count">11957</td></tr>
        </table>
        <script src="https://models.example.invalid/js/RenderObject/myRenderObject_1788.js"></script>
        <script>
          var dimY = 51;
          var dimX = 49;
          var dimZ = 25;
          var base_url = "https://blueprints.example.invalid/1788/Y/combined/";
          var totalPositions = 51;
        </script>
        <script src="https://models.example.invalid/js/LayerMap/LayerMap_1555.js"></script>
      </body>
    </html>
  `;

  const parsed = parseCatalogObjectPage(
    html,
    'https://models.example.invalid/minecraft/arc-de-triomphe-paris/sightseeing-buildings'
  );

  t.is(parsed.title, 'Arc de Triomphe, Paris');
  t.is(parsed.blockCount, 11957);
  t.deepEqual(parsed.dimensions, { x: 49, y: 51, z: 25 });
  t.is(
    parsed.renderObjectScriptUrl,
    'https://models.example.invalid/js/RenderObject/myRenderObject_1788.js'
  );
  t.is(
    parsed.layerMapScriptUrl,
    'https://models.example.invalid/js/LayerMap/LayerMap_1555.js'
  );
  t.is(parsed.blueprintBaseUrl, 'https://blueprints.example.invalid/1788/Y/combined/');
  t.is(parsed.blueprintLayerCount, 51);
});

test('parseCatalogCatalogPage extracts current page items', (t) => {
  const html = `
    <html>
      <body>
        <h1 id="content-title">Sightseeing buildings</h1>
        <div class="products row-size-4">
          <div class="product-box item-1">
            <div class="product-image">
              <a href="/minecraft/tauren-totem/towers" class="image" title="Tauren Totem">
                <img src="https://models.example.invalid/files/products/thumb/thumb_tauren-totem-22304.png" alt="Tauren Totem" />
              </a>
            </div>
            <div class="text-info">
              <h3 class="name"><a href="/minecraft/tauren-totem/towers" title="Tauren Totem">Tauren Totem</a></h3>
              <div class="product-description">A tall totem sample.</div>
              <div class="price">
                <div class="regular-price"><b><i class="fa fa-cubes"></i>&nbsp;Block count:&nbsp;8004</b></div>
              </div>
              <a href="/minecraft/tauren-totem/towers#general" class="button more-info details">Details</a>
              <a href="/minecraft/tauren-totem/towers#blueprints" class="button more-info blueprints">Blueprints</a>
            </div>
          </div>
          <div class="product-box item-2">
            <div class="product-image">
              <a href="/minecraft/stone-obelisk-m/miscellaneous-162" class="image" title="Stone Obelisk M">
                <img src="https://models.example.invalid/files/products/thumb/thumb_stone-obelisk-m-22291.png" alt="Stone Obelisk M" />
              </a>
            </div>
            <div class="text-info">
              <h3 class="name"><a href="/minecraft/stone-obelisk-m/miscellaneous-162" title="Stone Obelisk M">Stone Obelisk M</a></h3>
              <div class="product-description">Medium obelisk sample.</div>
              <div class="price">
                <div class="regular-price"><b><i class="fa fa-cubes"></i>&nbsp;Block count:&nbsp;2094</b></div>
              </div>
              <a href="/minecraft/stone-obelisk-m/miscellaneous-162#general" class="button more-info details">Details</a>
              <a href="/minecraft/stone-obelisk-m/miscellaneous-162#blueprints" class="button more-info blueprints">Blueprints</a>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;

  const parsed = parseCatalogCatalogPage(html, 'https://models.example.invalid/minecraft/sightseeing-buildings');

  t.is(parsed.source.title, 'Sightseeing buildings');
  t.is(parsed.stats.itemsOnPage, 2);
  t.is(parsed.items[0].title, 'Tauren Totem');
  t.is(parsed.items[0].blockCount, 8004);
  t.is(parsed.items[1].title, 'Stone Obelisk M');
  t.is(parsed.items[1].blockCount, 2094);
});

test('flattenRenderObject creates compact block, palette, and bounds summaries', (t) => {
  const flattened = flattenRenderObject({
    '1': {
      '1': {
        '1': {
          x: 1,
          y: '1',
          z: '1',
          name: 'Stone',
          mat_id: '1',
          transparent: false,
          opacity: 1,
          texture: '1_0.png',
          hex: '#aaaaaa',
          rgb: [170, 170, 170]
        },
        '2': {
          x: 1,
          y: '1',
          z: '2',
          name: 'Stone',
          mat_id: '1',
          transparent: false,
          opacity: 1,
          texture: '1_0.png',
          hex: '#aaaaaa',
          rgb: [170, 170, 170]
        }
      }
    },
    '2': {
      '2': {
        '3': {
          x: 2,
          y: '2',
          z: '3',
          name: 'Glass',
          mat_id: '20',
          transparent: true,
          opacity: 0.5,
          texture: '20_0.png',
          hex: '#ffffff',
          rgb: [255, 255, 255]
        }
      }
    }
  });

  t.is(flattened.blocks.length, 3);
  t.is(flattened.palette.length, 2);
  t.deepEqual(flattened.bounds, {
    minX: 1,
    maxX: 2,
    minY: 1,
    maxY: 2,
    minZ: 1,
    maxZ: 3
  });
  t.is(flattened.layers.length, 2);
  t.is(flattened.layers[0].blockCount, 2);
  t.is(flattened.layers[1].blockCount, 1);
});
