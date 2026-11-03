const TERRAIN_ZOOM = 12;
const TILE_SIZE = 256;
const TILE_RADIUS = 1;
const EARTH_RADIUS_METERS = 6_378_137;
const FEET_PER_METER = 3.28084;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const MAX_CACHED_TILES = 32;

export interface TerrainOrigin {
  latitude: number;
  longitude: number;
}

export interface TerrainGrid {
  heightsMeters: Float32Array;
  width: number;
  height: number;
  spacingXFeet: number;
  spacingZFeet: number;
  originXFeet: number;
  originZFeet: number;
}

interface TileAddress {
  x: number;
  y: number;
}

interface TerrainTile {
  elevations: Float32Array;
}

const tileCache = new Map<string, Promise<TerrainTile>>();

function clampLatitude(latitude: number): number {
  return Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
}

function normalizeLongitude(longitude: number): number {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

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

function getAircraftCoordinates(
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

function tileKey(address: TileAddress): string {
  return `${TERRAIN_ZOOM}/${address.x}/${address.y}`;
}

export function getTerrainNeighborhoodKey(
  origin: TerrainOrigin,
  posXFeet: number,
  posZFeet: number,
): string {
  const aircraft = getAircraftCoordinates(origin, posXFeet, posZFeet);
  const address = getTileAddress(aircraft.latitude, aircraft.longitude);
  const tileCount = 2 ** TERRAIN_ZOOM;
  // Keep the 3x3 neighborhood valid at the north and south edges of Web Mercator.
  address.y = Math.max(TILE_RADIUS, Math.min(tileCount - TILE_RADIUS - 1, address.y));
  return tileKey(address);
}

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

function longitudeAtPixel(pixelX: number): number {
  const worldPixels = TILE_SIZE * 2 ** TERRAIN_ZOOM;
  return (pixelX / worldPixels) * 360 - 180;
}

function latitudeAtPixel(pixelY: number): number {
  const worldPixels = TILE_SIZE * 2 ** TERRAIN_ZOOM;
  const mercatorY = Math.PI * (1 - (2 * pixelY) / worldPixels);
  return (Math.atan(Math.sinh(mercatorY)) * 180) / Math.PI;
}

function localXFeet(longitude: number, origin: TerrainOrigin): number {
  const longitudeDelta = normalizeLongitude(longitude - origin.longitude);
  return (
    (longitudeDelta * Math.PI / 180) *
    EARTH_RADIUS_METERS *
    Math.cos((origin.latitude * Math.PI) / 180) *
    FEET_PER_METER
  );
}

function localZFeet(latitude: number, origin: TerrainOrigin): number {
  return (
    -((latitude - origin.latitude) * Math.PI / 180) *
    EARTH_RADIUS_METERS *
    FEET_PER_METER
  );
}

export async function loadTerrainGrid(
  origin: TerrainOrigin,
  posXFeet: number,
  posZFeet: number,
): Promise<TerrainGrid> {
  const aircraft = getAircraftCoordinates(origin, posXFeet, posZFeet);
  const center = getTileAddress(aircraft.latitude, aircraft.longitude);
  const tileCount = 2 ** TERRAIN_ZOOM;
  center.y = Math.max(TILE_RADIUS, Math.min(tileCount - TILE_RADIUS - 1, center.y));

  const firstTileX = center.x - TILE_RADIUS;
  const firstTileY = center.y - TILE_RADIUS;
  const tiles = await Promise.all(
    Array.from({ length: TILE_RADIUS * 2 + 1 }, (_, row) =>
      Promise.all(
        Array.from({ length: TILE_RADIUS * 2 + 1 }, (_, column) => {
          const x = ((firstTileX + column) % tileCount + tileCount) % tileCount;
          return loadTile({ x, y: firstTileY + row });
        }),
      ),
    ),
  );

  const width = TILE_SIZE * (TILE_RADIUS * 2 + 1);
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

  return { heightsMeters, width, height, spacingXFeet, spacingZFeet, originXFeet, originZFeet };
}
