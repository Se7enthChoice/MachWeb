'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { getAircraftCoordinates, getLocalPosition, getSatelliteTileUrl } from '../terrain';
import type { TerrainGrid, TerrainOrigin } from '../terrain';
import type { FlightTelemetry } from '../webrtc';
import RadarScope from './RadarScope';
import type { RadarContact } from './RadarScope';

interface FlightViewportProps {
  posX: number;
  posZ: number;
  altitude: number;
  pitch: number;
  roll: number;
  heading: number;
  airspeed: number;
  crashed: boolean;
  remoteTelemetries: FlightTelemetry[];
  radarContacts: RadarContact[];
  radarScanAzimuth: number;
  radarScanBar: number;
  terrainOrigin: TerrainOrigin;
  terrainGrid: TerrainGrid | null;
  terrainStatus: string;
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
}

const visualScale = 0.01;
const feetPerMeter = 3.28084;
const REMOTE_INTERPOLATION_DELAY_MS = 150;
const MAX_REMOTE_SAMPLES = 20;
const REMOTE_AIRCRAFT_COLORS = [0x38bdf8, 0xfbbf24, 0xf472b6, 0xa3e635, 0xc084fc];
const TERRAIN_MESH_SEGMENTS = 64;
const TERRAIN_MESHES_PER_FRAME = 4;
const TERRAIN_TEXTURES_PER_FRAME = 4;
const MAX_CONCURRENT_IMAGERY_REQUESTS = 8;
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

// Builds a lightweight remote-aircraft model and its navigation lights.
function createRemoteAircraft(color: number): { aircraft: THREE.Group; lights: THREE.Group } {
  const aircraft = new THREE.Group();
  const lights = new THREE.Group();
  const aircraftMaterial = new THREE.MeshLambertMaterial({ color });
  const cockpitMaterial = new THREE.MeshLambertMaterial({ color: 0xe0f2fe });
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

  const addAircraftLight = (x: number, y: number, z: number, color: number) => {
    const lightGroup = new THREE.Group();
    lightGroup.position.set(x, y, z);
    lightGroup.add(new THREE.PointLight(color, 3, 45, 2));
    lightGroup.add(new THREE.Mesh(
      new THREE.SphereGeometry(0.025, 8, 6),
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    ));
    lights.add(lightGroup);
  };

  addAircraftLight(-0.44, 0, -0.04, 0xff3030);
  addAircraftLight(0.44, 0, -0.04, 0x22ff77);
  addAircraftLight(0, 0.02, 0.4, 0xffffff);
  lights.visible = false;
  aircraft.add(lights);
  aircraft.visible = false;

  return { aircraft, lights };
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
  heading,
  airspeed,
  crashed,
  remoteTelemetries,
  radarContacts,
  radarScanAzimuth,
  radarScanBar,
  terrainOrigin,
  terrainGrid,
  terrainStatus,
  simulationTimeMinutes,
}: FlightViewportProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const simulationTimeRef = useRef(simulationTimeMinutes);
  const terrainOriginRef = useRef(terrainOrigin);
  const fallbackGroundRef = useRef<THREE.Group | null>(null);
  const remoteAircraftRef = useRef(new Map<string, RemoteAircraftInstance>());
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

    const lightTarget = new THREE.Vector3();
    const sunDirection = new THREE.Vector3();
    const moonDirection = new THREE.Vector3();
    const skyColor = new THREE.Color();
    const ambientColor = new THREE.Color();
    const sunlightColor = new THREE.Color();
    const moonlightColor = new THREE.Color();
    let lastShadowUpdate = 0;
    renderer.shadowMap.autoUpdate = false;

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
    // Interpolates remote traffic and updates time-dependent lighting each frame.
    const animate = () => {
      animId = requestAnimationFrame(animate);
      const timeMinutes = simulationTimeRef.current;
      const renderTime = performance.now() - REMOTE_INTERPOLATION_DELAY_MS;
      for (const instance of remoteAircrafts.values()) {
        const { aircraft, lights, samples } = instance;
        lights.visible = timeMinutes >= 18 * 60 || timeMinutes < 6 * 60;
        while (samples.length > 2 && samples[1].receivedAt <= renderTime) samples.shift();

        if (samples.length === 0 || performance.now() - samples[samples.length - 1].receivedAt > 2_000) {
          aircraft.visible = false;
          continue;
        }

        const first = samples[0];
        const second = samples[1];
        const amount = second
          ? THREE.MathUtils.clamp(
              (renderTime - first.receivedAt) / (second.receivedAt - first.receivedAt),
              0,
              1,
            )
          : 0;
        const start = first.telemetry;
        const end = second?.telemetry ?? start;
        aircraft.visible = true;
        aircraft.position.set(
          THREE.MathUtils.lerp(first.posXFeet, second?.posXFeet ?? first.posXFeet, amount) * visualScale,
          THREE.MathUtils.lerp(start.altitude, end.altitude, amount) * visualScale,
          THREE.MathUtils.lerp(first.posZFeet, second?.posZFeet ?? first.posZFeet, amount) * visualScale,
        );
        aircraft.rotation.order = 'YXZ';
        aircraft.rotation.y = -THREE.MathUtils.degToRad(
          interpolateAngle(start.heading, end.heading, amount),
        );
        aircraft.rotation.x = THREE.MathUtils.degToRad(
          THREE.MathUtils.lerp(start.pitch, end.pitch, amount),
        );
        aircraft.rotation.z = -THREE.MathUtils.degToRad(
          interpolateAngle(start.roll, end.roll, amount),
        );
      }

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

      scene.background = sky;
      if (scene.fog instanceof THREE.Fog) scene.fog.color.copy(sky);
      ambientLight.color.copy(ambientColor.copy(NIGHT_LIGHT).lerp(DAY_LIGHT, daylight));
      ambientLight.intensity = 0.18 + daylight * 1.02;
      dirLight.color.copy(sunlightColor.copy(TWILIGHT_SKY).lerp(DAY_LIGHT, daylight));
      dirLight.intensity = 0.08 + daylight * 1.92;
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
      scene.traverse(object => {
        if (object instanceof THREE.DirectionalLight) object.shadow.dispose();
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
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
      terrainMeshesRef.current = [];
    };
  }, []);

  // Keeps the displayed simulation time available to the render loop.
  useEffect(() => {
    simulationTimeRef.current = simulationTimeMinutes;
  }, [simulationTimeMinutes]);

  // Keeps geographic conversion aligned with the latest flight origin.
  useEffect(() => {
    terrainOriginRef.current = terrainOrigin;
  }, [terrainOrigin]);

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
        const model = createRemoteAircraft(getPlayerAircraftColor(telemetry.playerId));
        scene.add(model.aircraft);
        instance = {
          ...model,
          samples: [],
          lastSequence: -1,
        };
        remoteAircraftRef.current.set(telemetry.playerId, instance);
      }
      if (telemetry.sequence <= instance.lastSequence) continue;

      const localPosition = getLocalPosition(terrainOrigin, telemetry);
      instance.samples.push({
        receivedAt: performance.now(),
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
    <div className="relative h-[58vh] min-h-80 max-h-224 w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-inner sm:h-[70vh]">
      <div ref={mountRef} className="w-full h-full" />
      <RadarScope
        contacts={radarContacts}
        scanAzimuth={radarScanAzimuth}
        scanBar={radarScanBar}
      />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2">
        <span className="absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-emerald-300/80" />
        <span className="absolute left-0 top-1/2 h-px w-3 -translate-y-1/2 bg-emerald-300/80" />
      </div>
      <div className="pointer-events-none absolute left-3 top-3 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 font-mono text-xs text-emerald-300 backdrop-blur">
        MACHWEB
      </div>
      {resourceErrors.length > 0 && (
        <div className="pointer-events-none absolute left-3 top-10 max-w-[70%] break-all rounded border border-red-500/60 bg-red-950/85 px-2 py-1 font-mono text-xs text-red-300 backdrop-blur">
          {resourceErrors.join(' · ')}
        </div>
      )}
      <div className="pointer-events-none absolute right-3 top-3 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 font-mono text-xs text-zinc-200 backdrop-blur">
        LOCAL TIME {Math.floor(simulationTimeMinutes / 60).toString().padStart(2, '0')}:
        {Math.floor(simulationTimeMinutes % 60).toString().padStart(2, '0')}
      </div>
      {crashed && (
        <div className="pointer-events-none absolute right-3 top-3 rounded border border-red-500/60 bg-red-950/85 px-3 py-1 font-mono text-sm font-bold tracking-widest text-red-300 backdrop-blur">
          CRASHED
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 right-3 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 font-mono text-xs text-zinc-200 backdrop-blur">
        HDG {heading.toFixed(0)}° · ALT {altitude.toFixed(0)} FT · {airspeed.toFixed(0)} KT
      </div>
    </div>
  );
}