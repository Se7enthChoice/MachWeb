'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import FlightViewport from './components/FlightViewport';
import PreflightScreen from './components/PreflightScreen';
import {
  getTerrainNeighborhoodKey,
  loadTerrainGrid,
} from './terrain';
import type { TerrainGrid, TerrainOrigin } from './terrain';

interface SimEngineInstance {
  tick(dt: number): void;
  setPitchInput(value: number): void;
  setRollInput(value: number): void;
  setYawInput(value: number): void;
  setThrottle(value: number): void;
  setAutoLevel(enabled: boolean): void;
  setTerrainData(
    dataPointer: number,
    width: number,
    height: number,
    spacingXFeet: number,
    spacingZFeet: number,
    originXFeet: number,
    originZFeet: number,
  ): boolean;
  clearTerrainData(): void;
  getPosX(): number;
  getAltitude(): number;
  getPosZ(): number;
  getGroundElevation(): number;
  getAirspeed(): number;
  getThrottle(): number;
  getPitch(): number;
  getRoll(): number;
  getHeading(): number;
  getVerticalSpeed(): number;
  getStalled(): boolean;
  delete(): void;
}

interface SimEngineModule {
  SimEngine: new () => SimEngineInstance;
  HEAPF32: Float32Array;
  _malloc(byteLength: number): number;
  _free(pointer: number): void;
}

type SimEngineModuleFactory = (options: {
  locateFile(path: string): string;
}) => Promise<SimEngineModule>;

// Filton Airfield, Bristol, UK
const DEFAULT_LATITUDE = 51.5000;
const DEFAULT_LONGITUDE = -2.5833;

export default function Home() {
  const [latitudeInput, setLatitudeInput] = useState(String(DEFAULT_LATITUDE));
  const [longitudeInput, setLongitudeInput] = useState(String(DEFAULT_LONGITUDE));
  const [initialTimeInput, setInitialTimeInput] = useState('12:00');
  const [flightStartTimeMinutes, setFlightStartTimeMinutes] = useState(12 * 60);
  const [simulationTimeMinutes, setSimulationTimeMinutes] = useState(12 * 60);
  const [terrainOrigin, setTerrainOrigin] = useState<TerrainOrigin>({
    latitude: DEFAULT_LATITUDE,
    longitude: DEFAULT_LONGITUDE,
  });
  const [terrainGrid, setTerrainGrid] = useState<TerrainGrid | null>(null);
  const [terrainStatus, setTerrainStatus] = useState('waiting for flight dynamics');
  const [setupError, setSetupError] = useState('');
  const [simulationStarted, setSimulationStarted] = useState(false);
  const [flightReady, setFlightReady] = useState(false);
  const [altitude, setAltitude] = useState<number>(5000);
  const [groundElevation, setGroundElevation] = useState<number>(0);
  const [airspeed, setAirspeed] = useState<number>(300);
  const [throttle, setThrottle] = useState<number>(43);
  const [pitch, setPitch] = useState<number>(0);
  const [roll, setRoll] = useState<number>(0);
  const [heading, setHeading] = useState<number>(0);
  const [vSpeed, setVSpeed] = useState<number>(0);
  const [stalled, setStalled] = useState(false);
  const [posX, setPosX] = useState<number>(0);
  const [posZ, setPosZ] = useState<number>(0);
  const [autoLevel, setAutoLevel] = useState(false);
  const [status, setStatus] = useState<string>('Initializing flight dynamics...');

  const throttleRef = useRef(0.43);
  const autoLevelRef = useRef(false);
  const engineRef = useRef<SimEngineInstance | null>(null);
  const wasmModuleRef = useRef<SimEngineModule | null>(null);
  const latestPositionRef = useRef({ posX, posZ });
  const terrainNeighborhoodKey = getTerrainNeighborhoodKey(terrainOrigin, posX, posZ);

  const handleStartFlight = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const latitude = Number(latitudeInput);
    const longitude = Number(longitudeInput);
    const timeParts = initialTimeInput.split(':').map(Number);
    if (
      !Number.isFinite(latitude) ||
      latitude < -85 ||
      latitude > 85 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      timeParts.length !== 2 ||
      !Number.isInteger(timeParts[0]) ||
      !Number.isInteger(timeParts[1]) ||
      timeParts[0] < 0 ||
      timeParts[0] > 23 ||
      timeParts[1] < 0 ||
      timeParts[1] > 59
    ) {
      setSetupError('Enter valid coordinates and a valid initial time of day.');
      return;
    }

    const startTimeMinutes = timeParts[0] * 60 + timeParts[1];
    setSetupError('');
    setTerrainGrid(null);
    setTerrainOrigin({ latitude, longitude });
    setFlightStartTimeMinutes(startTimeMinutes);
    setSimulationTimeMinutes(startTimeMinutes);
    setTerrainStatus('waiting for flight dynamics');
    setStatus('Loading flight dynamics...');
    setSimulationStarted(true);
  };

  const handleEndFlight = () => {
    setSimulationStarted(false);
    setFlightReady(false);
    setTerrainGrid(null);
    setTerrainStatus('waiting for flight dynamics');
    setStatus('Ready for pre-flight setup');
    setPosX(0);
    setPosZ(0);
    setAltitude(5000);
    setGroundElevation(0);
    setAirspeed(300);
    setThrottle(43);
    setPitch(0);
    setRoll(0);
    setHeading(0);
    setVSpeed(0);
    setStalled(false);
  };

  const toggleAutoLevel = () => {
    const nextVal = !autoLevel;
    setAutoLevel(nextVal);
    autoLevelRef.current = nextVal;
  };

  useEffect(() => {
    if (!simulationStarted) return;

    let animationFrameId = 0;
    let disposed = false;
    let engineInstance: SimEngineInstance | null = null;

    const keysPressed = new Set<string>();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'KeyL' && !event.repeat) {
        setAutoLevel(prev => {
          const next = !prev;
          autoLevelRef.current = next;
          if (engineInstance) engineInstance.setAutoLevel(next);
          return next;
        });
        return;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
        event.preventDefault();
      }
      keysPressed.add(event.code);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      keysPressed.delete(event.code);
    };
    const handleBlur = () => keysPressed.clear();

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    async function initSim() {
      try {
        // The generated Emscripten module is served from public/wasm at runtime.
        // @ts-expect-error This public asset is not part of the TypeScript module graph.
        const moduleFactory = (await import(/* webpackIgnore: true */ '/wasm/sim-core.js')).default as SimEngineModuleFactory;
        const wasmModule = await moduleFactory({
          locateFile: (path: string) => `/wasm/${path}`,
        });
        if (disposed) return;

        engineInstance = new wasmModule.SimEngine();
        engineRef.current = engineInstance;
        wasmModuleRef.current = wasmModule;
        engineInstance.setAutoLevel(autoLevelRef.current);
        setStatus('Flight dynamics online - 6DOF');
        setFlightReady(true);

        let lastTime = performance.now();

        const loop = (currentTime: number) => {
          if (disposed) return;
          const dt = Math.max(0, (currentTime - lastTime) / 1000.0);
          lastTime = currentTime;
          const clampedDt = Math.min(dt, 0.1);

          if (engineInstance) {
            let pitchInput = 0;
            let rollInput = 0;
            let yawInput = 0;

            if (keysPressed.has('KeyW') || keysPressed.has('ArrowUp')) pitchInput += 1;
            if (keysPressed.has('KeyS') || keysPressed.has('ArrowDown')) pitchInput -= 1;
            if (keysPressed.has('KeyA') || keysPressed.has('ArrowLeft')) rollInput -= 1;
            if (keysPressed.has('KeyD') || keysPressed.has('ArrowRight')) rollInput += 1;
            if (keysPressed.has('KeyQ')) yawInput -= 1;
            if (keysPressed.has('KeyE')) yawInput += 1;

            if (keysPressed.has('ShiftLeft') || keysPressed.has('ShiftRight')) {
              throttleRef.current = Math.min(1.0, throttleRef.current + 0.4 * clampedDt);
            }
            if (keysPressed.has('ControlLeft') || keysPressed.has('ControlRight')) {
              throttleRef.current = Math.max(0.0, throttleRef.current - 0.4 * clampedDt);
            }

            engineInstance.setAutoLevel(autoLevelRef.current);
            engineInstance.setPitchInput(pitchInput);
            engineInstance.setRollInput(rollInput);
            engineInstance.setYawInput(yawInput);
            engineInstance.setThrottle(throttleRef.current);

            engineInstance.tick(clampedDt);

            const telemetry = [
              engineInstance.getPosX(),
              engineInstance.getAltitude(),
              engineInstance.getPosZ(),
              engineInstance.getGroundElevation(),
              engineInstance.getAirspeed(),
              engineInstance.getThrottle(),
              engineInstance.getPitch(),
              engineInstance.getRoll(),
              engineInstance.getHeading(),
              engineInstance.getVerticalSpeed(),
            ];
            if (!telemetry.every(Number.isFinite)) {
              setStatus('Flight dynamics halted: invalid telemetry');
              return;
            }

            const [nextPosX, nextAltitude, nextPosZ, nextGroundElevation,
              nextAirspeed, nextThrottle, nextPitch, nextRoll, nextHeading, nextVSpeed] = telemetry;
            setPosX(nextPosX);
            setAltitude(nextAltitude);
            setPosZ(nextPosZ);
            setGroundElevation(nextGroundElevation);
            setAirspeed(nextAirspeed);
            setThrottle(nextThrottle);
            setPitch(nextPitch);
            setRoll(nextRoll);
            setHeading(nextHeading);
            setVSpeed(nextVSpeed);
            setStalled(engineInstance.getStalled());
          }

          animationFrameId = requestAnimationFrame(loop);
        };

        animationFrameId = requestAnimationFrame(loop);
      } catch (err) {
        console.error('Failed to load Wasm module:', err);
        if (!disposed) setStatus('Error loading Wasm core');
      }
    }

    initSim();

    return () => {
      disposed = true;
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      cancelAnimationFrame(animationFrameId);
      engineInstance?.delete();
      engineRef.current = null;
      wasmModuleRef.current = null;
    };
  }, [simulationStarted]);

  useEffect(() => {
    if (!simulationStarted) return;

    const startedAt = Date.now();
    const updateSimulationTime = () => {
      const elapsedMinutes = (Date.now() - startedAt) / 60_000;
      setSimulationTimeMinutes((flightStartTimeMinutes + elapsedMinutes) % (24 * 60));
    };

    updateSimulationTime();
    const intervalId = window.setInterval(updateSimulationTime, 1000);
    return () => window.clearInterval(intervalId);
  }, [flightStartTimeMinutes, simulationStarted]);

  useEffect(() => {
    latestPositionRef.current = { posX, posZ };
  }, [posX, posZ]);

  useEffect(() => {
    const engine = engineRef.current;
    const wasmModule = wasmModuleRef.current;
    if (!flightReady || !engine || !wasmModule) return;

    let cancelled = false;
    setTerrainStatus('loading elevation tiles');
    const requestPosition = latestPositionRef.current;
    loadTerrainGrid(terrainOrigin, requestPosition.posX, requestPosition.posZ)
      .then(grid => {
        if (cancelled) return;

        const pointer = wasmModule._malloc(grid.heightsMeters.byteLength);
        if (pointer === 0) throw new Error('Could not allocate Wasm memory for terrain data.');
        try {
          // Upload the raster once per tile neighborhood; native physics samples its own cache.
          wasmModule.HEAPF32.set(grid.heightsMeters, pointer / Float32Array.BYTES_PER_ELEMENT);
          const accepted = engine.setTerrainData(
            pointer,
            grid.width,
            grid.height,
            grid.spacingXFeet,
            grid.spacingZFeet,
            grid.originXFeet,
            grid.originZFeet,
          );
          if (!accepted) throw new Error('The Wasm flight model rejected the terrain heightmap.');
        } finally {
          wasmModule._free(pointer);
        }

        setTerrainGrid(grid);
        setTerrainStatus('ready');
      })
      .catch(error => {
        if (cancelled) return;
        console.error('Failed to load terrain data:', error);
        const message = error instanceof Error ? error.message : String(error);
        setTerrainStatus(`unavailable: ${message}`);
      });

    return () => {
      cancelled = true;
    };
  }, [flightReady, terrainOrigin, terrainNeighborhoodKey]);

  if (!simulationStarted) {
    return (
      <PreflightScreen
        latitude={latitudeInput}
        longitude={longitudeInput}
        initialTime={initialTimeInput}
        error={setupError}
        onLatitudeChange={setLatitudeInput}
        onLongitudeChange={setLongitudeInput}
        onInitialTimeChange={setInitialTimeInput}
        onSubmit={handleStartFlight}
      />
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-stretch justify-start bg-zinc-950 p-3 font-mono text-zinc-100 sm:p-5">
      <div className="mx-auto w-full max-w-[1600px] rounded-xl border border-zinc-800 bg-zinc-900 p-3 shadow-2xl sm:p-5">

        {/* Header */}
        <div className="mb-4 flex items-center justify-between border-b border-zinc-800 pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-wider text-emerald-400">
              MACHWEB
            </h1>
            <p className="text-xs text-zinc-400 mt-1">{status}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-4">
            <button
              onClick={toggleAutoLevel}
              className={`px-3 py-1.5 rounded text-xs font-bold border transition-colors ${
                autoLevel
                  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50'
                  : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-zinc-200'
              }`}
            >
              FLIGHT ASSIST (L): {autoLevel ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={handleEndFlight}
              className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-bold text-zinc-300 transition-colors hover:border-red-500/50 hover:bg-red-950/40 hover:text-red-300"
            >
              END FLIGHT
            </button>
          </div>
        </div>

        {/* 3D Viewport */}
        <div className="mb-4">
          <FlightViewport
            posX={posX}
            posZ={posZ}
            altitude={altitude}
            pitch={pitch}
            roll={roll}
            heading={heading}
            airspeed={airspeed}
            stalled={stalled}
            terrainGrid={terrainGrid}
            terrainStatus={terrainStatus}
            simulationTimeMinutes={simulationTimeMinutes}
          />
        </div>

        {/* Instruments */}
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5 sm:gap-4">
          <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-center">
            <span className="text-xs text-zinc-500 uppercase tracking-widest block mb-1">Airspeed</span>
            <span className="text-2xl font-bold text-zinc-100">{airspeed.toFixed(0)}</span>
            <span className="text-xs text-zinc-600 block mt-1">KNOTS</span>
          </div>

          <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-center">
            <span className="text-xs text-zinc-500 uppercase tracking-widest block mb-1">Altitude</span>
            <span className="text-2xl font-bold text-emerald-400">{altitude.toFixed(0)}</span>
            <span className="text-xs text-zinc-600 block mt-1">FEET MSL</span>
          </div>

          <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-center">
            <span className="text-xs text-zinc-500 uppercase tracking-widest block mb-1">Ground</span>
            <span className="text-2xl font-bold text-zinc-100">{groundElevation.toFixed(0)}</span>
            <span className="text-xs text-zinc-600 block mt-1">FEET MSL</span>
          </div>

          <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-center">
            <span className="text-xs text-zinc-500 uppercase tracking-widest block mb-1">Attitude</span>
            <div className="text-sm font-bold text-zinc-200 mt-1">
              P: {pitch.toFixed(0)}°<br />
              R: {roll.toFixed(0)}°
            </div>
            <span className="text-xs text-zinc-600 block mt-1">PITCH / ROLL</span>
          </div>

          <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-center">
            <span className="text-xs text-zinc-500 uppercase tracking-widest block mb-1">Heading</span>
            <span className="text-2xl font-bold text-zinc-100">{heading.toFixed(0)}°</span>
            <span className="text-xs text-zinc-600 block mt-1">COMPASS</span>
          </div>
        </div>

        {/* Secondary Telemetry */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800 flex justify-between items-center px-4">
            <span className="text-xs text-zinc-400">THROTTLE SETTING</span>
            <span className="text-lg font-bold text-amber-400">{throttle.toFixed(0)}%</span>
          </div>
          <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800 flex justify-between items-center px-4">
            <span className="text-xs text-zinc-400">VERTICAL SPEED</span>
            <span className="text-lg font-bold text-zinc-200">{vSpeed.toFixed(0)} FT/MIN</span>
          </div>
        </div>

        {/* Controls Legend */}
        <div className="bg-zinc-950/50 border border-zinc-800/80 rounded-lg p-4 text-xs text-zinc-400">
          <p className="font-bold text-zinc-300 mb-2">PILOT FLIGHT CONTROLS:</p>
          <div className="grid grid-cols-2 gap-2">
            <div><strong className="text-emerald-400">W / S</strong>: Pitch up / down</div>
            <div><strong className="text-emerald-400">A / D</strong>: Bank for turns</div>
            <div><strong className="text-emerald-400">Q / E</strong>: Rudder yaw / sideslip</div>
            <div><strong className="text-emerald-400">SHIFT / CTRL</strong>: Throttle up / down</div>
            <div><strong className="text-emerald-400">L</strong> (or button): Toggle flight assist</div>
          </div>
        </div>
      </div>
    </main>
  );
}