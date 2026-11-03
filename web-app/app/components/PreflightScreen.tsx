'use client';

import type { ChangeEvent, FormEvent } from 'react';

interface PreflightScreenProps {
  latitude: string;
  longitude: string;
  initialTime: string;
  error: string;
  onLatitudeChange(value: string): void;
  onLongitudeChange(value: string): void;
  onInitialTimeChange(value: string): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
}

export default function PreflightScreen({
  latitude,
  longitude,
  initialTime,
  error,
  onLatitudeChange,
  onLongitudeChange,
  onInitialTimeChange,
  onSubmit,
}: PreflightScreenProps) {
  const handleLatitudeChange = (event: ChangeEvent<HTMLInputElement>) => {
    onLatitudeChange(event.target.value);
  };

  const handleLongitudeChange = (event: ChangeEvent<HTMLInputElement>) => {
    onLongitudeChange(event.target.value);
  };

  const handleInitialTimeChange = (event: ChangeEvent<HTMLInputElement>) => {
    onInitialTimeChange(event.target.value);
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-950 p-4 font-mono text-zinc-100 sm:p-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(16,185,129,0.12),transparent_55%)]" />
      <section className="relative w-full max-w-3xl overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/95 shadow-2xl">
        <div className="border-b border-zinc-800 px-6 py-7 sm:px-10 sm:py-9">
          <p className="mb-3 text-xs font-bold tracking-[0.3em] text-emerald-400">MACHWEB // FLIGHT SIMULATOR</p>
          <h1 className="text-3xl font-bold tracking-wide text-zinc-100 sm:text-5xl">PREFLIGHT</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-400">
            Set up your flight before entering the cockpit. Your start location is locked for the duration of each flight.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-6 p-6 sm:p-10">
          <div>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold tracking-widest text-zinc-200">START LOCATION</h2>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-2 text-xs font-bold tracking-wider text-zinc-400">
                LATITUDE
                <input
                  type="number"
                  min="-85"
                  max="85"
                  step="any"
                  required
                  value={latitude}
                  onChange={handleLatitudeChange}
                  aria-label="Start latitude"
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-3 text-base font-normal tracking-normal text-zinc-100 outline-none transition focus:border-emerald-500"
                />
              </label>
              <label className="flex flex-col gap-2 text-xs font-bold tracking-wider text-zinc-400">
                LONGITUDE
                <input
                  type="number"
                  min="-180"
                  max="180"
                  step="any"
                  required
                  value={longitude}
                  onChange={handleLongitudeChange}
                  aria-label="Start longitude"
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-3 text-base font-normal tracking-normal text-zinc-100 outline-none transition focus:border-emerald-500"
                />
              </label>
            </div>
            <p className="mt-3 text-xs text-zinc-500">
              Initial values: Filton Airfield, Bristol, UK. Enter coordinates to select another area.
            </p>
          </div>

          <div className="border-t border-zinc-800 pt-5">
            <label className="flex max-w-sm flex-col gap-2 text-xs font-bold tracking-wider text-zinc-400">
              INITIAL TIME OF DAY
              <input
                type="time"
                required
                value={initialTime}
                onChange={handleInitialTimeChange}
                aria-label="Initial time of day"
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-3 text-base font-normal tracking-normal text-zinc-100 outline-none transition focus:border-emerald-500"
              />
            </label>
            <p className="mt-2 text-xs text-zinc-500">
              The 24-hour day/night cycle starts at this time and advances in real time.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-300">{error}</p>
          )}

          <button
            type="submit"
            className="flex w-full items-center justify-center rounded-lg border border-emerald-400/50 bg-emerald-500 px-5 py-4 text-sm font-bold tracking-[0.2em] text-zinc-950 transition hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2 focus:ring-offset-zinc-900"
          >
            START FLIGHT
          </button>
        </form>
        <div className="border-t border-zinc-800 px-6 py-3 text-center text-[10px] tracking-wider text-zinc-600 sm:px-10">
          LOCATION SETTINGS ARE LOCKED WHILE THE SIMULATION IS RUNNING
        </div>
      </section>
    </main>
  );
}
