export interface AdsbAircraft {
  hex: string;
  callsign: string;
  aircraftType: string;
  latitude: number;
  longitude: number;
  altitude: number;
  positionAgeSeconds: number;
  groundSpeed: number;
  heading: number;
  verticalSpeed: number;
}

export interface AdsbSnapshot {
  sequence: number;
  aircraft: AdsbAircraft[];
}

export const MAX_ADSB_AIRCRAFT = 48; // Maximum number of ADSB aircraft to track
export const ADSB_POLL_INTERVAL_MS = 2_000; // Poll interval for ADSB data in milliseconds
export const ADSB_TRACK_TTL_MS = 45_000; // Time-to-live for ADSB tracks in milliseconds

const ADSB_API_RADIUS_KM = 100; // Radius for ADSB API queries in kilometers
const MAX_ADSB_POSITION_AGE_SECONDS = 60;  // Maximum age of ADSB position reports in seconds

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isAdsbAircraft(value: unknown): value is AdsbAircraft {
  if (!isRecord(value)) return false;
  return (
    typeof value.hex === 'string' &&
    /^~?[a-f0-9]{6,8}$/i.test(value.hex) &&
    typeof value.callsign === 'string' &&
    value.callsign.length <= 12 &&
    typeof value.aircraftType === 'string' &&
    value.aircraftType.length <= 8 &&
    typeof value.latitude === 'number' &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    typeof value.longitude === 'number' &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    typeof value.altitude === 'number' &&
    Number.isFinite(value.altitude) &&
    value.altitude >= -2000 &&
    value.altitude <= 100_000 &&
    typeof value.positionAgeSeconds === 'number' &&
    Number.isFinite(value.positionAgeSeconds) &&
    value.positionAgeSeconds >= 0 &&
    value.positionAgeSeconds <= MAX_ADSB_POSITION_AGE_SECONDS &&
    typeof value.groundSpeed === 'number' &&
    Number.isFinite(value.groundSpeed) &&
    value.groundSpeed >= 0 &&
    value.groundSpeed <= 1200 &&
    typeof value.heading === 'number' &&
    Number.isFinite(value.heading) &&
    value.heading >= 0 &&
    value.heading <= 360 &&
    typeof value.verticalSpeed === 'number' &&
    Number.isFinite(value.verticalSpeed) &&
    value.verticalSpeed >= -20_000 &&
    value.verticalSpeed <= 20_000
  );
}

function distanceSquaredFrom(
  aircraft: AdsbAircraft,
  latitude: number,
  longitude: number,
): number {
  const latitudeScale = Math.cos((latitude * Math.PI) / 180);
  const latitudeDelta = aircraft.latitude - latitude;
  const longitudeDelta = (aircraft.longitude - longitude) * latitudeScale;
  return latitudeDelta * latitudeDelta + longitudeDelta * longitudeDelta;
}

function parseAircraftList(
  value: unknown,
  centerLatitude: number,
  centerLongitude: number,
): AdsbAircraft[] {
  if (!isRecord(value) || !Array.isArray(value.ac)) {
    throw new Error('FlyItalyADSB returned an unexpected aircraft list.');
  }

  const aircraftByHex = new Map<string, AdsbAircraft>();
  for (const record of value.ac) {
    if (!isRecord(record)) continue;
    const hex = typeof record.hex === 'string' ? record.hex.trim().toLowerCase() : '';
    const latitude = getFiniteNumber(record.lat);
    const longitude = getFiniteNumber(record.lon);
    const altitude =
      getFiniteNumber(record.alt_baro) ?? getFiniteNumber(record.alt_geom);
    const seenPosition = getFiniteNumber(record.seen_pos);
    if (
      !/^~?[a-f0-9]{6,8}$/i.test(hex) ||
      latitude === null ||
      latitude < -90 ||
      latitude > 90 ||
      longitude === null ||
      longitude < -180 ||
      longitude > 180 ||
      altitude === null ||
      altitude < -2000 ||
      altitude > 100_000 ||
      record.alt_baro === 'ground' ||
      (seenPosition !== null && seenPosition > MAX_ADSB_POSITION_AGE_SECONDS)
    ) {
      continue;
    }

    const aircraft: AdsbAircraft = {
      hex,
      callsign:
        typeof record.flight === 'string' && record.flight.trim()
          ? record.flight.trim().slice(0, 12)
          : hex,
      aircraftType:
        typeof record.t === 'string' && record.t.trim()
          ? record.t.trim().slice(0, 8)
          : 'UNK',
      latitude,
      longitude,
      altitude,
      positionAgeSeconds: Math.max(0, seenPosition ?? 0),
      groundSpeed: Math.min(1200, Math.max(0, getFiniteNumber(record.gs) ?? 0)),
      heading: ((getFiniteNumber(record.track) ?? 0) % 360 + 360) % 360,
      verticalSpeed: Math.min(
        20_000,
        Math.max(-20_000, getFiniteNumber(record.baro_rate) ?? 0),
      ),
    };
    aircraftByHex.set(hex, aircraft);
  }

  return Array.from(aircraftByHex.values())
    .sort(
      (left, right) =>
        distanceSquaredFrom(left, centerLatitude, centerLongitude) -
        distanceSquaredFrom(right, centerLatitude, centerLongitude),
    )
    .slice(0, MAX_ADSB_AIRCRAFT);
}

export async function fetchAdsbAircraft(
  latitude: number,
  longitude: number,
  apiKey: string,
  signal: AbortSignal,
): Promise<AdsbAircraft[]> {
  const key = apiKey.trim();
  if (!key) throw new Error('Enter a FlyItalyADSB API key to enable live traffic.');

  const url =
    `https://api.flyitalyadsb.com/v2/lat/${latitude.toFixed(4)}` +
    `/lon/${longitude.toFixed(4)}/dist/${ADSB_API_RADIUS_KM}`;
  const response = await fetch(url, {
    headers: { 'X-Api-Key': key },
    credentials: 'omit',
    signal,
  });
  if (!response.ok) {
    throw new Error(`FlyItalyADSB request failed (HTTP ${response.status}).`);
  }

  const payload: unknown = await response.json();
  return parseAircraftList(payload, latitude, longitude);
}

export function createAdsbSnapshotMessage(
  sequence: number,
  aircraft: AdsbAircraft[],
): string {
  return JSON.stringify({ type: 'adsb', sequence, aircraft });
}

export function parseAdsbSnapshotMessage(message: string): AdsbSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(message);
    if (
      !isRecord(parsed) ||
      parsed.type !== 'adsb' ||
      typeof parsed.sequence !== 'number' ||
      !Number.isSafeInteger(parsed.sequence) ||
      parsed.sequence < 0 ||
      !Array.isArray(parsed.aircraft) ||
      parsed.aircraft.length > MAX_ADSB_AIRCRAFT ||
      !parsed.aircraft.every(isAdsbAircraft)
    ) {
      return null;
    }

    const aircraft = parsed.aircraft;
    if (new Set(aircraft.map(contact => contact.hex)).size !== aircraft.length) return null;
    return { sequence: parsed.sequence, aircraft };
  } catch {
    return null;
  }
}
