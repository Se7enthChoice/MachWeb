export type WeatherPreset = 'sun' | 'rain' | 'snow' | 'storm' | 'real';
export type WeatherKind = 'sun' | 'cloudy' | 'rain' | 'snow' | 'storm';

export interface WeatherState {
  kind: WeatherKind;
  label: string;
  windEastKnots: number;
  windNorthKnots: number;
  cloudCoverPercent: number;
  cloudBaseFeet: number;
  cloudTopFeet: number;
  rainMillimetersPerHour: number;
  snowCentimetersPerHour: number;
  precipitationDensity: number;
  visibilityMeters: number | null;
  lightning: boolean;
}

const METERS_TO_FEET = 3.28084;

function getPrecipitationDensity(amount: number, fullDensityAt: number): number {
  if (amount <= 0) return 0;
  return Math.min(1, Math.max(0.15, Math.sqrt(amount / fullDensityAt)));
}

export function createPresetWeather(preset: Exclude<WeatherPreset, 'real'>): WeatherState {
  if (preset === 'rain') {
    return {
      kind: 'rain',
      label: 'Rain preset',
      windEastKnots: 0,
      windNorthKnots: 8,
      cloudCoverPercent: 95,
      cloudBaseFeet: 2400,
      cloudTopFeet: 9000,
      rainMillimetersPerHour: 2,
      snowCentimetersPerHour: 0,
      precipitationDensity: 0.5,
      visibilityMeters: 5000,
      lightning: false,
    };
  }

  if (preset === 'snow') {
    return {
      kind: 'snow',
      label: 'Snow preset',
      windEastKnots: -2,
      windNorthKnots: 4,
      cloudCoverPercent: 95,
      cloudBaseFeet: 2500,
      cloudTopFeet: 12000,
      rainMillimetersPerHour: 0,
      snowCentimetersPerHour: 0.4,
      precipitationDensity: getPrecipitationDensity(0.4, 1.2),
      visibilityMeters: 3500,
      lightning: false,
    };
  }

  if (preset === 'storm') {
    return {
      kind: 'storm',
      label: 'Lightning storm preset',
      windEastKnots: -18,
      windNorthKnots: 22,
      cloudCoverPercent: 100,
      cloudBaseFeet: 1400,
      cloudTopFeet: 32000,
      rainMillimetersPerHour: 8,
      snowCentimetersPerHour: 0,
      precipitationDensity: 1,
      visibilityMeters: 1800,
      lightning: true,
    };
  }

  return {
    kind: 'sun',
    label: 'Sunny preset',
    windEastKnots: 0,
    windNorthKnots: 0,
    cloudCoverPercent: 5,
    cloudBaseFeet: 10000,
    cloudTopFeet: 12000,
    rainMillimetersPerHour: 0,
    snowCentimetersPerHour: 0,
    precipitationDensity: 0,
    visibilityMeters: null,
    lightning: false,
  };
}

export function createRealWeatherLoadingState(): WeatherState {
  return {
    ...createPresetWeather('sun'),
    kind: 'cloudy',
    label: 'REAL weather loading',
    cloudCoverPercent: 25,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Open-Meteo did not return a valid ${key} value.`);
  }
  return value;
}

function getCloudLayerAltitude(
  response: Record<string, unknown>,
  currentTime: string,
  field: 'cloud_base' | 'cloud_top',
): number | null {
  const hourly = response.hourly;
  if (!isRecord(hourly)) return null;
  const times = hourly.time;
  const values = hourly[field];
  if (!Array.isArray(times) || !Array.isArray(values)) return null;

  let closestIndex = -1;
  let closestDistance = Number.POSITIVE_INFINITY;
  const requestedTime = Date.parse(currentTime);
  times.forEach((time, index) => {
    if (typeof time !== 'string' || typeof values[index] !== 'number') return;
    const distance = Math.abs(Date.parse(time) - requestedTime);
    if (Number.isFinite(distance) && distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });

  const altitude = closestIndex >= 0 ? values[closestIndex] : null;
  return typeof altitude === 'number' && Number.isFinite(altitude) && altitude >= 0
    ? altitude * METERS_TO_FEET
    : null;
}

function estimateCloudBaseFeet(temperatureC: number, humidityPercent: number): number {
  const humidity = Math.max(1, Math.min(humidityPercent, 100)) / 100;
  const gamma = Math.log(humidity) + (17.625 * temperatureC) / (243.04 + temperatureC);
  const dewPointC = (243.04 * gamma) / (17.625 - gamma);
  return Math.max(500, (temperatureC - dewPointC) * 400);
}

function getWeatherKind(code: number, rain: number, snow: number): WeatherKind {
  if (code >= 95 && code <= 99) return 'storm';
  if (snow > 0 || (code >= 71 && code <= 86)) return 'snow';
  if (rain > 0 || (code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 1 && code <= 3) || (code >= 45 && code <= 48)) return 'cloudy';
  return 'sun';
}

export async function fetchCurrentWeather(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<WeatherState> {
  const query = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: [
      'temperature_2m',
      'relative_humidity_2m',
      'precipitation',
      'rain',
      'snowfall',
      'weather_code',
      'cloud_cover',
      'wind_speed_10m',
      'wind_direction_10m',
      'visibility',
    ].join(','),
    hourly: 'cloud_base,cloud_top',
    forecast_days: '1',
    timezone: 'auto',
    wind_speed_unit: 'kn',
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, { signal });
  if (!response.ok) {
    throw new Error(`Open-Meteo returned HTTP ${response.status}.`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload) || !isRecord(payload.current)) {
    throw new Error('Open-Meteo returned incomplete current conditions.');
  }

  const current = payload.current;
  const temperatureC = requiredNumber(current, 'temperature_2m');
  const humidity = requiredNumber(current, 'relative_humidity_2m');
  const rawRain = Math.max(
    0,
    finiteNumber(current.rain, finiteNumber(current.precipitation, 0)),
  );
  const rawSnow = Math.max(0, finiteNumber(current.snowfall, 0));
  const code = requiredNumber(current, 'weather_code');
  const windSpeed = Math.max(0, requiredNumber(current, 'wind_speed_10m'));
  const windDirection =
    requiredNumber(current, 'wind_direction_10m') * (Math.PI / 180);
  const kind = getWeatherKind(code, rawRain, rawSnow);
  const rain = kind === 'rain' || kind === 'storm'
    ? Math.max(rawRain, code >= 51 && code <= 82 ? 0.12 : 0)
    : 0;
  const snow = kind === 'snow' ? Math.max(rawSnow, 0.02) : 0;
  const precipitationDensity = kind === 'snow'
    ? getPrecipitationDensity(snow, 1.2)
    : getPrecipitationDensity(rain, 8);
  const estimatedBase = estimateCloudBaseFeet(temperatureC, humidity);
  const cloudBaseFeet =
    getCloudLayerAltitude(payload, String(current.time ?? ''), 'cloud_base') ?? estimatedBase;
  const cloudTopFeet =
    getCloudLayerAltitude(payload, String(current.time ?? ''), 'cloud_top') ??
    cloudBaseFeet + (kind === 'storm' ? 24000 : kind === 'rain' || kind === 'snow' ? 6500 : 3500);

  return {
    kind,
    label: `REAL · WMO ${Math.round(code)}`,
    windEastKnots: -windSpeed * Math.sin(windDirection),
    windNorthKnots: -windSpeed * Math.cos(windDirection),
    cloudCoverPercent: Math.max(
      0,
      Math.min(100, requiredNumber(current, 'cloud_cover')),
    ),
    cloudBaseFeet: Math.max(0, cloudBaseFeet),
    cloudTopFeet: Math.max(cloudBaseFeet + 300, cloudTopFeet),
    rainMillimetersPerHour: rain,
    snowCentimetersPerHour: snow,
    precipitationDensity,
    visibilityMeters:
      typeof current.visibility === 'number' && Number.isFinite(current.visibility)
        ? Math.max(50, current.visibility)
        : null,
    lightning: code >= 95 && code <= 99,
  };
}

