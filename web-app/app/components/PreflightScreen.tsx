'use client';

import type { ChangeEvent, FormEvent } from 'react';
import type { WeatherPreset } from '../weather';

export interface HostPeerSession {
  id: string;
  offer: string;
  answer: string;
  answerApplied: boolean;
  status: string;
}

interface PreflightScreenProps {
  multiplayerRole: 'solo' | 'host' | 'join';
  multiplayerStatus: string;
  multiplayerBusy: boolean;
  canStartFlight: boolean;
  localDescription: string;
  remoteDescription: string;
  hostPeerSessions: HostPeerSession[];
  latitude: string;
  longitude: string;
  weatherPreset: WeatherPreset;
  weatherLabel: string;
  initialTime: string;
  adsbApiKey: string;
  rememberAdsbApiKey: boolean;
  adsbKeyStorageError: string;
  error: string;
  onMultiplayerRoleChange(role: 'solo' | 'host' | 'join'): void;
  onCreateOffer(): void;
  onCreateAnswer(): void;
  onApplyAnswer(sessionId: string): void;
  onHostAnswerChange(sessionId: string, value: string): void;
  onRemoteDescriptionChange(value: string): void;
  onLatitudeChange(value: string): void;
  onLongitudeChange(value: string): void;
  onWeatherPresetChange(value: WeatherPreset): void;
  onInitialTimeChange(value: string): void;
  onAdsbApiKeyChange(value: string): void;
  onRememberAdsbApiKeyChange(value: boolean): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
}

// Presents flight setup and multiplayer signaling controls through controlled props.
export default function PreflightScreen({
  multiplayerRole,
  multiplayerStatus,
  multiplayerBusy,
  canStartFlight,
  localDescription,
  remoteDescription,
  hostPeerSessions,
  latitude,
  longitude,
  weatherPreset,
  weatherLabel,
  initialTime,
  adsbApiKey,
  rememberAdsbApiKey,
  adsbKeyStorageError,
  error,
  onMultiplayerRoleChange,
  onCreateOffer,
  onCreateAnswer,
  onApplyAnswer,
  onHostAnswerChange,
  onRemoteDescriptionChange,
  onLatitudeChange,
  onLongitudeChange,
  onWeatherPresetChange,
  onInitialTimeChange,
  onAdsbApiKeyChange,
  onRememberAdsbApiKeyChange,
  onSubmit,
}: PreflightScreenProps) {
  // Forwards the edited latitude value to the owning page component.
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
          <p className="mb-3 text-xs font-bold tracking-[0.3em] text-emerald-400">MACHWEB</p>
          <h1 className="text-3xl font-bold tracking-wide text-zinc-100 sm:text-5xl">PREFLIGHT</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-400">
            Set up your flight before entering the cockpit.
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
              Enter coordinates to select starting location. Your start location is locked for the duration of each flight.
            </p>
          </div>

          {multiplayerRole === 'join' ? (
            <div className="border-t border-zinc-800 pt-5">
              <p className="text-xs leading-5 text-zinc-500">
                The host controls the weather and time of day for the shared flight. REAL weather,
                if selected by the host, is still fetched locally for your aircraft.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-3 border-t border-zinc-800 pt-5">
                <label className="flex max-w-xl flex-col gap-2 text-xs font-bold tracking-wider text-zinc-400">
                  WEATHER
                  <select
                    value={weatherPreset}
                    onChange={event => onWeatherPresetChange(event.target.value as WeatherPreset)}
                    aria-label="Flight weather"
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-3 text-base font-normal tracking-normal text-zinc-100 outline-none transition focus:border-emerald-500"
                  >
                    <option value="sun">SUN</option>
                    <option value="rain">RAIN</option>
                    <option value="snow">SNOW</option>
                    <option value="storm">LIGHTNING STORM</option>
                    <option value="real">REAL</option>
                  </select>
                </label>
                <p className="text-xs leading-5 text-zinc-500">
                  SUN, RAIN, SNOW, and LIGHTNING STORM are local presets. REAL fetches keyless
                  Open-Meteo conditions for the aircraft&apos;s current location at takeoff and every
                  minute. Wind, clouds, precipitation, visibility, and lightning apply locally
                  in each client.
                  {weatherPreset !== 'real' && ` Selected: ${weatherLabel}.`}
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
            </>
          )}

          <div className="space-y-4 border-t border-zinc-800 pt-5">
            <div>
              <h2 className="text-sm font-bold tracking-widest text-zinc-200">MULTIPLAYER LINK</h2>
              <p className="mt-2 text-xs leading-5 text-zinc-500">
                Optional direct connection. Exchange the complete offer and answer strings out-of-band.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {(['solo', 'host', 'join'] as const).map(role => (
                <button
                  key={role}
                  type="button"
                  aria-pressed={multiplayerRole === role}
                  disabled={multiplayerBusy}
                  onClick={() => onMultiplayerRoleChange(role)}
                  className={`rounded-lg border px-3 py-2 text-xs font-bold tracking-wider transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    multiplayerRole === role
                      ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                      : 'border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {role === 'solo' ? 'SOLO' : role === 'host' ? 'HOST' : 'JOIN'}
                </button>
              ))}
            </div>

            {multiplayerRole !== 'solo' && (
              <>
                <p role="status" aria-live="polite" className="text-xs text-emerald-300">
                  {multiplayerStatus}
                </p>

                {multiplayerRole === 'host' ? (
                  <>
                    <button
                      type="button"
                      onClick={onCreateOffer}
                      disabled={multiplayerBusy}
                      className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs font-bold tracking-wider text-zinc-200 transition hover:border-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      CREATE JOINER OFFER
                    </button>
                    <p className="text-xs leading-5 text-zinc-500">
                      Create a separate offer for each joiner. Share that offer, then paste that player&apos;s answer into its matching card.
                    </p>
                    {hostPeerSessions.map((session, index) => (
                      <div key={session.id} className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="text-xs font-bold tracking-wider text-zinc-200">JOINER {index + 1}</h3>
                          <span className="text-xs text-emerald-300">{session.status}</span>
                        </div>
                        <label className="flex flex-col gap-2 text-xs font-bold tracking-wider text-zinc-400">
                          OFFER TO SHARE
                          <textarea
                            readOnly
                            value={session.offer}
                            rows={3}
                            placeholder="Create an offer to generate a shareable string."
                            className="resize-y break-all rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-3 font-mono text-xs font-normal tracking-normal text-zinc-300 outline-none focus:border-emerald-500"
                          />
                        </label>
                        <label className="flex flex-col gap-2 text-xs font-bold tracking-wider text-zinc-400">
                          JOINER ANSWER
                          <textarea
                            value={session.answer}
                            onChange={event => onHostAnswerChange(session.id, event.target.value)}
                            rows={3}
                            placeholder="Paste this joiner's answer."
                            className="resize-y break-all rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-3 font-mono text-xs font-normal tracking-normal text-zinc-300 outline-none focus:border-emerald-500"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => onApplyAnswer(session.id)}
                          disabled={!session.answer.trim() || multiplayerBusy || !session.offer || session.answerApplied}
                          className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-4 py-2 text-xs font-bold tracking-wider text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          CONNECT JOINER {index + 1}
                        </button>
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <label className="flex flex-col gap-2 text-xs font-bold tracking-wider text-zinc-400">
                      HOST OFFER
                      <textarea
                        value={remoteDescription}
                        onChange={event => onRemoteDescriptionChange(event.target.value)}
                        rows={4}
                        placeholder="Paste the complete offer received from the host."
                        className="resize-y break-all rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-3 font-mono text-xs font-normal tracking-normal text-zinc-300 outline-none focus:border-emerald-500"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={onCreateAnswer}
                      disabled={!remoteDescription.trim() || multiplayerBusy}
                      className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs font-bold tracking-wider text-zinc-200 transition hover:border-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      CREATE ANSWER
                    </button>
                    <label className="flex flex-col gap-2 text-xs font-bold tracking-wider text-zinc-400">
                      ANSWER TO SHARE
                      <textarea
                        readOnly
                        value={localDescription}
                        rows={4}
                        placeholder="Create an answer to generate a shareable string."
                        className="resize-y break-all rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-3 font-mono text-xs font-normal tracking-normal text-zinc-300 outline-none focus:border-emerald-500"
                      />
                    </label>
                  </>
                )}
              </>
            )}
          </div>

          {multiplayerRole !== 'join' && (
            <div className="space-y-3 border-t border-zinc-800 pt-5">
              <div>
                <h2 className="text-sm font-bold tracking-widest text-zinc-200">LIVE ADS-B TRAFFIC</h2>
                <p className="mt-2 text-xs leading-5 text-zinc-500">
                  Optional. This browser polls FlyItalyADSB every 2 seconds within 100 km
                  (the Free plan&apos;s 30-requests-per-minute limit).
                  Hosts relay compact position snapshots to joiners; solo flights use the same feed directly.
                </p>
              </div>
              <label className="flex max-w-xl flex-col gap-2 text-xs font-bold tracking-wider text-zinc-400">
                FLYITALYADSB API KEY
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={adsbApiKey}
                  onChange={event => onAdsbApiKeyChange(event.target.value)}
                  aria-label="FlyItalyADSB API key"
                  placeholder="Optional API key"
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-3 text-base font-normal tracking-normal text-zinc-100 outline-none transition focus:border-emerald-500"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={rememberAdsbApiKey}
                  onChange={event => onRememberAdsbApiKeyChange(event.target.checked)}
                  className="h-4 w-4 accent-emerald-500"
                />
                Remember key for this tab session
              </label>
              <p className="text-xs leading-5 text-zinc-500">
                The key is sent only to FlyItalyADSB, never to peers. When enabled, it is saved in
                this tab&apos;s session storage so it survives reloads. Browser storage is
                accessible to scripts running on this site, so don&apos;t enable this on a shared
                or untrusted device. Uncheck to remove the saved copy.
                {' '}<a
                  className="text-emerald-300 underline underline-offset-2"
                  href="https://flyitalyadsb.com/data/api/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Get an API key
                </a>
              </p>
              {adsbKeyStorageError && (
                <p role="alert" className="text-xs text-amber-300">
                  {adsbKeyStorageError}
                </p>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-300">{error}</p>
          )}

          <button
            type="submit"
            disabled={!canStartFlight}
            className="flex w-full items-center justify-center rounded-lg border border-emerald-400/50 bg-emerald-500 px-5 py-4 text-sm font-bold tracking-[0.2em] text-zinc-950 transition hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            START FLIGHT
          </button>
        </form>
      </section>
    </main>
  );
}
