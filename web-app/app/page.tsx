'use client';

import { useEffect, useState, useRef } from 'react';

export default function Home() {
  const [altitude, setAltitude] = useState<number>(0);
  const [airspeed, setAirspeed] = useState<number>(0);
  const [throttle, setThrottle] = useState<number>(80);
  const [pitch, setPitch] = useState<number>(0);
  const [vSpeed, setVSpeed] = useState<number>(0);
  const [status, setStatus] = useState<string>('Initializing Wasm Physics Core...');

  // Use refs to keep track of live control inputs inside the 60Hz loop without re-triggering useEffect
  const controlRef = useRef({ pitch: 0.0, throttle: 0.8 });

  useEffect(() => {
    let animationFrameId: number;
    let engineInstance: any = null;

    // Keyboard controls state
    const keysPressed: { [key: string]: boolean } = {};

    const handleKeyDown = (e: KeyboardEvent) => {
      keysPressed[e.code] = true;
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysPressed[e.code] = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    async function initSim() {
      try {
        // 1. Load Wasm module dynamically
        // @ts-ignore
        const ModuleFactory = await import(/* webpackIgnore: true */ '/wasm/sim-core.js');
        const Module = await ModuleFactory.default({
          locateFile: (path: string) => `/wasm/${path}`,
        });

        // 2. Instantiate C++ SimEngine
        engineInstance = new Module.SimEngine();
        setStatus('Flight Sim Active - C++ Physics Engine Online');

        let lastTime = performance.now();

        // 3. The 60Hz Main Loop
        const loop = (currentTime: number) => {
          const dt = (currentTime - lastTime) / 1000.0;
          lastTime = currentTime;
          const clampedDt = Math.min(dt, 0.1);

          if (engineInstance) {
            // Process keyboard input adjustments
            if (keysPressed['KeyW'] || keysPressed['ArrowDown']) {
              controlRef.current.pitch = Math.min(85, controlRef.current.pitch + 25 * clampedDt); // Pull up
            }
            if (keysPressed['KeyS'] || keysPressed['ArrowUp']) {
              controlRef.current.pitch = Math.max(-85, controlRef.current.pitch - 25 * clampedDt); // Push down
            }
            if (keysPressed['KeyA']) {
              controlRef.current.pitch = 0; // Level out quick
            }

            if (keysPressed['ShiftLeft'] || keysPressed['ShiftRight']) {
              controlRef.current.throttle = Math.min(1.0, controlRef.current.throttle + 0.3 * clampedDt);
            }
            if (keysPressed['ControlLeft'] || keysPressed['ControlRight']) {
              controlRef.current.throttle = Math.max(0.0, controlRef.current.throttle - 0.3 * clampedDt);
            }

            // Send inputs to C++ Core
            engineInstance.setPitch(controlRef.current.pitch);
            engineInstance.setThrottle(controlRef.current.throttle);

            // Step the simulation physics forward
            engineInstance.tick(clampedDt);

            // Read telemetry back from C++
            setAltitude(engineInstance.getAltitude());
            setAirspeed(engineInstance.getAirspeed());
            setThrottle(engineInstance.getThrottle());
            setPitch(engineInstance.getPitch());
            setVSpeed(engineInstance.getVerticalSpeed());
          }

          animationFrameId = requestAnimationFrame(loop);
        };

        animationFrameId = requestAnimationFrame(loop);
      } catch (err) {
        console.error('Failed to load Wasm module:', err);
        setStatus('Error loading Wasm core');
      }
    }

    initSim();

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      if (engineInstance && engineInstance.delete) {
        engineInstance.delete();
      }
    };
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 text-zinc-100 p-6 font-mono">
      <div className="max-w-3xl w-full bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-2xl">
        {/* Header */}
        <div className="flex justify-between items-center border-b border-zinc-800 pb-4 mb-6">
          <div>
            <h1 className="text-xl font-bold tracking-wider text-emerald-400">
              3RD-GEN TACTICAL FLIGHT SIM
            </h1>
            <p className="text-xs text-zinc-400 mt-1">{status}</p>
          </div>
          <div className="text-right text-xs text-zinc-500">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse mr-2"></span>
            Wasm / C++23 Core
          </div>
        </div>

        {/* Flight Instruments Dashboard */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-center">
            <span className="text-xs text-zinc-500 uppercase tracking-widest block mb-1">Airspeed</span>
            <span className="text-3xl font-bold text-zinc-100">{airspeed.toFixed(0)}</span>
            <span className="text-xs text-zinc-600 block mt-1">KNOTS</span>
          </div>

          <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-center">
            <span className="text-xs text-zinc-500 uppercase tracking-widest block mb-1">Altitude</span>
            <span className="text-3xl font-bold text-emerald-400">{altitude.toFixed(0)}</span>
            <span className="text-xs text-zinc-600 block mt-1">FEET MSL</span>
          </div>

          <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-center">
            <span className="text-xs text-zinc-500 uppercase tracking-widest block mb-1">Pitch Angle</span>
            <span className="text-3xl font-bold text-zinc-100">{pitch.toFixed(1)}°</span>
            <span className="text-xs text-zinc-600 block mt-1">ATTITUDE</span>
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

        {/* Flight Controls Legend */}
        <div className="bg-zinc-950/50 border border-zinc-800/80 rounded-lg p-4 text-xs text-zinc-400">
          <p className="font-bold text-zinc-300 mb-2">PILOT FLIGHT CONTROLS:</p>
          <div className="grid grid-cols-2 gap-2">
            <div><strong className="text-emerald-400">W / S</strong> (or Arrow Up/Down): Pitch Down / Up</div>
            <div><strong className="text-emerald-400">SHIFT / CTRL</strong>: Increase / Decrease Throttle</div>
            <div><strong className="text-emerald-400">A</strong>: Level Pitch Instantly</div>
          </div>
        </div>
      </div>
    </main>
  );
}