'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { getSatelliteTileUrl } from '../terrain';
import type { TerrainGrid } from '../terrain';

interface FlightViewportProps {
  posX: number;
  posZ: number;
  altitude: number;
  pitch: number;
  roll: number;
  heading: number;
  airspeed: number;
  stalled: boolean;
  terrainGrid: TerrainGrid | null;
  terrainStatus: string;
  simulationTimeMinutes: number;
}

const visualScale = 0.01;
const feetPerMeter = 3.28084;
const TERRAIN_MESH_SEGMENTS = 64;
const MAX_CONCURRENT_IMAGERY_REQUESTS = 8;
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

function terrainColor(elevationMeters: number): THREE.Color {
  if (elevationMeters < 0) return terrainColors[0]; 
  if (elevationMeters < 300) return terrainColors[1];
  if (elevationMeters < 1000) return terrainColors[2];
  if (elevationMeters < 2000) return terrainColors[3];
  if (elevationMeters < 3500) return terrainColors[4];
  return terrainColors[5];
}

export default function FlightViewport({
  posX,
  posZ,
  altitude,
  pitch,
  roll,
  heading,
  airspeed,
  stalled,
  terrainGrid,
  terrainStatus,
  simulationTimeMinutes,
}: FlightViewportProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const ambientLightRef = useRef<THREE.AmbientLight | null>(null);
  const sunLightRef = useRef<THREE.DirectionalLight | null>(null);
  const fallbackGroundRef = useRef<THREE.Group | null>(null);
  const terrainMeshesRef = useRef<
    Array<THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>>
  >([]);
  const [imageryProgress, setImageryProgress] = useState<{
    grid: TerrainGrid;
    status: string;
  } | null>(null);

  useEffect(() => {
    const currentMount = mountRef.current;
    if (!currentMount) return;

    // 1. Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = DAY_SKY.clone();
    // Fog is measured in scene units (feet * visualScale), not simulator feet.
    scene.fog = new THREE.Fog(DAY_SKY, 1250, 2500);

    // 2. Camera (First-Person FOV)
    const width = Math.max(currentMount.clientWidth, 1);
    const height = Math.max(currentMount.clientHeight, 1);
    const camera = new THREE.PerspectiveCamera(80, width / height, 0.1, 20000);
    cameraRef.current = camera;

    // 3. Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
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
    fallbackGround.add(ground);

    const gridHelper = new THREE.GridHelper(20000, 200, 0x79a78f, 0x39564a);
    gridHelper.position.y = 0.1;
    fallbackGround.add(gridHelper);
    scene.add(fallbackGround);
    fallbackGroundRef.current = fallbackGround;

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
    scene.add(ambientLight);
    ambientLightRef.current = ambientLight;
    const dirLight = new THREE.DirectionalLight(0xffffff, 2);
    dirLight.position.set(100, 200, 100);
    scene.add(dirLight);
    sunLightRef.current = dirLight;

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
    const animate = () => {
      animId = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();
    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(animId);
      scene.traverse(object => {
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
      sceneRef.current = null;
      ambientLightRef.current = null;
      sunLightRef.current = null;
      fallbackGroundRef.current = null;
      terrainMeshesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    const ambientLight = ambientLightRef.current;
    const sunLight = sunLightRef.current;
    if (!scene || !ambientLight || !sunLight || !(scene.fog instanceof THREE.Fog)) return;

    // Solar height follows a simple local 24-hour cycle: sunrise at 06:00, sunset at 18:00.
    const solarAngle = (simulationTimeMinutes / (24 * 60)) * Math.PI * 2 - Math.PI / 2;
    const solarHeight = Math.sin(solarAngle);
    const daylight = THREE.MathUtils.clamp((solarHeight + 0.12) / 0.32, 0, 1);
    const twilight = 1 - THREE.MathUtils.clamp(Math.abs(solarHeight) * 3, 0, 1);
    const skyColor = NIGHT_SKY.clone()
      .lerp(TWILIGHT_SKY, twilight)
      .lerp(DAY_SKY, daylight);

    scene.background = skyColor;
    scene.fog.color.copy(skyColor);
    ambientLight.color.copy(NIGHT_LIGHT).lerp(DAY_LIGHT, daylight);
    ambientLight.intensity = 0.18 + daylight * 1.02;
    sunLight.color.copy(TWILIGHT_SKY).lerp(DAY_LIGHT, daylight);
    sunLight.intensity = 0.08 + daylight * 1.92;
    sunLight.position.set(
      Math.cos(solarAngle) * 100,
      solarHeight * 200,
      100,
    );
  }, [simulationTimeMinutes]);

  useEffect(() => {
    const scene = sceneRef.current;
    const fallbackGround = fallbackGroundRef.current;
    if (!scene || !fallbackGround) return;
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
    // Sample every fourth raster pixel so wider terrain stays near the original vertex budget.
    const sampleStride = terrainGrid.tileSize / TERRAIN_MESH_SEGMENTS;
    for (let tileRow = 0; tileRow < terrainGrid.tileRows; tileRow += 1) {
      for (let tileColumn = 0; tileColumn < terrainGrid.tileColumns; tileColumn += 1) {
        const geometry = new THREE.PlaneGeometry(
          terrainGrid.tileSize * terrainGrid.spacingXFeet * visualScale,
          terrainGrid.tileSize * terrainGrid.spacingZFeet * visualScale,
          TERRAIN_MESH_SEGMENTS,
          TERRAIN_MESH_SEGMENTS,
        );
        const positions = geometry.attributes.position;
        const colors = new Float32Array(positions.count * 3);
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

            const color = terrainColor(elevationMeters);
            colors[index * 3] = color.r;
            colors[index * 3 + 1] = color.g;
            colors[index * 3 + 2] = color.b;
          }
        }
        positions.needsUpdate = true;
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.computeVertexNormals();

        const material = new THREE.MeshLambertMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(
          (terrainGrid.originXFeet +
            (tileColumn + 0.5) * terrainGrid.tileSize * terrainGrid.spacingXFeet) * visualScale,
          0,
          (terrainGrid.originZFeet +
            (tileRow + 0.5) * terrainGrid.tileSize * terrainGrid.spacingZFeet) * visualScale,
        );
        scene.add(mesh);
        tileMeshes.push(mesh);
      }
    }

    terrainMeshesRef.current.forEach(mesh => {
      scene.remove(mesh);
      mesh.geometry.dispose();
      if (mesh.material.map) mesh.material.map.dispose();
      mesh.material.dispose();
    });
    terrainMeshesRef.current = tileMeshes;
    fallbackGround.visible = false;
    let cancelled = false;
    const textureLoader = new THREE.TextureLoader();
    textureLoader.setCrossOrigin('anonymous');
    let nextTileIndex = 0;
    let completedTiles = 0;
    let failedTiles = 0;

    const loadImageryWorker = async () => {
      while (!cancelled) {
        const index = nextTileIndex;
        nextTileIndex += 1;
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
      setImageryProgress({
        grid: terrainGrid,
        status:
          failedTiles === 0
            ? 'ready'
            : `partial (${failedTiles} tile${failedTiles === 1 ? '' : 's'} unavailable)`,
      });
    });

    return () => {
      cancelled = true;
      tileMeshes.forEach(mesh => {
        scene.remove(mesh);
        mesh.geometry.dispose();
        if (mesh.material.map) mesh.material.map.dispose();
        mesh.material.dispose();
      });
      if (terrainMeshesRef.current === tileMeshes) terrainMeshesRef.current = [];
    };
  }, [terrainGrid]);

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

  const imageryStatus =
    terrainGrid && imageryProgress?.grid === terrainGrid
      ? imageryProgress.status
      : terrainGrid
        ? 'loading'
        : 'waiting';

  return (
    <div className="relative h-[58vh] min-h-80 max-h-224 w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-inner sm:h-[70vh]">
      <div ref={mountRef} className="w-full h-full" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2">
        <span className="absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-emerald-300/80" />
        <span className="absolute left-0 top-1/2 h-px w-3 -translate-y-1/2 bg-emerald-300/80" />
      </div>
      <div className="pointer-events-none absolute left-3 top-3 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 font-mono text-xs text-emerald-300 backdrop-blur">
        MACHWEB
      </div>
      <div className="pointer-events-none absolute left-3 top-10 max-w-[70%] break-all rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 font-mono text-xs text-zinc-300 backdrop-blur">
        TERRAIN {terrainStatus} · SATELLITE {imageryStatus}
      </div>
      <div className="pointer-events-none absolute right-3 top-3 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 font-mono text-xs text-zinc-200 backdrop-blur">
        LOCAL TIME {Math.floor(simulationTimeMinutes / 60).toString().padStart(2, '0')}:
        {Math.floor(simulationTimeMinutes % 60).toString().padStart(2, '0')}
      </div>
      {stalled && (
        <div className="pointer-events-none absolute right-3 top-3 rounded border border-red-500/60 bg-red-950/85 px-3 py-1 font-mono text-sm font-bold tracking-widest text-red-300 backdrop-blur">
          STALL
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 right-3 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 font-mono text-xs text-zinc-200 backdrop-blur">
        HDG {heading.toFixed(0)}° · ALT {altitude.toFixed(0)} FT · {airspeed.toFixed(0)} KT
      </div>
    </div>
  );
}