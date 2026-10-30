'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

interface FlightViewportProps {
  posX: number;
  posZ: number;
  altitude: number;
  pitch: number;
  roll: number;
  heading: number;
  airspeed: number;
  stalled: boolean;
}

export default function FlightViewport({ posX, posZ, altitude, pitch, roll, heading, airspeed, stalled }: FlightViewportProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);

  useEffect(() => {
    const currentMount = mountRef.current;
    if (!currentMount) return;

    // 1. Scene
    const scene = new THREE.Scene();
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
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(20000, 20000),
      new THREE.MeshLambertMaterial({ color: 0x263e3a }),
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const gridHelper = new THREE.GridHelper(20000, 200, 0x79a78f, 0x39564a);
    gridHelper.position.y = 0.1;
    scene.add(gridHelper);

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
    };
  }, []);

  useEffect(() => {
    if (!cameraRef.current) return;

    const visualScale = 0.01;
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
    <div className="relative h-[58vh] min-h-80 max-h-[56rem] w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-inner sm:h-[70vh]">
      <div ref={mountRef} className="w-full h-full" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2">
        <span className="absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-emerald-300/80" />
        <span className="absolute left-0 top-1/2 h-px w-3 -translate-y-1/2 bg-emerald-300/80" />
      </div>
      <div className="pointer-events-none absolute left-3 top-3 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 font-mono text-xs text-emerald-300 backdrop-blur">
        MACHWEB // FIRST-PERSON
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