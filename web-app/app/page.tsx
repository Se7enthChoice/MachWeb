'use client';

import { useEffect, useRef, useState } from 'react';
import FlightViewport from './components/FlightViewport';

interface SimEngineInstance {
  tick(dt: number): void;
  setPitchInput(value: number): void;
  setRollInput(value: number): void;
  setYawInput(value: number): void;
  setThrottle(value: number): void;
  setAutoLevel(enabled: boolean): void;
  getPosX(): number;
  getAltitude(): number;
  getPosZ(): number;
  getAirspeed(): number;
  getThrottle(): number;
  getPitch(): number;
  getRoll(): number;
  getHeading(): number;
  getVerticalSpeed(): number;
  delete(): void;
}

interface SimEngineModule {
  SimEngine: new () => SimEngineInstance;
}

type SimEngineModuleFactory = (options: {
  locateFile(path: string): string;
}) => Promise<SimEngineModule>;

export default function Home() {
  const [altitude, setAltitude] = useState<number>(5000);
  const [airspeed, setAirspeed] = useState<number>(300);
  const [throttle, setThrottle] = useState<number>(43);
  const [pitch, setPitch] = useState<number>(0);
  const [roll, setRoll] = useState<number>(0);
  const [heading, setHeading] = useState<number>(0);
  const [vSpeed, setVSpeed] = useState<number>(0);
  const [posX, setPosX] = useState<number>(0);
  const [posZ, setPosZ] = useState<number>(0);
  const [autoLevel, setAutoLevel] = useState(false);
  const [status, setStatus] = useState<string>('Initializing flight dynamics...');

  const throttleRef = useRef(0.43);
  const autoLevelRef = useRef(false);

  const toggleAutoLevel = () => {
    const nextVal = !autoLevel;
    setAutoLevel(nextVal);
    autoLevelRef.current = nextVal;
  };

  useEffect(() => {
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
        engineInstance.setAutoLevel(autoLevelRef.current);
        setStatus('Flight dynamics online - 6DOF');

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

            const [nextPosX, nextAltitude, nextPosZ, nextAirspeed, nextThrottle,
              nextPitch, nextRoll, nextHeading, nextVSpeed] = telemetry;
            setPosX(nextPosX);
            setAltitude(nextAltitude);
            setPosZ(nextPosZ);
            setAirspeed(nextAirspeed);
            setThrottle(nextThrottle);
            setPitch(nextPitch);
            setRoll(nextRoll);
            setHeading(nextHeading);
            setVSpeed(nextVSpeed);
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
    };
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 text-zinc-100 p-6 font-mono">
      <div className="max-w-4xl w-full bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-2xl">

        {/* Header */}
        <div className="flex justify-between items-center border-b border-zinc-800 pb-4 mb-6">
          <div>
            <h1 className="text-xl font-bold tracking-wider text-emerald-400">
              MACHWEB // FIRST-PERSON FLIGHT
            </h1>
            <p className="text-xs text-zinc-400 mt-1">{status}</p>
          </div>
          <div className="flex items-center gap-4">
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
            <div className="text-right text-xs text-zinc-500">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse mr-2"></span>
              6DOF // WASM
            </div>
          </div>
        </div>

        {/* 3D Viewport */}
        <div className="mb-6">
          <FlightViewport
            posX={posX}
            posZ={posZ}
            altitude={altitude}
            pitch={pitch}
            roll={roll}
            heading={heading}
            airspeed={airspeed}
          />
        </div>

        {/* Instruments */}
        <div className="grid grid-cols-4 gap-4 mb-6">
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
            <div><strong className="text-emerald-400">A / D</strong>: Roll left / right</div>
            <div><strong className="text-emerald-400">Q / E</strong>: Yaw left / right</div>
            <div><strong className="text-emerald-400">SHIFT / CTRL</strong>: Throttle up / down</div>
            <div><strong className="text-emerald-400">L</strong> (or button): Toggle flight assist</div>
          </div>
        </div>
      </div>
    </main>
  );
}