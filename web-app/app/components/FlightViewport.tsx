'use client';

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import * as THREE from 'three';
import { getAircraftCoordinates, getLocalPosition, getSatelliteTileUrl } from '../terrain';
import type { TerrainGrid, TerrainOrigin } from '../terrain';
import { ADSB_POLL_INTERVAL_MS, ADSB_TRACK_TTL_MS } from '../adsb';
import type { FlightTelemetry, MissileTelemetry } from '../webrtc';
import type { WeatherState } from '../weather';
import RadarScope from './RadarScope';
import type { RadarContact } from './RadarScope';
import RadarWarningReceiver from './RadarWarningReceiver';
import type { RadarWarningContact } from './RadarWarningReceiver';

interface FlightViewportProps {
  posX: number;
  posZ: number;
  altitude: number;
  pitch: number;
  roll: number;
  throttle: number;
  verticalSpeed: number;
  heading: number;
  airspeed: number;
  crashed: boolean;
  localPlayerId: string;
  localMissilesRef: RefObject<MissileTelemetry[]>;
  radarEnabled: boolean;
  remoteTelemetries: FlightTelemetry[];
  radarContacts: RadarContact[];
  radarWarnings: RadarWarningContact[];
  radarScanAzimuth: number;
  radarScanBar: number;
  primaryTargetId: number | null;
  terrainOrigin: TerrainOrigin;
  terrainGrid: TerrainGrid | null;
  terrainStatus: string;
  weather: WeatherState;
  simulationTimeMinutes: number;
}

interface RemoteAircraftSample {
  receivedAt: number;
  telemetry: FlightTelemetry;
  posXFeet: number;
  posZFeet: number;
}

interface RemoteAircraftInstance {
  aircraft: THREE.Group;
  lights: THREE.Group;
  samples: RemoteAircraftSample[];
  lastSequence: number;
  lastArrivalIntervalMs: number | null;
  interarrivalJitterMs: number;
}

interface ExplosionEffect {
  group: THREE.Group;
  particles: THREE.Points;
  positions: Float32Array;
  velocities: Float32Array;
  startedAt: number;
}

interface MissileVisualSample {
  position: THREE.Vector3;
  heading: number;
  pitch: number;
  receivedAt: number;
}

interface MissileVisualInstance {
  model: THREE.Group;
  samples: MissileVisualSample[];
  locallySimulated: boolean;
}

interface AircraftDimensionsFeet {
  lengthFeet: number;
  wingspanFeet: number;
  heightFeet: number;
}

const visualScale = 0.01;
const feetPerMeter = 3.28084;
// Approximate extents of the shared mesh before applying aircraft-specific dimensions.
const REMOTE_AIRCRAFT_BASE_DIMENSIONS: AircraftDimensionsFeet = {
  lengthFeet: 100,
  wingspanFeet: 97,
  heightFeet: 14,
};
const TORNADO_DIMENSIONS: AircraftDimensionsFeet = {
  lengthFeet: 55,
  wingspanFeet: 46,
  heightFeet: 20,
};
const BOEING_767_DIMENSIONS: AircraftDimensionsFeet = {
  lengthFeet: 180,
  wingspanFeet: 156,
  heightFeet: 52,
};
const REMOTE_INTERPOLATION_BASE_DELAY_MS = 120;
const REMOTE_INTERPOLATION_MAX_DELAY_MS = 250;
const ADSB_INTERPOLATION_DELAY_MS = ADSB_POLL_INTERVAL_MS * 1.25;
const ADSB_VISUAL_SMOOTHING_SECONDS = 0.35;
const REMOTE_MISSILE_INTERPOLATION_DELAY_MS = 50;
const MAX_MISSILE_EXTRAPOLATION_MS = 200;
const MISSILE_VISUAL_SMOOTHING_SECONDS = 0.035;
const MAX_REMOTE_SAMPLES = 20;
const REMOTE_AIRCRAFT_COLORS = [0x38bdf8, 0xfbbf24, 0xf472b6, 0xa3e635, 0xc084fc];
const TERRAIN_MESH_SEGMENTS = 64;
const TERRAIN_MESHES_PER_FRAME = 4;
const TERRAIN_TEXTURES_PER_FRAME = 4;
const MAX_CONCURRENT_IMAGERY_REQUESTS = 8;
const CLOUD_VOLUME_TILE_SIZE = 1000;
const CLOUD_VOLUME_HALF_SIZE = 1800;
const CLOUD_NOISE_SIZE = 32;
const CLOUD_RAYMARCH_STEPS = 48;
const CLOUD_MIN_BASE_FEET = 10000;
const PRECIPITATION_PARTICLE_COUNT = 1500;
const RAIN_STREAK_LENGTH = 6;
const VISIBILITY_FOG_SCALE = 1.5;
const CELESTIAL_DISTANCE = 1800;
const LIGHT_DISTANCE = 1600;
const FOG_NEAR = 300;
const FOG_FAR = 1100;
const NIGHT_SKY = new THREE.Color(0x071225);
const TWILIGHT_SKY = new THREE.Color(0xe59a72);
const DAY_SKY = new THREE.Color(0x79b9dc);
const NIGHT_LIGHT = new THREE.Color(0x536b9a);
const DAY_LIGHT = new THREE.Color(0xfff0d7);
const terrainColors = [
  new THREE.Color(0x285267),
  new THREE.Color(0x3e6844),
  new THREE.Color(0x697044),
  new THREE.Color(0x82735a),
  new THREE.Color(0x9b9587),
  new THREE.Color(0xd7d8d1),
];
const EXPLOSION_PARTICLE_COUNT = 32;
const EXPLOSION_DURATION_MS = 1500;

function createSnowflakeTexture(): THREE.DataTexture {
  const size = 16;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size * 0.42;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const alpha = THREE.MathUtils.clamp((radius - distance) * 2, 0, 1);
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function cloudHash(x: number, y: number, z: number, period: number, seed: number): number {
  const wrap = (value: number) => THREE.MathUtils.euclideanModulo(value, period);
  let hash =
    Math.imul(wrap(x) + seed, 374761393) ^
    Math.imul(wrap(y) + seed, 668265263) ^
    Math.imul(wrap(z) + seed, 2147483647);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967295;
}

function cloudValueNoise(x: number, y: number, z: number, frequency: number): number {
  const sampleX = x * frequency;
  const sampleY = y * frequency;
  const sampleZ = z * frequency;
  const baseX = Math.floor(sampleX);
  const baseY = Math.floor(sampleY);
  const baseZ = Math.floor(sampleZ);
  const smooth = (value: number) => value * value * (3 - 2 * value);
  const fractionX = smooth(sampleX - baseX);
  const fractionY = smooth(sampleY - baseY);
  const fractionZ = smooth(sampleZ - baseZ);
  const sample = (offsetX: number, offsetY: number, offsetZ: number) =>
    cloudHash(baseX + offsetX, baseY + offsetY, baseZ + offsetZ, frequency, 17);
  const mix = (start: number, end: number, amount: number) =>
    start + (end - start) * amount;
  const lower = mix(
    mix(sample(0, 0, 0), sample(1, 0, 0), fractionX),
    mix(sample(0, 1, 0), sample(1, 1, 0), fractionX),
    fractionY,
  );
  const upper = mix(
    mix(sample(0, 0, 1), sample(1, 0, 1), fractionX),
    mix(sample(0, 1, 1), sample(1, 1, 1), fractionX),
    fractionY,
  );
  return mix(lower, upper, fractionZ);
}

function createCloudNoiseTexture(): THREE.Data3DTexture {
  const size = CLOUD_NOISE_SIZE;
  const data = new Uint8Array(size * size * size * 4);
  const worleyFrequency = 4;

  for (let z = 0; z < size; z += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const normalizedX = x / size;
        const normalizedY = y / size;
        const normalizedZ = z / size;
        const cellX = normalizedX * worleyFrequency;
        const cellY = normalizedY * worleyFrequency;
        const cellZ = normalizedZ * worleyFrequency;
        const baseX = Math.floor(cellX);
        const baseY = Math.floor(cellY);
        const baseZ = Math.floor(cellZ);
        let nearestFeature = Number.POSITIVE_INFINITY;

        for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
              const featureCellX = baseX + offsetX;
              const featureCellY = baseY + offsetY;
              const featureCellZ = baseZ + offsetZ;
              const wrappedX = THREE.MathUtils.euclideanModulo(featureCellX, worleyFrequency);
              const wrappedY = THREE.MathUtils.euclideanModulo(featureCellY, worleyFrequency);
              const wrappedZ = THREE.MathUtils.euclideanModulo(featureCellZ, worleyFrequency);
              const featureX =
                featureCellX +
                cloudHash(wrappedX, wrappedY, wrappedZ, worleyFrequency, 29);
              const featureY =
                featureCellY +
                cloudHash(wrappedX, wrappedY, wrappedZ, worleyFrequency, 43);
              const featureZ =
                featureCellZ +
                cloudHash(wrappedX, wrappedY, wrappedZ, worleyFrequency, 71);
              const distance = Math.hypot(
                cellX - featureX,
                cellY - featureY,
                cellZ - featureZ,
              );
              nearestFeature = Math.min(nearestFeature, distance);
            }
          }
        }

        const perlin =
          cloudValueNoise(normalizedX, normalizedY, normalizedZ, 4) * 0.55 +
          cloudValueNoise(normalizedX, normalizedY, normalizedZ, 8) * 0.3 +
          cloudValueNoise(normalizedX, normalizedY, normalizedZ, 16) * 0.15;
        const worley = THREE.MathUtils.clamp(nearestFeature / 1.2, 0, 1);
        const offset = (z * size * size + y * size + x) * 4;
        data[offset] = Math.round((perlin * 0.65 + (1 - worley) * 0.35) * 255);
        data[offset + 1] = Math.round(
          cloudValueNoise(normalizedX, normalizedY, normalizedZ, 16) * 255,
        );
        data[offset + 2] = Math.round((1 - worley) * 255);
        data[offset + 3] = 255;
      }
    }
  }

  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

const CLOUD_VERTEX_SHADER = `
  out vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const CLOUD_FRAGMENT_SHADER = `
  precision highp float;
  precision highp sampler3D;

  uniform sampler3D uCloudNoise;
  uniform vec3 uBoxMin;
  uniform vec3 uBoxMax;
  uniform vec3 uNoiseScale;
  uniform vec3 uCloudColor;
  uniform vec3 uFogColor;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uAmbientColor;
  uniform float uCloudCoverage;
  uniform float uCloudBase;
  uniform float uCloudDepth;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uLightning;

  in vec3 vWorldPosition;
  out vec4 outColor;

  vec3 linearToSrgb(vec3 color) {
    vec3 lower = color * 12.92;
    vec3 higher = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(higher, lower, lessThanEqual(color, vec3(0.0031308)));
  }

  void main() {
    vec3 rayDirection = normalize(vWorldPosition - cameraPosition);
    vec3 safeDirection = vec3(
      abs(rayDirection.x) < 0.00001
        ? (rayDirection.x < 0.0 ? -0.00001 : 0.00001)
        : rayDirection.x,
      abs(rayDirection.y) < 0.00001
        ? (rayDirection.y < 0.0 ? -0.00001 : 0.00001)
        : rayDirection.y,
      abs(rayDirection.z) < 0.00001
        ? (rayDirection.z < 0.0 ? -0.00001 : 0.00001)
        : rayDirection.z
    );
    vec3 inverseDirection = 1.0 / safeDirection;
    vec3 firstIntersection = (uBoxMin - cameraPosition) * inverseDirection;
    vec3 secondIntersection = (uBoxMax - cameraPosition) * inverseDirection;
    vec3 nearIntersection = min(firstIntersection, secondIntersection);
    vec3 farIntersection = max(firstIntersection, secondIntersection);
    float rayStart = max(max(nearIntersection.x, nearIntersection.y), nearIntersection.z);
    float rayEnd = min(min(farIntersection.x, farIntersection.y), farIntersection.z);
    rayStart = max(rayStart, 0.0);
    rayEnd = min(rayEnd, uFogFar);
    if (rayEnd <= rayStart) discard;

    float stepLength = (rayEnd - rayStart) / float(${CLOUD_RAYMARCH_STEPS});
    float transmittance = 1.0;
    vec3 radiance = vec3(0.0);
    float coverageThreshold = mix(0.9, 0.52, uCloudCoverage);
    float phase = 0.35 + 0.65 * pow(
      max(dot(-rayDirection, normalize(uSunDirection)), 0.0),
      2.0
    );

    for (int stepIndex = 0; stepIndex < ${CLOUD_RAYMARCH_STEPS}; stepIndex++) {
      float distanceAlongRay = rayStart + (float(stepIndex) + 0.5) * stepLength;
      if (distanceAlongRay >= rayEnd || transmittance < 0.015) break;

      vec3 worldPosition = cameraPosition + rayDirection * distanceAlongRay;
      float heightFraction = (worldPosition.y - uCloudBase) / uCloudDepth;
      if (heightFraction <= 0.0 || heightFraction >= 1.0) continue;

      vec3 noisePosition = worldPosition * uNoiseScale;
      vec4 noise = texture(uCloudNoise, noisePosition);
      float detail = texture(uCloudNoise, noisePosition * 4.0).g;
      float shape = noise.r * 0.72 + noise.b * 0.28;
      float density = smoothstep(coverageThreshold, coverageThreshold + 0.22, shape);
      density = max(density - (detail - 0.5) * 0.22, 0.0);
      float baseFade = smoothstep(0.0, 0.06, heightFraction);
      float topFade = 1.0 - smoothstep(0.84, 1.0, heightFraction) * 0.75;
      density *= baseFade * topFade;
      if (density <= 0.005) continue;

      float lightTransmission = 1.0 - density * 0.28;
      float fogAmount = smoothstep(uFogNear, uFogFar, distanceAlongRay);
      vec3 lighting =
        uAmbientColor * 0.28 +
        uSunColor * phase * lightTransmission * 0.26;
      vec3 sampleColor = uCloudColor * lighting;
      sampleColor = mix(sampleColor, uFogColor, fogAmount * 0.85);
      sampleColor = mix(sampleColor, vec3(0.9), uLightning * 0.8);

      float sampleAlpha = 1.0 - exp(-density * stepLength * 0.005);
      radiance += transmittance * sampleColor * sampleAlpha;
      transmittance *= 1.0 - sampleAlpha;
    }

    float alpha = 1.0 - transmittance;
    if (alpha < 0.01) discard;
    outColor = vec4(linearToSrgb(radiance / alpha), alpha);
  }
`;

// Selects a fallback vertex color based on terrain elevation in meters.
function terrainColor(elevationMeters: number): THREE.Color {
  if (elevationMeters < 0) return terrainColors[0]; 
  if (elevationMeters < 300) return terrainColors[1];
  if (elevationMeters < 1000) return terrainColors[2];
  if (elevationMeters < 2000) return terrainColors[3];
  if (elevationMeters < 3500) return terrainColors[4];
  return terrainColors[5];
}

// Interpolates angles over the shortest path across the 0/360-degree boundary.
function interpolateAngle(start: number, end: number, amount: number): number {
  const delta = THREE.MathUtils.euclideanModulo(end - start + 180, 360) - 180;
  return start + delta * amount;
}

function smoothAngle(current: number, target: number, amount: number): number {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * amount;
}

// Estimates the sun's elevation and azimuth for local time and position.
function getSolarPosition(
  date: Date,
  latitude: number,
  longitude: number,
): { elevation: number; azimuth: number } {
  const julianDay = date.getTime() / 86_400_000 + 2_440_587.5;
  const century = (julianDay - 2_451_545) / 36_525;
  const meanLongitude = THREE.MathUtils.euclideanModulo(
    280.46646 + century * (36_000.76983 + century * 0.0003032),
    360,
  );
  const meanAnomaly = 357.52911 + century * (35_999.05029 - 0.0001537 * century);
  const anomalyRadians = THREE.MathUtils.degToRad(meanAnomaly);
  const orbitEccentricity = 0.016708634 - century * (0.000042037 + 0.0000001267 * century);
  const equationOfCenter =
    Math.sin(anomalyRadians) * (1.914602 - century * (0.004817 + 0.000014 * century)) +
    Math.sin(2 * anomalyRadians) * (0.019993 - 0.000101 * century) +
    Math.sin(3 * anomalyRadians) * 0.000289;
  const trueLongitude = meanLongitude + equationOfCenter;
  const omega = 125.04 - 1934.136 * century;
  const apparentLongitude =
    trueLongitude - 0.00569 - 0.00478 * Math.sin(THREE.MathUtils.degToRad(omega));
  const meanObliquity =
    23 +
    (26 +
      (21.448 -
        century * (46.815 + century * (0.00059 - century * 0.001813))) /
        60) /
      60;
  const correctedObliquity =
    meanObliquity + 0.00256 * Math.cos(THREE.MathUtils.degToRad(omega));
  const obliquityRadians = THREE.MathUtils.degToRad(correctedObliquity);
  const apparentLongitudeRadians = THREE.MathUtils.degToRad(apparentLongitude);
  const declination = Math.asin(Math.sin(obliquityRadians) * Math.sin(apparentLongitudeRadians));
  const y = Math.tan(obliquityRadians / 2) ** 2;
  const longitudeRadians = THREE.MathUtils.degToRad(meanLongitude);
  const equationOfTime =
    4 *
    THREE.MathUtils.radToDeg(
      y * Math.sin(2 * longitudeRadians) -
        2 * orbitEccentricity * Math.sin(anomalyRadians) +
        4 * orbitEccentricity * y * Math.sin(anomalyRadians) * Math.cos(2 * longitudeRadians) -
        0.5 * y * y * Math.sin(4 * longitudeRadians) -
        1.25 * orbitEccentricity ** 2 * Math.sin(2 * anomalyRadians),
    );
  const utcMinutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60_000;
  const solarMinutes = THREE.MathUtils.euclideanModulo(
    utcMinutes + equationOfTime + 4 * longitude,
    1440,
  );
  const hourAngle = THREE.MathUtils.degToRad(solarMinutes / 4 - 180);
  const latitudeRadians = THREE.MathUtils.degToRad(latitude);
  const cosineZenith = THREE.MathUtils.clamp(
    Math.sin(latitudeRadians) * Math.sin(declination) +
      Math.cos(latitudeRadians) * Math.cos(declination) * Math.cos(hourAngle),
    -1,
    1,
  );
  const elevation = 90 - THREE.MathUtils.radToDeg(Math.acos(cosineZenith));
  const azimuth =
    THREE.MathUtils.radToDeg(
      Math.atan2(
        Math.sin(hourAngle),
        Math.cos(hourAngle) * Math.sin(latitudeRadians) -
          Math.tan(declination) * Math.cos(latitudeRadians),
      ),
    ) + 180;

  return { elevation, azimuth };
}

// Builds a lightweight remote-aircraft model scaled to the requested reference dimensions.
function createRemoteAircraft(
  color: number,
  dimensions: AircraftDimensionsFeet,
  kind: 'fighter' | 'airliner',
): { aircraft: THREE.Group; lights: THREE.Group } {
  const aircraft = new THREE.Group();
  aircraft.scale.set(
    dimensions.wingspanFeet / REMOTE_AIRCRAFT_BASE_DIMENSIONS.wingspanFeet,
    dimensions.heightFeet / REMOTE_AIRCRAFT_BASE_DIMENSIONS.heightFeet,
    dimensions.lengthFeet / REMOTE_AIRCRAFT_BASE_DIMENSIONS.lengthFeet,
  );
  const lights = new THREE.Group();
  const aircraftMaterial = new THREE.MeshLambertMaterial({ color });
  const cockpitMaterial = new THREE.MeshLambertMaterial({ color: 0xe0f2fe });
  if (kind === 'airliner') {
    const fuselage = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.72, 14),
      aircraftMaterial,
    );
    fuselage.rotation.x = Math.PI / 2;
    fuselage.scale.z = 0.45;
    fuselage.castShadow = true;
    aircraft.add(fuselage);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 12), aircraftMaterial);
    nose.rotation.x = -Math.PI / 2;
    nose.scale.z = 0.45;
    nose.position.z = -0.41;
    nose.castShadow = true;
    aircraft.add(nose);

    const rearFuselage = new THREE.Mesh(
      new THREE.ConeGeometry(0.05, 0.2, 12),
      aircraftMaterial,
    );
    rearFuselage.rotation.x = Math.PI / 2;
    rearFuselage.scale.z = 0.45;
    rearFuselage.position.z = 0.41;
    rearFuselage.castShadow = true;
    aircraft.add(rearFuselage);

    const wingShape = new THREE.Shape();
    wingShape.moveTo(-0.055, 0.08);
    wingShape.lineTo(0.055, 0.08);
    wingShape.lineTo(0.485, -0.1);
    wingShape.lineTo(0.465, -0.31);
    wingShape.lineTo(0.075, -0.12);
    wingShape.lineTo(-0.075, -0.12);
    wingShape.lineTo(-0.465, -0.31);
    wingShape.lineTo(-0.485, -0.1);
    wingShape.closePath();
    const wings = new THREE.Mesh(new THREE.ShapeGeometry(wingShape), aircraftMaterial);
    wings.rotation.x = -Math.PI / 2;
    wings.position.y = -0.005;
    wings.castShadow = true;
    aircraft.add(wings);

    const engineMaterial = new THREE.MeshLambertMaterial({ color: 0x64748b });
    for (const side of [-1, 1]) {
      const engine = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, 0.18, 12),
        engineMaterial,
      );
      engine.rotation.x = Math.PI / 2;
      engine.scale.z = 0.5;
      engine.position.set(side * 0.23, -0.035, 0.12);
      engine.castShadow = true;
      aircraft.add(engine);

      const pylon = new THREE.Mesh(
        new THREE.BoxGeometry(0.025, 0.035, 0.08),
        aircraftMaterial,
      );
      pylon.position.set(side * 0.23, -0.015, 0.08);
      aircraft.add(pylon);
    }

    const tailplane = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.012, 0.09), aircraftMaterial);
    tailplane.position.z = 0.32;
    tailplane.castShadow = true;
    aircraft.add(tailplane);

    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.12, 0.14), aircraftMaterial);
    fin.position.set(0, 0.0575, 0.34);
    fin.castShadow = true;
    aircraft.add(fin);

    const cockpit = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 12, 8),
      cockpitMaterial,
    );
    cockpit.scale.set(0.75, 0.45, 1.6);
    cockpit.position.set(0, 0.03, -0.34);
    aircraft.add(cockpit);
  } else {
    const fuselage = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.032, 0.82, 10),
      aircraftMaterial,
    );
    fuselage.rotation.x = Math.PI / 2;
    fuselage.castShadow = true;
    aircraft.add(fuselage);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.16, 10), aircraftMaterial);
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -0.48;
    nose.castShadow = true;
    aircraft.add(nose);

    const wings = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.018, 0.14), aircraftMaterial);
    wings.position.z = -0.04;
    wings.castShadow = true;
    aircraft.add(wings);

    const tailplane = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.014, 0.08), aircraftMaterial);
    tailplane.position.z = 0.34;
    tailplane.castShadow = true;
    aircraft.add(tailplane);

    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.1, 0.12), aircraftMaterial);
    fin.position.set(0, 0.055, 0.32);
    fin.castShadow = true;
    aircraft.add(fin);

    const cockpit = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 10, 8),
      cockpitMaterial,
    );
    cockpit.scale.set(0.85, 0.65, 1.7);
    cockpit.position.set(0, 0.028, -0.13);
    aircraft.add(cockpit);
  }

  const addAircraftLight = (x: number, y: number, z: number, color: number) => {
    const lightGroup = new THREE.Group();
    lightGroup.position.set(x, y, z);
    lightGroup.add(new THREE.PointLight(color, 4, 45, 2));
    lightGroup.add(new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 8, 6),
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    ));
    lights.add(lightGroup);
  };

  const lightWingtip = kind === 'airliner' ? 0.485 : 0.44;
  const lightTail = kind === 'airliner' ? 0.46 : 0.4;
  addAircraftLight(-lightWingtip, 0, kind === 'airliner' ? 0.1 : -0.04, 0xff3030);
  addAircraftLight(lightWingtip, 0, kind === 'airliner' ? 0.1 : -0.04, 0x22ff77);
  addAircraftLight(0, 0.02, lightTail, 0xffffff);
  lights.visible = false;
  aircraft.add(lights);
  aircraft.visible = false;

  return { aircraft, lights };
}

// Builds a small forward-pointing missile model in its own local coordinate frame.
function createMissile(): THREE.Group {
  const missile = new THREE.Group();
  const bodyMaterial = new THREE.MeshBasicMaterial({ color: 0xd1d5db });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.26, 8), bodyMaterial);
  body.rotation.x = -Math.PI / 2;
  missile.add(body);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.022, 0.12, 8),
    new THREE.MeshBasicMaterial({ color: 0xf8fafc }),
  );
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.19;
  missile.add(nose);

  const exhaust = new THREE.Mesh(
    new THREE.SphereGeometry(0.025, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0xff8a35 }),
  );
  exhaust.position.z = 0.16;
  missile.add(exhaust);
  return missile;
}

function disposeMissile(scene: THREE.Scene, missile: THREE.Group): void {
  scene.remove(missile);
  missile.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach(material => material.dispose());
  });
}

// Creates a brief, additive particle burst at an impact location.
function createExplosion(scene: THREE.Scene, position: THREE.Vector3): ExplosionEffect {
  const positions = new Float32Array(EXPLOSION_PARTICLE_COUNT * 3);
  const colors = new Float32Array(EXPLOSION_PARTICLE_COUNT * 3);
  const velocities = new Float32Array(EXPLOSION_PARTICLE_COUNT * 3);
  for (let index = 0; index < EXPLOSION_PARTICLE_COUNT; index += 1) {
    const offset = index * 3;
    const direction = new THREE.Vector3(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
    ).normalize();
    const speed = 2 + Math.random() * 7;
    velocities[offset] = direction.x * speed;
    velocities[offset + 1] = direction.y * speed;
    velocities[offset + 2] = direction.z * speed;
    colors[offset] = 1;
    colors[offset + 1] = 0.25 + Math.random() * 0.6;
    colors[offset + 2] = Math.random() * 0.12;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const particles = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 0.18,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 10, 8),
    new THREE.MeshBasicMaterial({
      color: 0xffb347,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const group = new THREE.Group();
  group.position.copy(position);
  group.add(particles, flash);
  scene.add(group);
  return { group, particles, positions, velocities, startedAt: performance.now() };
}

function disposeExplosion(scene: THREE.Scene, effect: ExplosionEffect): void {
  scene.remove(effect.group);
  effect.group.traverse(object => {
    if (object instanceof THREE.Points || object instanceof THREE.Mesh) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => material.dispose());
    }
  });
}

// Releases geometry and material resources owned by a remote-aircraft model.
function disposeRemoteAircraft(aircraft: THREE.Group): void {
  aircraft.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach(material => material.dispose());
  });
}

// Assigns a stable palette color to each multiplayer player ID.
function getPlayerAircraftColor(playerId: string): number {
  let hash = 0;
  for (let index = 0; index < playerId.length; index += 1) {
    hash = (hash * 31 + playerId.charCodeAt(index)) | 0;
  }
  const colorIndex = ((hash % REMOTE_AIRCRAFT_COLORS.length) + REMOTE_AIRCRAFT_COLORS.length) %
    REMOTE_AIRCRAFT_COLORS.length;
  return REMOTE_AIRCRAFT_COLORS[colorIndex];
}

// Renders the cockpit view, terrain, sky lighting, and interpolated remote aircraft.
export default function FlightViewport({
  posX,
  posZ,
  altitude,
  pitch,
  roll,
  throttle,
  verticalSpeed,
  heading,
  airspeed,
  crashed,
  localPlayerId,
  localMissilesRef,
  radarEnabled,
  remoteTelemetries,
  radarContacts,
  radarWarnings,
  radarScanAzimuth,
  radarScanBar,
  primaryTargetId,
  terrainOrigin,
  terrainGrid,
  terrainStatus,
  weather,
  simulationTimeMinutes,
}: FlightViewportProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const simulationTimeRef = useRef(simulationTimeMinutes);
  const weatherRef = useRef(weather);
  const terrainOriginRef = useRef(terrainOrigin);
  const localPlayerIdRef = useRef(localPlayerId);
  const fallbackGroundRef = useRef<THREE.Group | null>(null);
  const remoteAircraftRef = useRef(new Map<string, RemoteAircraftInstance>());
  const missileInstancesRef = useRef(new Map<string, MissileVisualInstance>());
  const explosionEffectsRef = useRef<ExplosionEffect[]>([]);
  const seenExplosionsRef = useRef(new Map<string, number>());
  const terrainMeshesRef = useRef<
    Array<THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>>
  >([]);
  const [imageryProgress, setImageryProgress] = useState<{
    grid: TerrainGrid;
    status: string;
  } | null>(null);

  // Creates and tears down the Three.js scene and its animation loop.
  useEffect(() => {
    const currentMount = mountRef.current;
    if (!currentMount) return;
    const remoteAircrafts = remoteAircraftRef.current;
    const missileInstances = missileInstancesRef.current;
    const explosionEffects = explosionEffectsRef.current;
    const seenExplosions = seenExplosionsRef.current;

    // 1. Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = DAY_SKY.clone();
    // Fog is measured in scene units (feet * visualScale), not simulator feet.
    scene.fog = new THREE.Fog(DAY_SKY, FOG_NEAR, FOG_FAR);

    // 2. Camera (First-Person FOV)
    const width = Math.max(currentMount.clientWidth, 1);
    const height = Math.max(currentMount.clientHeight, 1);
    const camera = new THREE.PerspectiveCamera(80, width / height, 0.1, 20000);
    cameraRef.current = camera;

    // 3. Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    rendererRef.current = renderer;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    currentMount.appendChild(renderer.domElement);
    // A broad ground plane and grid make altitude and forward motion readable.
    const fallbackGround = new THREE.Group();
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(20000, 20000),
      new THREE.MeshLambertMaterial({ color: 0x263e3a }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    fallbackGround.add(ground);

    const gridHelper = new THREE.GridHelper(20000, 200, 0x79a78f, 0x39564a);
    gridHelper.position.y = 0.1;
    fallbackGround.add(gridHelper);
    scene.add(fallbackGround);
    fallbackGroundRef.current = fallbackGround;

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 2);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.left = -1200;
    dirLight.shadow.camera.right = 1200;
    dirLight.shadow.camera.top = 1200;
    dirLight.shadow.camera.bottom = -1200;
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far = LIGHT_DISTANCE * 2.5;
    dirLight.shadow.bias = -0.00015;
    dirLight.shadow.normalBias = 0.025;
    dirLight.shadow.radius = 3;
    scene.add(dirLight);
    scene.add(dirLight.target);

    const moonLight = new THREE.DirectionalLight(NIGHT_LIGHT, 0.2);
    moonLight.castShadow = false;
    scene.add(moonLight);
    scene.add(moonLight.target);

    const sunMarker = new THREE.Mesh(
      new THREE.SphereGeometry(28, 24, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffe6a3,
        fog: false,
        transparent: true,
        toneMapped: false,
      }),
    );
    const moonMarker = new THREE.Mesh(
      new THREE.SphereGeometry(20, 24, 16),
      new THREE.MeshBasicMaterial({
        color: 0xd8e2ff,
        fog: false,
        transparent: true,
        toneMapped: false,
      }),
    );
    scene.add(sunMarker, moonMarker);

    const cloudNoiseTexture = createCloudNoiseTexture();
    const cloudMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uCloudNoise: { value: cloudNoiseTexture },
        uBoxMin: { value: new THREE.Vector3() },
        uBoxMax: { value: new THREE.Vector3() },
        uNoiseScale: { value: new THREE.Vector3(0.003, 0.012, 0.003) },
        uCloudColor: { value: new THREE.Color(0xa8b2bc) },
        uFogColor: { value: new THREE.Color() },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(0xffffff) },
        uAmbientColor: { value: new THREE.Color(0xffffff) },
        uCloudCoverage: { value: 0 },
        uCloudBase: { value: 0 },
        uCloudDepth: { value: 1 },
        uFogNear: { value: FOG_NEAR },
        uFogFar: { value: FOG_FAR },
        uLightning: { value: 0 },
      },
      vertexShader: CLOUD_VERTEX_SHADER,
      fragmentShader: CLOUD_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.FrontSide,
    });
    const cloudVolume = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), cloudMaterial);
    cloudVolume.frustumCulled = false;
    cloudVolume.visible = false;
    scene.add(cloudVolume);

    const precipitationPositions = new Float32Array(PRECIPITATION_PARTICLE_COUNT * 6);
    const precipitationGeometry = new THREE.BufferGeometry();
    const precipitationPositionAttribute = new THREE.BufferAttribute(
      precipitationPositions,
      3,
    );
    precipitationPositionAttribute.setUsage(THREE.DynamicDrawUsage);
    precipitationGeometry.setAttribute(
      'position',
      precipitationPositionAttribute,
    );
    const precipitationMaterial = new THREE.LineBasicMaterial({
      color: 0xb9d8ec,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const precipitation = new THREE.LineSegments(
      precipitationGeometry,
      precipitationMaterial,
    );
    precipitation.frustumCulled = false;
    precipitation.visible = false;
    scene.add(precipitation);

    const snowfallPositions = new Float32Array(PRECIPITATION_PARTICLE_COUNT * 3);
    const snowfallGeometry = new THREE.BufferGeometry();
    const snowfallPositionAttribute = new THREE.BufferAttribute(snowfallPositions, 3);
    snowfallPositionAttribute.setUsage(THREE.DynamicDrawUsage);
    snowfallGeometry.setAttribute('position', snowfallPositionAttribute);
    const snowflakeTexture = createSnowflakeTexture();
    const snowfallMaterial = new THREE.PointsMaterial({
      color: 0xf3f8ff,
      size: 1.2,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      sizeAttenuation: true,
      map: snowflakeTexture,
      alphaTest: 0.05,
    });
    const snowfall = new THREE.Points(snowfallGeometry, snowfallMaterial);
    snowfall.frustumCulled = false;
    snowfall.visible = false;
    scene.add(snowfall);

    const lightningFlash = new THREE.PointLight(0xd9efff, 0, 2500, 1.2);
    lightningFlash.castShadow = false;
    scene.add(lightningFlash);

    const lightTarget = new THREE.Vector3();
    const sunDirection = new THREE.Vector3();
    const moonDirection = new THREE.Vector3();
    const missileTargetPosition = new THREE.Vector3();
    const skyColor = new THREE.Color();
    const ambientColor = new THREE.Color();
    const sunlightColor = new THREE.Color();
    const moonlightColor = new THREE.Color();
    const lightningSky = new THREE.Color(0xdceeff);
    const cloudySky = new THREE.Color(0x8997a2);
    let lastShadowUpdate = 0;
    let cloudSignature = '';
    let cloudCellX = Number.NaN;
    let cloudCellZ = Number.NaN;
    let precipitationInitializedCount = 0;
    let lightningUntil = 0;
    let nextLightningAt = performance.now() + 4000 + Math.random() * 8000;
    renderer.shadowMap.autoUpdate = false;

    const updateCloudVolume = (
      currentWeather: WeatherState,
      centerTileX: number,
      centerTileZ: number,
    ): void => {
      const cloudBaseFeet = Math.max(CLOUD_MIN_BASE_FEET, currentWeather.cloudBaseFeet);
      const cloudTopFeet = Math.max(cloudBaseFeet + 5000, currentWeather.cloudTopFeet);
      const cloudBase = cloudBaseFeet * visualScale;
      const cloudDepth = (cloudTopFeet - cloudBaseFeet) * visualScale;
      const centerX = (centerTileX + 0.5) * CLOUD_VOLUME_TILE_SIZE;
      const centerZ = (centerTileZ + 0.5) * CLOUD_VOLUME_TILE_SIZE;
      const minX = centerX - CLOUD_VOLUME_HALF_SIZE;
      const minY = cloudBase;
      const minZ = centerZ - CLOUD_VOLUME_HALF_SIZE;
      const maxX = centerX + CLOUD_VOLUME_HALF_SIZE;
      const maxY = cloudBase + cloudDepth;
      const maxZ = centerZ + CLOUD_VOLUME_HALF_SIZE;
      const uniforms = cloudMaterial.uniforms;

      cloudVolume.position.set(centerX, cloudBase + cloudDepth * 0.5, centerZ);
      cloudVolume.scale.set(
        CLOUD_VOLUME_HALF_SIZE * 2,
        cloudDepth,
        CLOUD_VOLUME_HALF_SIZE * 2,
      );
      cloudVolume.updateMatrixWorld();
      uniforms.uBoxMin.value.set(minX, minY, minZ);
      uniforms.uBoxMax.value.set(maxX, maxY, maxZ);
      uniforms.uCloudBase.value = cloudBase;
      uniforms.uCloudDepth.value = cloudDepth;
      uniforms.uCloudCoverage.value = THREE.MathUtils.clamp(
        currentWeather.cloudCoverPercent / 100,
        0,
        1,
      );
      uniforms.uCloudColor.value.set(
        currentWeather.kind === 'storm' ? 0x78838d :
          currentWeather.kind === 'rain' ? 0x9ba8b2 : 0xe9f0f3,
      );
      cloudVolume.visible = currentWeather.cloudCoverPercent > 8;
    };

    const handleResize = () => {
      const w = Math.max(currentMount.clientWidth, 1);
      const h = Math.max(currentMount.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(currentMount);

    let animId: number;
    let previousFrameTime = performance.now();
    const adsbTargetPosition = new THREE.Vector3();
    // Interpolates remote traffic and updates time-dependent lighting each frame.
    const animate = () => {
      animId = requestAnimationFrame(animate);
      const timeMinutes = simulationTimeRef.current;
      const now = performance.now();
      const frameSeconds = Math.min(Math.max((now - previousFrameTime) / 1000, 0), 0.1);
      previousFrameTime = now;
      const currentWeather = weatherRef.current;
      const nextCloudCellX = Math.floor(camera.position.x / CLOUD_VOLUME_TILE_SIZE);
      const nextCloudCellZ = Math.floor(camera.position.z / CLOUD_VOLUME_TILE_SIZE);
      const nextCloudSignature = [
        currentWeather.kind,
        currentWeather.cloudCoverPercent,
        currentWeather.cloudBaseFeet,
        currentWeather.cloudTopFeet,
      ].join(':');
      if (
        nextCloudSignature !== cloudSignature ||
        nextCloudCellX !== cloudCellX ||
        nextCloudCellZ !== cloudCellZ
      ) {
        updateCloudVolume(currentWeather, nextCloudCellX, nextCloudCellZ);
        cloudSignature = nextCloudSignature;
        cloudCellX = nextCloudCellX;
        cloudCellZ = nextCloudCellZ;
      }

      const isSnowing = currentWeather.snowCentimetersPerHour > 0.02;
      const isPrecipitating =
        currentWeather.rainMillimetersPerHour > 0.05 || isSnowing;
      const particleCount = Math.round(
        PRECIPITATION_PARTICLE_COUNT *
        THREE.MathUtils.clamp(currentWeather.precipitationDensity, 0, 1),
      );
      precipitation.visible = isPrecipitating && !isSnowing;
      snowfall.visible = isSnowing;
      precipitationGeometry.setDrawRange(0, particleCount * 2);
      snowfallGeometry.setDrawRange(0, particleCount);
      if (!isPrecipitating) precipitationInitializedCount = 0;
      precipitationMaterial.color.set(0xb9d8ec);
      precipitationMaterial.opacity = THREE.MathUtils.clamp(
        0.35 + currentWeather.rainMillimetersPerHour * 0.06,
        0.35,
        0.85,
      );
      if (isPrecipitating) {
        const positions = precipitationGeometry.attributes.position.array as Float32Array;
        const snowPositions = snowfallGeometry.attributes.position.array as Float32Array;
        const fallSpeed = isSnowing ? 1.8 : 18;
        const windEastSpeed = currentWeather.windEastKnots * 0.016878;
        const windNorthSpeed = -currentWeather.windNorthKnots * 0.016878;
        const windX = windEastSpeed * frameSeconds;
        const windZ = windNorthSpeed * frameSeconds;
        const streakLength = RAIN_STREAK_LENGTH;
        const streakDuration = streakLength / fallSpeed;
        for (let index = 0; index < particleCount; index += 1) {
          const offset = index * 6;
          const flutter = isSnowing
            ? Math.sin(now * 0.0012 + index * 0.73) * 1.2 * frameSeconds
            : 0;
          let x = positions[offset] + windX + flutter;
          let y = positions[offset + 1] - fallSpeed * frameSeconds;
          let z = positions[offset + 2] + windZ +
            (isSnowing ? Math.cos(now * 0.001 + index * 0.61) * 1.2 * frameSeconds : 0);
          const relativeX = x - camera.position.x;
          const relativeY = y - camera.position.y;
          const relativeZ = z - camera.position.z;
          const distance = Math.hypot(relativeX, relativeY, relativeZ);
          if (
            index >= precipitationInitializedCount ||
            distance > 360
          ) {
            const spawnAzimuth = Math.random() * Math.PI * 2;
            const verticalDirection = Math.random() * 2 - 1;
            const horizontalDirection = Math.sqrt(1 - verticalDirection ** 2);
            const spawnRadius = Math.cbrt(Math.random()) * 280;
            x =
              camera.position.x +
              Math.cos(spawnAzimuth) * horizontalDirection * spawnRadius;
            y = camera.position.y + verticalDirection * spawnRadius;
            z =
              camera.position.z +
              Math.sin(spawnAzimuth) * horizontalDirection * spawnRadius;
          }
          positions[offset] = x;
          positions[offset + 1] = y;
          positions[offset + 2] = z;
          if (isSnowing) {
            const snowOffset = index * 3;
            snowPositions[snowOffset] = x;
            snowPositions[snowOffset + 1] = y;
            snowPositions[snowOffset + 2] = z;
            positions[offset + 3] = x;
            positions[offset + 4] = y;
            positions[offset + 5] = z;
          } else {
            positions[offset + 3] = x - windEastSpeed * streakDuration;
            positions[offset + 4] = y + streakLength;
            positions[offset + 5] = z - windNorthSpeed * streakDuration;
          }
        }
        precipitationInitializedCount = particleCount;
        precipitationPositionAttribute.needsUpdate = true;
        snowfallPositionAttribute.needsUpdate = true;
      }

      let lightningActive = false;
      if (currentWeather.lightning) {
        if (now >= nextLightningAt) {
          lightningUntil = now + 90 + Math.random() * 100;
          nextLightningAt = now + 5000 + Math.random() * 11000;
        }
        lightningActive = now < lightningUntil;
      } else {
        lightningUntil = 0;
      }
      lightningFlash.intensity = lightningActive ? 1400 : 0;
      lightningFlash.position.set(
        camera.position.x + 180,
        currentWeather.cloudTopFeet * visualScale,
        camera.position.z - 140,
      );

      const missileSmoothing = 1 - Math.exp(
        -frameSeconds / MISSILE_VISUAL_SMOOTHING_SECONDS,
      );
      const adsbSmoothing = 1 - Math.exp(
        -frameSeconds / ADSB_VISUAL_SMOOTHING_SECONDS,
      );
      const missileRenderTime = now - REMOTE_MISSILE_INTERPOLATION_DELAY_MS;
      for (const instance of remoteAircrafts.values()) {
        const { aircraft, lights, samples } = instance;
        const isAdsb = samples[0]?.telemetry.playerId.startsWith('adsb:') ?? false;
        const interpolationDelay = isAdsb
          ? ADSB_INTERPOLATION_DELAY_MS
          : THREE.MathUtils.clamp(
              REMOTE_INTERPOLATION_BASE_DELAY_MS + instance.interarrivalJitterMs * 2,
              REMOTE_INTERPOLATION_BASE_DELAY_MS,
              REMOTE_INTERPOLATION_MAX_DELAY_MS,
            );
        const renderTime = now - interpolationDelay;
        const isNight = timeMinutes >= 18 * 60 || timeMinutes < 6 * 60;
        lights.visible = isNight;
        while (samples.length > 2 && samples[1].receivedAt <= renderTime) samples.shift();

        if (samples.length === 0) {
          aircraft.visible = false;
          continue;
        }
        const latestSample = samples[samples.length - 1];
        if (now - latestSample.receivedAt +
          (isAdsb ? (latestSample.telemetry.sourceAgeSeconds ?? 0) * 1000 : 0) >
          (isAdsb ? ADSB_TRACK_TTL_MS : 2_000)) {
          aircraft.visible = false;
          continue;
        }
        const first = samples[0];
        const second = samples[1];
        const interval = second ? second.receivedAt - first.receivedAt : 0;
        const amount = interval > 0
          ? THREE.MathUtils.clamp(
              (renderTime - first.receivedAt) / interval,
              0,
              1,
            )
          : 0;
        const start = first.telemetry;
        const end = second?.telemetry ?? start;
        const targetHeading = -THREE.MathUtils.degToRad(
          interpolateAngle(start.heading, end.heading, amount),
        );
        const targetPitch = THREE.MathUtils.degToRad(
          THREE.MathUtils.lerp(start.pitch, end.pitch, amount),
        );
        const targetRoll = -THREE.MathUtils.degToRad(
          interpolateAngle(start.roll, end.roll, amount),
        );
        aircraft.visible = true;
        adsbTargetPosition.set(
          THREE.MathUtils.lerp(first.posXFeet, second?.posXFeet ?? first.posXFeet, amount) *
            visualScale,
          THREE.MathUtils.lerp(start.altitude, end.altitude, amount) * visualScale,
          THREE.MathUtils.lerp(
            first.posZFeet,
            second?.posZFeet ?? first.posZFeet,
            amount,
          ) * visualScale,
        );
        if (isAdsb) {
          if (aircraft.userData.adsbPositionInitialized !== true) {
            aircraft.position.copy(adsbTargetPosition);
            aircraft.userData.adsbPositionInitialized = true;
          } else {
            aircraft.position.lerp(adsbTargetPosition, adsbSmoothing);
          }
          aircraft.rotation.y = smoothAngle(aircraft.rotation.y, targetHeading, adsbSmoothing);
          aircraft.rotation.x = THREE.MathUtils.lerp(
            aircraft.rotation.x,
            targetPitch,
            adsbSmoothing,
          );
          aircraft.rotation.z = smoothAngle(aircraft.rotation.z, targetRoll, adsbSmoothing);
        } else {
          aircraft.position.copy(adsbTargetPosition);
          aircraft.rotation.y = targetHeading;
          aircraft.rotation.x = targetPitch;
          aircraft.rotation.z = targetRoll;
        }
        aircraft.rotation.order = 'YXZ';
      }

      for (const [key, missile] of missileInstances) {
        const ownerId = key.slice(0, key.lastIndexOf(':'));
        const remote = remoteAircrafts.get(ownerId);
        missile.model.visible =
          !remote ||
          (remote.samples.length > 0 &&
            now - remote.samples[remote.samples.length - 1].receivedAt <= 2000);
        if (missile.locallySimulated) {
          const sample = missile.samples[missile.samples.length - 1];
          missile.model.position.copy(sample.position);
          missile.model.rotation.order = 'YXZ';
          missile.model.rotation.y = -THREE.MathUtils.degToRad(sample.heading);
          missile.model.rotation.x = THREE.MathUtils.degToRad(sample.pitch);
          continue;
        }
        while (
          missile.samples.length > 2 &&
          missile.samples[1].receivedAt <= missileRenderTime
        ) {
          missile.samples.shift();
        }
        const first = missile.samples[0];
        const second = missile.samples[1];
        const interval = second ? second.receivedAt - first.receivedAt : 0;
        const amount = interval > 0
          ? THREE.MathUtils.clamp(
              (missileRenderTime - first.receivedAt) / interval,
              0,
              1,
            )
          : 0;
        missileTargetPosition.lerpVectors(
          first.position,
          second?.position ?? first.position,
          amount,
        );
        if (second && interval > 0 && missileRenderTime > second.receivedAt) {
          // Dead-reckon briefly through delayed packets instead of freezing, then jumping.
          const extrapolationMs = Math.min(
            missileRenderTime - second.receivedAt,
            MAX_MISSILE_EXTRAPOLATION_MS,
          );
          const extrapolationRatio = extrapolationMs / interval;
          missileTargetPosition.x +=
            (second.position.x - first.position.x) * extrapolationRatio;
          missileTargetPosition.y +=
            (second.position.y - first.position.y) * extrapolationRatio;
          missileTargetPosition.z +=
            (second.position.z - first.position.z) * extrapolationRatio;
        }
        missile.model.position.lerp(missileTargetPosition, missileSmoothing);
        missile.model.rotation.order = 'YXZ';
        const targetHeading = -THREE.MathUtils.degToRad(
          interpolateAngle(first.heading, second?.heading ?? first.heading, amount),
        );
        missile.model.rotation.y = smoothAngle(
          missile.model.rotation.y,
          targetHeading,
          missileSmoothing,
        );
        const targetPitch = THREE.MathUtils.degToRad(
          THREE.MathUtils.lerp(first.pitch, second?.pitch ?? first.pitch, amount),
        );
        missile.model.rotation.x = THREE.MathUtils.lerp(
          missile.model.rotation.x,
          targetPitch,
          missileSmoothing,
        );
      }

      const activeLocalMissiles = new Set<string>();
      const localSnapshots = localMissilesRef.current;
      for (const missile of localSnapshots) {
        const key = `${localPlayerIdRef.current}:${missile.missileId}`;
        const position = getLocalPosition(terrainOriginRef.current, missile);
        const sample: MissileVisualSample = {
          position: new THREE.Vector3(
            position.posXFeet * visualScale,
            missile.altitude * visualScale,
            position.posZFeet * visualScale,
          ),
          heading: missile.heading,
          pitch: missile.pitch,
          receivedAt: now,
        };
        if (missile.exploded) {
          if (!seenExplosions.has(key)) {
            seenExplosions.set(key, now);
            explosionEffects.push(createExplosion(scene, sample.position));
          }
          const existing = missileInstances.get(key);
          if (existing) {
            disposeMissile(scene, existing.model);
            missileInstances.delete(key);
          }
          continue;
        }

        activeLocalMissiles.add(key);
        let instance = missileInstances.get(key);
        if (!instance) {
          const model = createMissile();
          model.position.copy(sample.position);
          model.rotation.order = 'YXZ';
          model.rotation.y = -THREE.MathUtils.degToRad(sample.heading);
          model.rotation.x = THREE.MathUtils.degToRad(sample.pitch);
          scene.add(model);
          instance = { model, samples: [sample], locallySimulated: true };
          missileInstances.set(key, instance);
        } else {
          instance.samples[0] = sample;
        }
      }

      for (const [key, instance] of missileInstances) {
        if (!instance.locallySimulated || activeLocalMissiles.has(key)) continue;
        disposeMissile(scene, instance.model);
        missileInstances.delete(key);
      }

      const survivingEffects: ExplosionEffect[] = [];
      for (const effect of explosionEffects) {
        const ageSeconds = (now - effect.startedAt) / 1000;
        if (ageSeconds * 1000 >= EXPLOSION_DURATION_MS) {
          disposeExplosion(scene, effect);
          continue;
        }
        for (let index = 0; index < EXPLOSION_PARTICLE_COUNT; index += 1) {
          const offset = index * 3;
          effect.positions[offset] = effect.velocities[offset] * ageSeconds;
          effect.positions[offset + 1] =
            effect.velocities[offset + 1] * ageSeconds - 1.8 * ageSeconds * ageSeconds;
          effect.positions[offset + 2] = effect.velocities[offset + 2] * ageSeconds;
        }
        effect.particles.geometry.attributes.position.needsUpdate = true;
        effect.particles.geometry.computeBoundingSphere();
        const fade = 1 - ageSeconds * 1000 / EXPLOSION_DURATION_MS;
        (effect.particles.material as THREE.PointsMaterial).opacity = fade;
        const flash = effect.group.children[1];
        if (flash instanceof THREE.Mesh) {
          flash.scale.setScalar(1 + ageSeconds * 7);
          (flash.material as THREE.MeshBasicMaterial).opacity = fade * 0.9;
        }
        survivingEffects.push(effect);
      }
      explosionEffects.length = 0;
      explosionEffects.push(...survivingEffects);

      const currentDate = new Date();
      const solarDate = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        currentDate.getDate(),
        0,
        timeMinutes,
      );
      const aircraftCoordinates = getAircraftCoordinates(
        terrainOriginRef.current,
        camera.position.x / visualScale,
        camera.position.z / visualScale,
      );
      const solarPosition = getSolarPosition(
        solarDate,
        aircraftCoordinates.latitude,
        aircraftCoordinates.longitude,
      );
      const solarElevation = THREE.MathUtils.degToRad(solarPosition.elevation);
      const solarHeight = Math.sin(solarElevation);
      const daylight = THREE.MathUtils.clamp((solarHeight + 0.12) / 0.32, 0, 1);
      const twilight = 1 - THREE.MathUtils.clamp(Math.abs(solarHeight) * 3, 0, 1);
      const sky = skyColor
        .copy(NIGHT_SKY)
        .lerp(TWILIGHT_SKY, twilight)
        .lerp(DAY_SKY, daylight);
      const cloudCover = THREE.MathUtils.clamp(currentWeather.cloudCoverPercent / 100, 0, 1);
      sky.lerp(cloudySky, cloudCover * 0.5);
      if (lightningActive) sky.lerp(lightningSky, 0.62);

      scene.background = sky;
      if (scene.fog instanceof THREE.Fog) {
        scene.fog.color.copy(sky);
        const visibilityFar = currentWeather.visibilityMeters === null
          ? FOG_FAR
          : Math.min(
              FOG_FAR,
              Math.max(
                FOG_NEAR * 2,
                currentWeather.visibilityMeters *
                  feetPerMeter *
                  visualScale *
                  VISIBILITY_FOG_SCALE,
              ),
            );
        scene.fog.near = currentWeather.visibilityMeters === null
          ? FOG_NEAR
          : FOG_NEAR;
        scene.fog.far = Math.max(scene.fog.near + 0.1, visibilityFar);
      }
      ambientLight.color.copy(ambientColor.copy(NIGHT_LIGHT).lerp(DAY_LIGHT, daylight));
      ambientLight.intensity = 0.18 + daylight * (1.02 - cloudCover * 0.3) +
        (lightningActive ? 0.8 : 0);
      dirLight.color.copy(sunlightColor.copy(TWILIGHT_SKY).lerp(DAY_LIGHT, daylight));
      dirLight.intensity = 0.08 + daylight * (1.92 - cloudCover * 0.85) +
        (lightningActive ? 1.4 : 0);
      dirLight.castShadow = daylight > 0.05;
      moonLight.color.copy(moonlightColor.copy(NIGHT_LIGHT).lerp(DAY_LIGHT, daylight));
      moonLight.intensity = 0.22 * (1 - daylight);

      // The visible bodies follow the aircraft; the lights target the terrain below it.
      lightTarget.set(camera.position.x, 0, camera.position.z);
      const solarAzimuth = THREE.MathUtils.degToRad(solarPosition.azimuth);
      sunDirection.set(
        Math.sin(solarAzimuth) * Math.cos(solarElevation),
        solarHeight,
        -Math.cos(solarAzimuth) * Math.cos(solarElevation),
      ).normalize();
      moonDirection.copy(sunDirection).negate();
      dirLight.target.position.copy(lightTarget);
      dirLight.position.copy(lightTarget).addScaledVector(sunDirection, LIGHT_DISTANCE);
      moonLight.target.position.copy(lightTarget);
      moonLight.position.copy(lightTarget).addScaledVector(moonDirection, LIGHT_DISTANCE);
      sunMarker.position
        .copy(camera.position)
        .addScaledVector(sunDirection, CELESTIAL_DISTANCE);
      moonMarker.position
        .copy(camera.position)
        .addScaledVector(moonDirection, CELESTIAL_DISTANCE);
      (sunMarker.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(
        (solarHeight + 0.12) / 0.25,
        0,
        1,
      );
      (moonMarker.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(
        (-solarHeight + 0.12) / 0.25,
        0,
        0.9,
      );
      const cloudUniforms = cloudMaterial.uniforms;
      const fog = scene.fog instanceof THREE.Fog ? scene.fog : null;
      cloudUniforms.uFogColor.value.copy(sky);
      cloudUniforms.uFogNear.value = fog?.near ?? FOG_NEAR;
      cloudUniforms.uFogFar.value = fog?.far ?? FOG_FAR;
      cloudUniforms.uSunDirection.value.copy(sunDirection);
      cloudUniforms.uSunColor.value.copy(dirLight.color).multiplyScalar(dirLight.intensity);
      cloudUniforms.uAmbientColor.value
        .copy(ambientLight.color)
        .multiplyScalar(ambientLight.intensity);
      cloudUniforms.uLightning.value = lightningActive ? 0.85 : 0;
      const cameraInsideCloud =
        camera.position.x > cloudUniforms.uBoxMin.value.x &&
        camera.position.x < cloudUniforms.uBoxMax.value.x &&
        camera.position.y > cloudUniforms.uBoxMin.value.y &&
        camera.position.y < cloudUniforms.uBoxMax.value.y &&
        camera.position.z > cloudUniforms.uBoxMin.value.z &&
        camera.position.z < cloudUniforms.uBoxMax.value.z;
      const cloudSide = cameraInsideCloud ? THREE.BackSide : THREE.FrontSide;
      if (cloudMaterial.side !== cloudSide) {
        cloudMaterial.side = cloudSide;
        cloudMaterial.needsUpdate = true;
      }
      if (renderer.shadowMap.enabled && performance.now() - lastShadowUpdate >= 1000) {
        renderer.shadowMap.needsUpdate = true;
        lastShadowUpdate = performance.now();
      }

      renderer.render(scene, camera);
    };
    animate();
    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(animId);
      cloudNoiseTexture.dispose();
      snowflakeTexture.dispose();
      scene.traverse(object => {
        if (object instanceof THREE.DirectionalLight) object.shadow.dispose();
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.LineSegments ||
          object instanceof THREE.Points
        ) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach(material => {
            if (material instanceof THREE.MeshLambertMaterial && material.map) {
              material.map.dispose();
            }
            material.dispose();
          });
        }
      });
      renderer.domElement.remove();
      renderer.dispose();
      rendererRef.current = null;
      sceneRef.current = null;
      fallbackGroundRef.current = null;
      remoteAircrafts.clear();
      missileInstances.clear();
      explosionEffects.length = 0;
      seenExplosions.clear();
      terrainMeshesRef.current = [];
    };
  }, [localMissilesRef, localPlayerIdRef]);

  // Keeps the displayed simulation time available to the render loop.
  useEffect(() => {
    simulationTimeRef.current = simulationTimeMinutes;
  }, [simulationTimeMinutes]);

  useEffect(() => {
    weatherRef.current = weather;
  }, [weather]);

  // Keeps geographic conversion aligned with the latest flight origin.
  useEffect(() => {
    terrainOriginRef.current = terrainOrigin;
  }, [terrainOrigin]);

  useEffect(() => {
    localPlayerIdRef.current = localPlayerId;
  }, [localPlayerId]);

  // Builds terrain meshes and progressively loads imagery without blocking frames.
  useEffect(() => {
    const scene = sceneRef.current;
    const fallbackGround = fallbackGroundRef.current;
    const renderer = rendererRef.current;
    if (!scene || !fallbackGround || !renderer) return;
    if (!terrainGrid) {
      fallbackGround.visible = true;
      terrainMeshesRef.current.forEach(mesh => {
        scene.remove(mesh);
        mesh.geometry.dispose();
        if (mesh.material.map) mesh.material.map.dispose();
        mesh.material.dispose();
      });
      terrainMeshesRef.current = [];
      return;
    }

    const { width, height, heightsMeters } = terrainGrid;
    const tileMeshes: Array<
      THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>
    > = [];
    const sampleStride = terrainGrid.tileSize / TERRAIN_MESH_SEGMENTS;
    let cancelled = false;
    let meshesCommitted = false;
    let meshFrameId = 0;
    let textureFrameId = 0;
    let nextTileIndex = 0;
    const pendingTextures: THREE.Texture[] = [];
    let imageryLoaded = false;

    // Removes a set of meshes and releases their GPU resources.
    const disposeMeshes = (
      meshes: Array<THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>>,
    ) => {
      meshes.forEach(mesh => {
        scene.remove(mesh);
        mesh.geometry.dispose();
        if (mesh.material.map) mesh.material.map.dispose();
        mesh.material.dispose();
      });
    };

    // Creates terrain geometry in small frame-sized batches.
    const buildMeshes = () => {
      const tileCount = terrainGrid.tileRows * terrainGrid.tileColumns;
      const batchEnd = Math.min(nextTileIndex + TERRAIN_MESHES_PER_FRAME, tileCount);
      for (; nextTileIndex < batchEnd; nextTileIndex += 1) {
        const tileRow = Math.floor(nextTileIndex / terrainGrid.tileColumns);
        const tileColumn = nextTileIndex % terrainGrid.tileColumns;
        const geometry = new THREE.PlaneGeometry(
          terrainGrid.tileSize * terrainGrid.spacingXFeet * visualScale,
          terrainGrid.tileSize * terrainGrid.spacingZFeet * visualScale,
          TERRAIN_MESH_SEGMENTS,
          TERRAIN_MESH_SEGMENTS,
        );
        const positions = geometry.attributes.position;
        const colors = new Float32Array(positions.count * 3);
        const normals = new Float32Array(positions.count * 3);
        for (let row = 0; row <= TERRAIN_MESH_SEGMENTS; row += 1) {
          for (let column = 0; column <= TERRAIN_MESH_SEGMENTS; column += 1) {
            const index = row * (TERRAIN_MESH_SEGMENTS + 1) + column;
            const gridX = Math.min(
              tileColumn * terrainGrid.tileSize + column * sampleStride,
              width - 1,
            );
            const gridY = Math.min(
              tileRow * terrainGrid.tileSize + row * sampleStride,
              height - 1,
            );
            const elevationMeters = heightsMeters[gridY * width + gridX];
            positions.setZ(index, elevationMeters * feetPerMeter * visualScale);

            const leftX = Math.max(gridX - sampleStride, 0);
            const rightX = Math.min(gridX + sampleStride, width - 1);
            const northY = Math.max(gridY - sampleStride, 0);
            const southY = Math.min(gridY + sampleStride, height - 1);
            const slopeX =
              ((heightsMeters[gridY * width + rightX] -
                heightsMeters[gridY * width + leftX]) *
                feetPerMeter) /
              ((rightX - leftX) * terrainGrid.spacingXFeet);
            const slopeZ =
              ((heightsMeters[southY * width + gridX] -
                heightsMeters[northY * width + gridX]) *
                feetPerMeter) /
              ((southY - northY) * terrainGrid.spacingZFeet);
            const normalLength = Math.hypot(slopeX, slopeZ, 1);
            normals[index * 3] = -slopeX / normalLength;
            normals[index * 3 + 1] = slopeZ / normalLength;
            normals[index * 3 + 2] = 1 / normalLength;

            const color = terrainColor(elevationMeters);
            colors[index * 3] = color.r;
            colors[index * 3 + 1] = color.g;
            colors[index * 3 + 2] = color.b;
          }
        }
        positions.needsUpdate = true;
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

        const material = new THREE.MeshLambertMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.position.set(
          (terrainGrid.originXFeet +
            (tileColumn + 0.5) * terrainGrid.tileSize * terrainGrid.spacingXFeet) * visualScale,
          0,
          (terrainGrid.originZFeet +
            (tileRow + 0.5) * terrainGrid.tileSize * terrainGrid.spacingZFeet) * visualScale,
        );
        tileMeshes.push(mesh);
      }

      if (nextTileIndex < tileCount) {
        meshFrameId = requestAnimationFrame(buildMeshes);
        return;
      }

      const textureLoader = new THREE.TextureLoader();
      textureLoader.setCrossOrigin('anonymous');
      let nextImageryIndex = 0;
      let completedTiles = 0;
      let failedTiles = 0;

      // Replaces the fallback ground after geometry and texture uploads are ready.
      const commitMeshes = () => {
        if (cancelled || meshesCommitted || !imageryLoaded || pendingTextures.length > 0) return;
        disposeMeshes(terrainMeshesRef.current);
        tileMeshes.forEach(mesh => scene.add(mesh));
        terrainMeshesRef.current = tileMeshes;
        fallbackGround.visible = false;
        meshesCommitted = true;
        setImageryProgress({
          grid: terrainGrid,
          status:
            failedTiles === 0
              ? 'ready'
              : `partial (${failedTiles} tile${failedTiles === 1 ? '' : 's'} unavailable)`,
        });
      };

      // Limits texture uploads per frame to reduce rendering stalls.
      const uploadTextureBatch = () => {
        textureFrameId = 0;
        if (cancelled) return;
        for (let count = 0; count < TERRAIN_TEXTURES_PER_FRAME; count += 1) {
          const texture = pendingTextures.shift();
          if (!texture) break;
          renderer.initTexture(texture);
        }
        if (pendingTextures.length > 0) {
          textureFrameId = requestAnimationFrame(uploadTextureBatch);
        } else {
          commitMeshes();
        }
      };

      const queueTextureUpload = (texture: THREE.Texture) => {
        pendingTextures.push(texture);
        if (!textureFrameId) textureFrameId = requestAnimationFrame(uploadTextureBatch);
      };

      // Loads imagery tiles from a bounded pool of concurrent workers.
      const loadImageryWorker = async () => {
        while (!cancelled) {
          const index = nextImageryIndex;
          nextImageryIndex += 1;
          if (index >= terrainGrid.satelliteTiles.length) return;

          try {
            const texture = await textureLoader.loadAsync(
              getSatelliteTileUrl(terrainGrid.satelliteTiles[index]),
            );
            if (cancelled) {
              texture.dispose();
              continue;
            }

            texture.generateMipmaps = true;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.colorSpace = THREE.SRGBColorSpace;

            const material = tileMeshes[index].material;
            material.map = texture;
            material.vertexColors = false;
            material.needsUpdate = true;
            queueTextureUpload(texture);
          } catch {
            failedTiles += 1;
          } finally {
            completedTiles += 1;
            if (!cancelled && completedTiles % 16 === 0) {
              setImageryProgress({
                grid: terrainGrid,
                status: `loading ${completedTiles}/${terrainGrid.satelliteTiles.length}`,
              });
            }
          }
        }
      };

      Promise.all(
        Array.from(
          { length: Math.min(MAX_CONCURRENT_IMAGERY_REQUESTS, terrainGrid.satelliteTiles.length) },
          () => loadImageryWorker(),
        ),
      ).then(() => {
        if (cancelled) return;
        imageryLoaded = true;
        commitMeshes();
      });
    };

    meshFrameId = requestAnimationFrame(buildMeshes);

    return () => {
      cancelled = true;
      cancelAnimationFrame(meshFrameId);
      cancelAnimationFrame(textureFrameId);
      if (!meshesCommitted) disposeMeshes(tileMeshes);
    };
  }, [terrainGrid]);

  // Applies simulator position and attitude to the first-person camera.
  useEffect(() => {
    if (!cameraRef.current) return;

    const visualAlt = altitude * visualScale;
    const worldX = posX * visualScale;
    const worldZ = posZ * visualScale;
    cameraRef.current.position.set(worldX, visualAlt, worldZ);
    cameraRef.current.rotation.order = 'YXZ';
    cameraRef.current.rotation.y = -THREE.MathUtils.degToRad(heading);
    cameraRef.current.rotation.x = THREE.MathUtils.degToRad(pitch);
    cameraRef.current.rotation.z = -THREE.MathUtils.degToRad(roll);
  }, [posX, posZ, altitude, pitch, roll, heading]);

  // Creates/removes remote aircraft and buffers fresh samples for interpolation.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const currentPlayerIds = new Set(remoteTelemetries.map(telemetry => telemetry.playerId));

    for (const [playerId, instance] of remoteAircraftRef.current) {
      if (currentPlayerIds.has(playerId)) continue;
      scene.remove(instance.aircraft);
      disposeRemoteAircraft(instance.aircraft);
      remoteAircraftRef.current.delete(playerId);
    }

    for (const telemetry of remoteTelemetries) {
      let instance = remoteAircraftRef.current.get(telemetry.playerId);
      if (!instance) {
        const isAdsb = telemetry.playerId.startsWith('adsb:');
        const color = isAdsb
          ? 0x38bdf8
          : getPlayerAircraftColor(telemetry.playerId);
        const dimensions = isAdsb ? BOEING_767_DIMENSIONS : TORNADO_DIMENSIONS;
        const model = createRemoteAircraft(color, dimensions, isAdsb ? 'airliner' : 'fighter');
        scene.add(model.aircraft);
        instance = {
          ...model,
          samples: [],
          lastSequence: -1,
          lastArrivalIntervalMs: null,
          interarrivalJitterMs: 0,
        };
        remoteAircraftRef.current.set(telemetry.playerId, instance);
      }
      if (telemetry.sequence <= instance.lastSequence) continue;

      const localPosition = getLocalPosition(terrainOrigin, telemetry);
      const receivedAt = performance.now();
      const previousSample = instance.samples[instance.samples.length - 1];
      if (previousSample) {
        const arrivalIntervalMs = receivedAt - previousSample.receivedAt;
        if (instance.lastArrivalIntervalMs !== null) {
          const intervalVariation = Math.abs(
            arrivalIntervalMs - instance.lastArrivalIntervalMs,
          );
          instance.interarrivalJitterMs +=
            (intervalVariation - instance.interarrivalJitterMs) * 0.25;
        }
        instance.lastArrivalIntervalMs = arrivalIntervalMs;
      }
      instance.samples.push({
        receivedAt,
        telemetry,
        posXFeet: localPosition.posXFeet,
        posZFeet: localPosition.posZFeet,
      });
      instance.lastSequence = telemetry.sequence;
      if (instance.samples.length > MAX_REMOTE_SAMPLES) {
        instance.samples.splice(0, instance.samples.length - MAX_REMOTE_SAMPLES);
      }
    }
  }, [remoteTelemetries, terrainOrigin]);

  // Synchronizes local and relayed missile snapshots into shared scene objects.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const snapshots = [
      ...remoteTelemetries.flatMap(telemetry =>
        (telemetry.missiles ?? []).map(missile => ({
          ...missile,
          ownerId: telemetry.playerId,
        })),
      ),
    ];
    const activeKeys = new Set<string>();

    for (const missile of snapshots) {
      if (missile.ownerId === localPlayerIdRef.current) continue;
      const key = `${missile.ownerId}:${missile.missileId}`;
      const position = getLocalPosition(terrainOrigin, missile);
      const worldPosition = new THREE.Vector3(
        position.posXFeet * visualScale,
        missile.altitude * visualScale,
        position.posZFeet * visualScale,
      );
      if (missile.exploded) {
        if (!seenExplosionsRef.current.has(key)) {
          seenExplosionsRef.current.set(key, performance.now());
          explosionEffectsRef.current.push(createExplosion(scene, worldPosition));
        }
        const existing = missileInstancesRef.current.get(key);
        if (existing) {
          disposeMissile(scene, existing.model);
          missileInstancesRef.current.delete(key);
        }
        continue;
      }

      activeKeys.add(key);
      let instance = missileInstancesRef.current.get(key);
      const receivedAt = performance.now();
      const sample: MissileVisualSample = {
        position: worldPosition,
        heading: missile.heading,
        pitch: missile.pitch,
        receivedAt,
      };
      if (!instance) {
        const model = createMissile();
        model.position.copy(worldPosition);
        model.rotation.order = 'YXZ';
        model.rotation.y = -THREE.MathUtils.degToRad(missile.heading);
        model.rotation.x = THREE.MathUtils.degToRad(missile.pitch);
        scene.add(model);
        instance = { model, samples: [sample], locallySimulated: false };
        missileInstancesRef.current.set(key, instance);
      } else {
        const lastSample = instance.samples[instance.samples.length - 1];
        if (receivedAt > lastSample.receivedAt) instance.samples.push(sample);
        if (instance.samples.length > MAX_REMOTE_SAMPLES) {
          instance.samples.splice(0, instance.samples.length - MAX_REMOTE_SAMPLES);
        }
      }
    }

    for (const [key, instance] of missileInstancesRef.current) {
      if (instance.locallySimulated || activeKeys.has(key)) continue;
      disposeMissile(scene, instance.model);
      missileInstancesRef.current.delete(key);
    }

    const now = performance.now();
    seenExplosionsRef.current.forEach((time, key) => {
      if (now - time > 10_000) seenExplosionsRef.current.delete(key);
    });
  }, [localPlayerId, remoteTelemetries, terrainOrigin]);

  const imageryStatus =
    terrainGrid && imageryProgress?.grid === terrainGrid
      ? imageryProgress.status
      : terrainGrid
        ? 'loading'
        : 'waiting';
  const resourceErrors = [
    terrainStatus.startsWith('unavailable:') ? `TERRAIN ${terrainStatus}` : '',
    imageryStatus.startsWith('partial') ? `SATELLITE ${imageryStatus}` : '',
  ].filter(Boolean);

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden border-b border-zinc-800 bg-zinc-950 shadow-inner">
      <div ref={mountRef} className="w-full h-full" />
      {(radarEnabled || radarWarnings.length > 0) && (
        <div className="pointer-events-none absolute bottom-2 left-2 flex items-end gap-2 sm:bottom-3 sm:left-3 sm:gap-3">
          {radarEnabled && (
            <RadarScope
              contacts={radarContacts}
              scanAzimuth={radarScanAzimuth}
              scanBar={radarScanBar}
              primaryTargetId={primaryTargetId}
            />
          )}
          {radarWarnings.length > 0 && <RadarWarningReceiver contacts={radarWarnings} />}
        </div>
      )}
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2">
        <span className="absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-emerald-300/80" />
        <span className="absolute left-0 top-1/2 h-px w-3 -translate-y-1/2 bg-emerald-300/80" />
      </div>
      <div className="pointer-events-none absolute left-3 top-3 flex max-w-[75%] flex-col items-start gap-1 font-mono text-xs backdrop-blur">
        <span className="rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 text-emerald-300">
          MACHWEB
        </span>
        {resourceErrors.map(error => (
          <span
            key={error}
            className="max-w-full break-all rounded border border-red-500/60 bg-red-950/85 px-2 py-1 text-red-300"
          >
            {error}
          </span>
        ))}
      </div>
      <div className="pointer-events-none absolute right-3 top-3 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 font-mono text-xs text-zinc-200 backdrop-blur">
        LOCAL TIME {Math.floor(simulationTimeMinutes / 60).toString().padStart(2, '0')}:
        {Math.floor(simulationTimeMinutes % 60).toString().padStart(2, '0')}
      </div>
      <div className="pointer-events-none absolute right-3 top-10 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 font-mono text-[10px] text-sky-200 backdrop-blur sm:text-xs">
        {weather.kind.toUpperCase()} · WIND{' '}
        {Math.round(Math.hypot(weather.windEastKnots, weather.windNorthKnots))} KT
      </div>
      {crashed && (
        <div className="pointer-events-none absolute right-3 top-3 rounded border border-red-500/60 bg-red-950/85 px-3 py-1 font-mono text-sm font-bold tracking-widest text-red-300 backdrop-blur">
          CRASHED
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 right-3 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 text-right font-mono text-[10px] leading-4 text-zinc-200 backdrop-blur sm:text-xs">
        <div>HDG {heading.toFixed(0)}° · ALT {altitude.toFixed(0)} FT · {airspeed.toFixed(0)} KT</div>
        <div>PITCH {pitch.toFixed(0)}° · ROLL {roll.toFixed(0)}°</div>
        <div>
          THR {throttle.toFixed(0)}% · VS {verticalSpeed.toFixed(0)} FT/MIN
        </div>
      </div>
    </div>
  );
}