'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
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
}

const visualScale = 0.01;
const feetPerMeter = 3.28084;
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
}: FlightViewportProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const fallbackGroundRef = useRef<THREE.Group | null>(null);
  const terrainMeshRef = useRef<THREE.Mesh | null>(null);
  const terrainMaterialRef = useRef<THREE.MeshLambertMaterial | null>(null);

  useEffect(() => {
    const currentMount = mountRef.current;
    if (!currentMount) return;

    // 1. Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color(0x79b9dc);
    scene.fog = new THREE.Fog(0x79b9dc, 1500, 12000);

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
    terrainMaterialRef.current = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 2);
    dirLight.position.set(100, 200, 100);
    scene.add(dirLight);

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
          materials.forEach(material => material.dispose());
        }
      });
      renderer.domElement.remove();
      renderer.dispose();
      sceneRef.current = null;
      fallbackGroundRef.current = null;
      terrainMeshRef.current = null;
      terrainMaterialRef.current = null;
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    const fallbackGround = fallbackGroundRef.current;
    const terrainMaterial = terrainMaterialRef.current;
    if (!scene || !fallbackGround || !terrainMaterial) return;
    if (!terrainGrid) {
      fallbackGround.visible = true;
      const previousMesh = terrainMeshRef.current;
      if (previousMesh) {
        scene.remove(previousMesh);
        previousMesh.geometry.dispose();
        terrainMeshRef.current = null;
      }
      return;
    }

    const { width, height, heightsMeters } = terrainGrid;
    const geometry = new THREE.PlaneGeometry(
      (width - 1) * terrainGrid.spacingXFeet * visualScale,
      (height - 1) * terrainGrid.spacingZFeet * visualScale,
      width - 1,
      height - 1,
    );
    const positions = geometry.attributes.position;
    const colors = new Float32Array(width * height * 3);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const index = row * width + column;
        const elevationMeters = heightsMeters[index];
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

    const previousMesh = terrainMeshRef.current;
    if (previousMesh) {
      scene.remove(previousMesh);
      previousMesh.geometry.dispose();
    }
    const terrainMesh = new THREE.Mesh(geometry, terrainMaterial);
    terrainMesh.rotation.x = -Math.PI / 2;
    terrainMesh.position.set(
      (terrainGrid.originXFeet + ((width - 1) * terrainGrid.spacingXFeet) / 2) *
        visualScale,
      0,
      (terrainGrid.originZFeet + ((height - 1) * terrainGrid.spacingZFeet) / 2) *
        visualScale,
    );
    scene.add(terrainMesh);
    terrainMeshRef.current = terrainMesh;
    fallbackGround.visible = false;
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
        TERRAIN {terrainStatus}
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