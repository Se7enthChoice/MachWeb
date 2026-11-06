const TERRAIN_ZOOM = 12; // Zoom level for terrain tiles (0-15)
const TILE_SIZE = 256; // 256x256 pixels per tile
const TILE_COLUMNS = 12; // Four times the original 3-tile terrain width.
const TILES_BEFORE_CENTER = Math.floor(TILE_COLUMNS / 2);
const TILES_AFTER_CENTER = TILE_COLUMNS - TILES_BEFORE_CENTER - 1;
const EARTH_RADIUS_METERS = 6_378_137;
const FEET_PER_METER = 3.28084;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const MAX_CACHED_TILES = 192;

export interface TerrainOrigin {
  latitude: number;
  longitude: number;
}

export interface TerrainGrid {
  heightsMeters: Float32Array;
  satelliteTiles: Array<{ x: number; y: number }>;
  tileSize: number;
  tileColumns: number;
  tileRows: number;
  width: number;
  height: number;
  spacingXFeet: number;
  spacingZFeet: number;
  originXFeet: number;
  originZFeet: number;
}

export interface TerrainTileCoordinate {
  x: number;
  y: number;
}

type TileAddress = TerrainTileCoordinate;

interface TerrainTile {
  elevations: Float32Array;
}

const tileCache = new Map<string, Promise<TerrainTile>>();

// Constrains latitude to the area represented by Web Mercator tiles.
function clampLatitude(latitude: number): number {
  return Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
}

// Wraps longitude into the standard [-180, 180) range.
function normalizeLongitude(longitude: number): number {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

// Converts geographic coordinates to a wrapped Web Mercator tile address.
function getTileAddress(latitude: number, longitude: number): TileAddress {
  const tileCount = 2 ** TERRAIN_ZOOM;
  const latitudeRadians = (clampLatitude(latitude) * Math.PI) / 180;
  const x = Math.floor(((normalizeLongitude(longitude) + 180) / 360) * tileCount);
  const y = Math.floor(
    ((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * tileCount,
  );

  return {
    x: ((x % tileCount) + tileCount) % tileCount,
    y: Math.max(0, Math.min(tileCount - 1, y)),
  };
}

// Converts simulator offsets in feet to geographic coordinates near the origin.
export function getAircraftCoordinates(
  origin: TerrainOrigin,
  posXFeet: number,
  posZFeet: number,
): TerrainOrigin {
  const originLatitudeRadians = (origin.latitude * Math.PI) / 180;
  const feetPerRadian = EARTH_RADIUS_METERS * FEET_PER_METER;

  return {
    latitude: origin.latitude - posZFeet / feetPerRadian * (180 / Math.PI),
    longitude: normalizeLongitude(
      origin.longitude +
        (posXFeet / (feetPerRadian * Math.cos(originLatitudeRadians))) * (180 / Math.PI),
    ),
  };
}

// Produces a zoom-qualified key shared by elevation and imagery tile requests.
function tileKey(address: TileAddress): string {
  return `${TERRAIN_ZOOM}/${address.x}/${address.y}`;
}

// Builds the satellite imagery URL for a tile in the current terrain grid.
export function getSatelliteTileUrl(tile: TerrainTileCoordinate): string {
  return `https://e.tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/${TERRAIN_ZOOM}/${tile.y}/${tile.x}.jpg`;
}

// Identifies when the aircraft has crossed into a different terrain neighborhood.
export function getTerrainNeighborhoodKey(
  origin: TerrainOrigin,
  posXFeet: number,
  posZFeet: number,
): string {
  const aircraft = getAircraftCoordinates(origin, posXFeet, posZFeet);
  const address = getTileAddress(aircraft.latitude, aircraft.longitude);
  const tileCount = 2 ** TERRAIN_ZOOM;
  // Keep the complete neighborhood valid at the north and south Web Mercator edges.
  address.y = Math.max(
    TILES_BEFORE_CENTER,
    Math.min(tileCount - TILES_AFTER_CENTER - 1, address.y),
  );
  return tileKey(address);
}

// Fetches and decodes one Terrarium PNG tile into meter elevation samples.
async function decodeTerrariumTile(address: TileAddress): Promise<TerrainTile> {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TERRAIN_ZOOM}/${address.x}/${address.y}.png`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Terrain tile request failed (${response.status}): ${url}`);
  }

  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement('canvas');
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Could not create a canvas context to decode terrain data.');
    }

    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let pixel = 0; pixel < elevations.length; pixel += 1) {
      const channel = pixel * 4;
      // Terrarium stores elevation as (R * 256 + G + B / 256) - 32768 meters.
      elevations[pixel] =
        pixels[channel] * 256 + pixels[channel + 1] + pixels[channel + 2] / 256 - 32768;
    }
    return { elevations };
  } finally {
    bitmap.close();
  }
}

// Loads a tile once, reuses in-flight requests, and evicts least-recently-used entries.
function loadTile(address: TileAddress): Promise<TerrainTile> {
  const key = tileKey(address);
  const cached = tileCache.get(key);
  if (cached) {
    // Refresh insertion order so recently used tiles stay in the small LRU cache.
    tileCache.delete(key);
    tileCache.set(key, cached);
    return cached;
  }

  const request = decodeTerrariumTile(address).catch(error => {
    if (tileCache.get(key) === request) tileCache.delete(key);
    throw error;
  });
  tileCache.set(key, request);
  if (tileCache.size > MAX_CACHED_TILES) {
    const oldestKey = tileCache.keys().next().value;
    if (oldestKey !== undefined) tileCache.delete(oldestKey);
  }
  return request;
}

// Converts a horizontal world-pixel coordinate to longitude.
function longitudeAtPixel(pixelX: number): number {
  const worldPixels = TILE_SIZE * 2 ** TERRAIN_ZOOM;
  return (pixelX / worldPixels) * 360 - 180;
}

// Converts a vertical Web Mercator pixel coordinate to latitude.
function latitudeAtPixel(pixelY: number): number {
  const worldPixels = TILE_SIZE * 2 ** TERRAIN_ZOOM;
  const mercatorY = Math.PI * (1 - (2 * pixelY) / worldPixels);
  return (Math.atan(Math.sinh(mercatorY)) * 180) / Math.PI;
}

// Maps longitude to local east/west simulator feet relative to the origin.
function localXFeet(longitude: number, origin: TerrainOrigin): number {
  const longitudeDelta = normalizeLongitude(longitude - origin.longitude);
  return (
    (longitudeDelta * Math.PI / 180) *
    EARTH_RADIUS_METERS *
    Math.cos((origin.latitude * Math.PI) / 180) *
    FEET_PER_METER
  );
}

// Maps latitude to local north/south simulator feet; positive Z points south.
function localZFeet(latitude: number, origin: TerrainOrigin): number {
  return (
    -((latitude - origin.latitude) * Math.PI / 180) *
    EARTH_RADIUS_METERS *
    FEET_PER_METER
  );
}

// Converts geographic coordinates to the simulator's local horizontal axes.
export function getLocalPosition(
  origin: TerrainOrigin,
  coordinates: TerrainOrigin,
): { posXFeet: number; posZFeet: number } {
  return {
    posXFeet: localXFeet(coordinates.longitude, origin),
    posZFeet: localZFeet(coordinates.latitude, origin),
  };
}

// Loads a square tile neighborhood and assembles its elevation samples and grid metadata.
export async function loadTerrainGrid(
  origin: TerrainOrigin,
  posXFeet: number,
  posZFeet: number,
): Promise<TerrainGrid> {
  const aircraft = getAircraftCoordinates(origin, posXFeet, posZFeet);
  const center = getTileAddress(aircraft.latitude, aircraft.longitude);
  const tileCount = 2 ** TERRAIN_ZOOM;
  center.y = Math.max(
    TILES_BEFORE_CENTER,
    Math.min(tileCount - TILES_AFTER_CENTER - 1, center.y),
  );

  const firstTileX = center.x - TILES_BEFORE_CENTER;
  const firstTileY = center.y - TILES_BEFORE_CENTER;
  const satelliteTiles: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < TILE_COLUMNS; row += 1) {
    for (let column = 0; column < TILE_COLUMNS; column += 1) {
      satelliteTiles.push({
        x: ((firstTileX + column) % tileCount + tileCount) % tileCount,
        y: firstTileY + row,
      });
    }
  }

  const tiles = await Promise.all(
    Array.from({ length: TILE_COLUMNS }, (_, row) =>
      Promise.all(
        Array.from({ length: TILE_COLUMNS }, (_, column) => {
          const x = ((firstTileX + column) % tileCount + tileCount) % tileCount;
          return loadTile({ x, y: firstTileY + row });
        }),
      ),
    ),
  );

  const width = TILE_SIZE * TILE_COLUMNS;
  const height = width;
  const heightsMeters = new Float32Array(width * height);
  for (let tileRow = 0; tileRow < tiles.length; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < tiles[tileRow].length; tileColumn += 1) {
      const tile = tiles[tileRow][tileColumn];
      for (let row = 0; row < TILE_SIZE; row += 1) {
        const sourceStart = row * TILE_SIZE;
        const targetStart = (tileRow * TILE_SIZE + row) * width + tileColumn * TILE_SIZE;
        heightsMeters.set(
          tile.elevations.subarray(sourceStart, sourceStart + TILE_SIZE),
          targetStart,
        );
      }
    }
  }

  // Local coordinates use feet, with positive Z pointing south just like the simulator.
  const firstPixelX = firstTileX * TILE_SIZE + 0.5;
  const firstPixelY = firstTileY * TILE_SIZE + 0.5;
  const lastPixelY = (firstTileY + tiles.length) * TILE_SIZE - 0.5;
  const originXFeet = localXFeet(longitudeAtPixel(firstPixelX), origin);
  const originZFeet = localZFeet(latitudeAtPixel(firstPixelY), origin);
  const spacingXFeet =
    ((2 * Math.PI * EARTH_RADIUS_METERS * Math.cos((origin.latitude * Math.PI) / 180)) /
      (tileCount * TILE_SIZE)) *
    FEET_PER_METER;
  const spacingZFeet =
    (localZFeet(latitudeAtPixel(lastPixelY), origin) - originZFeet) / (height - 1);

  return {
    heightsMeters,
    satelliteTiles,
    tileSize: TILE_SIZE,
    tileColumns: TILE_COLUMNS,
    tileRows: TILE_COLUMNS,
    width,
    height,
    spacingXFeet,
    spacingZFeet,
    originXFeet,
    originZFeet,
  };
}
