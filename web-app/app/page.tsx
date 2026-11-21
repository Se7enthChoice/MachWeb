'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import FlightViewport from './components/FlightViewport';
import PreflightScreen from './components/PreflightScreen';
import { sortRadarContactsByRange } from './components/RadarScope';
import type { RadarContact } from './components/RadarScope';
import type { RadarWarningContact } from './components/RadarWarningReceiver';
import type { HostPeerSession } from './components/PreflightScreen';
import {
  ADSB_POLL_INTERVAL_MS,
  ADSB_TRACK_TTL_MS,
  createAdsbSnapshotMessage,
  fetchAdsbAircraft,
  parseAdsbSnapshotMessage,
} from './adsb';
import type { AdsbAircraft } from './adsb';
import {
  getAircraftCoordinates,
  getLocalPosition,
  getTerrainNeighborhoodKey,
  loadTerrainGrid,
} from './terrain';
import type { TerrainGrid, TerrainOrigin } from './terrain';
import {
  createPresetWeather,
  createRealWeatherLoadingState,
  fetchCurrentWeather,
} from './weather';
import type { WeatherPreset, WeatherState } from './weather';
import {
  decodeSessionDescription,
  encodeSessionDescription,
  parseFlightWeatherMessage,
  parseFlightTimeMessage,
  parseFlightTelemetryMessage,
  waitForIceGatheringComplete,
} from './webrtc';
import type {
  CountermeasureTelemetry,
  FlightTelemetry,
  MissileTelemetry,
  ReceivedFlightTelemetry,
} from './webrtc';
import type { LocalPose } from './components/FlightViewport';

interface SimEngineInstance {
  tick(dt: number): void;
  setInitialConditions(altitude: number, heading: number): void;
  setPitchInput(value: number): void;
  setRollInput(value: number): void;
  setYawInput(value: number): void;
  setThrottle(value: number): void;
  // Keep the Wasm gear state synchronized with the keyboard/HUD state.
  setLandingGearDown(down: boolean): void;
  setBrakeInput(braking: boolean): void;
  setWind(eastKnots: number, northKnots: number): void;
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
  getAirspeed(): number;
  getThrottle(): number;
  getPitch(): number;
  getRoll(): number;
  getHeading(): number;
  getVerticalSpeed(): number;
  // True only when deployed gear is supporting the aircraft on terrain.
  getOnGround(): boolean;
  getCrashed(): boolean;
  setRadarEnabled(enabled: boolean): void;
  clearRadarTargets(): void;
  addRadarTarget(id: number, posX: number, altitude: number, posZ: number): boolean;
  clearMissileTargets(): void;
  addMissileTarget(id: number, posX: number, altitude: number, posZ: number): boolean;
  clearCountermeasureTargets(): void;
  addCountermeasureTarget(
    id: number,
    type: number,
    posX: number,
    altitude: number,
    posZ: number,
    ageSeconds: number,
  ): boolean;
  deployChaff(): boolean;
  deployFlare(): boolean;
  getRadarContactCount(): number;
  getRadarContactTargetId(index: number): number;
  getRadarContactRangeNm(index: number): number;
  getRadarContactAzimuth(index: number): number;
  getRadarContactElevation(index: number): number;
  getRadarContactAge(index: number): number;
  getRadarScanAzimuth(): number;
  getRadarScanBar(): number;
  launchMissile(typeId: number, selectedTargetId: number): number;
  getMissileCount(): number;
  getMissileId(index: number): number;
  getMissileTypeId(index: number): number;
  getMissileTargetId(index: number): number;
  getMissilePosX(index: number): number;
  getMissileAltitude(index: number): number;
  getMissilePosZ(index: number): number;
  getMissileHeading(index: number): number;
  getMissilePitch(index: number): number;
  getMissileExploded(index: number): boolean;
  getMissileImpactTargetId(index: number): number;
  getMissileTriggersRwr(index: number): boolean;
  getCountermeasureCount(): number;
  getCountermeasureId(index: number): number;
  getCountermeasureType(index: number): number;
  getCountermeasurePosX(index: number): number;
  getCountermeasureAltitude(index: number): number;
  getCountermeasurePosZ(index: number): number;
  getCountermeasureAge(index: number): number;
  applyMissileImpact(): void;
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

const MAX_RADAR_TARGETS = 64;
const TELEMETRY_SEND_INTERVAL_SECONDS = 1 / 30;
const HUD_UI_INTERVAL_SECONDS = 1 / 30;
const MAX_RECEIVED_TELEMETRY_SAMPLES = 64;
const MAX_TELEMETRY_BUFFERED_BYTES = 16 * 1024;
const REAL_WEATHER_POLL_INTERVAL_MS = 60 * 1000;
const ADSB_API_KEY_SESSION_STORAGE_KEY = 'machweb.adsbApiKey';

// Generates a UUID without requiring a secure context. crypto.randomUUID() is
// restricted to secure contexts, but getRandomValues() is available on HTTP
// LAN origins in supported browsers.
function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    // Last-resort compatibility fallback for browsers without Web Crypto.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  // Set the UUID version (4) and variant (RFC 4122) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

// Formats elapsed simulation minutes as a zero-padded 24-hour clock.
function formatTimeOfDay(totalMinutes: number): string {
  const wholeMinutes = Math.floor(totalMinutes) % (24 * 60);
  const hours = Math.floor(wholeMinutes / 60);
  const minutes = wholeMinutes % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function getRadarWarningContacts(
  localPlayerId: string,
  remoteTelemetries: FlightTelemetry[],
  receivedAt: Map<string, number>,
  now: number,
  terrainOrigin: TerrainOrigin,
  posX: number,
  posZ: number,
  altitude: number,
  heading: number,
  pitch: number,
  roll: number,
): RadarWarningContact[] {
  if (!localPlayerId) return [];

  const headingRadians = (heading * Math.PI) / 180;
  const pitchRadians = (pitch * Math.PI) / 180;
  const rollRadians = (roll * Math.PI) / 180;
  const sinHeading = Math.sin(headingRadians);
  const cosHeading = Math.cos(headingRadians);
  const sinPitch = Math.sin(pitchRadians);
  const cosPitch = Math.cos(pitchRadians);
  const sinRoll = Math.sin(rollRadians);
  const cosRoll = Math.cos(rollRadians);
  const forward = [sinHeading * cosPitch, sinPitch, -cosHeading * cosPitch];
  const right = [
    cosHeading * cosRoll + sinHeading * sinPitch * sinRoll,
    -cosPitch * sinRoll,
    sinHeading * cosRoll - cosHeading * sinPitch * sinRoll,
  ];

  const getAzimuth = (relative: number[]) => {
    const forwardDistance = relative.reduce(
      (sum, value, index) => sum + value * forward[index],
      0,
    );
    const rightDistance = relative.reduce(
      (sum, value, index) => sum + value * right[index],
      0,
    );
    return Math.atan2(rightDistance, forwardDistance) * (180 / Math.PI);
  };
  const radarWarnings = remoteTelemetries
    .filter(
      telemetry =>
        telemetry.radarDetectedPlayerIds?.includes(localPlayerId) &&
        now - (receivedAt.get(telemetry.playerId) ?? 0) <= 2000,
    )
    .map(telemetry => {
      const emitter = getLocalPosition(terrainOrigin, telemetry);
      const relative = [
        emitter.posXFeet - posX,
        telemetry.altitude - altitude,
        emitter.posZFeet - posZ,
      ];
      return { emitterId: telemetry.playerId, azimuth: getAzimuth(relative) };
    });
  const missileWarnings = remoteTelemetries.flatMap(telemetry => {
    if (
      now - (receivedAt.get(telemetry.playerId) ?? 0) > 2000 ||
      !telemetry.missiles
    ) {
      return [];
    }
    return telemetry.missiles
      .filter(
        missile =>
          missile.triggersRwr &&
          !missile.exploded &&
          missile.targetPlayerId === localPlayerId,
      )
      .map(missile => {
        const missilePosition = getLocalPosition(terrainOrigin, missile);
        return {
          emitterId: `missile-${telemetry.playerId}-${missile.missileId}`,
          azimuth: getAzimuth([
            missilePosition.posXFeet - posX,
            missile.altitude - altitude,
            missilePosition.posZFeet - posZ,
          ]),
        };
      });
  });
  return [...radarWarnings, ...missileWarnings];
}

// Owns preflight state, the Wasm simulation loop, and multiplayer coordination.
export default function Home() {
  // Preflight selections and the terrain currently loaded into the simulation.
  const [latitudeInput, setLatitudeInput] = useState(String(DEFAULT_LATITUDE));
  const [longitudeInput, setLongitudeInput] = useState(String(DEFAULT_LONGITUDE));
  const [startingAltitudeInput, setStartingAltitudeInput] = useState('5000');
  const [startingHeadingInput, setStartingHeadingInput] = useState('0');
  const [initialTimeInput, setInitialTimeInput] = useState('');
  const [flightStartTimeMinutes, setFlightStartTimeMinutes] = useState(0);
  const [simulationTimeMinutes, setSimulationTimeMinutes] = useState(0);
  const simulationTimeRef = useRef(simulationTimeMinutes);
  const [terrainOrigin, setTerrainOrigin] = useState<TerrainOrigin>({
    latitude: DEFAULT_LATITUDE,
    longitude: DEFAULT_LONGITUDE,
  });
  const [terrainGrid, setTerrainGrid] = useState<TerrainGrid | null>(null);
  const [terrainStatus, setTerrainStatus] = useState('waiting for flight dynamics');
  const [weatherPreset, setWeatherPreset] = useState<WeatherPreset>('real');
  const weatherPresetRef = useRef<WeatherPreset>('real');
  const [weather, setWeather] = useState<WeatherState>(() => createRealWeatherLoadingState());
  const [weatherStatus, setWeatherStatus] = useState('');
  const [setupError, setSetupError] = useState('');
  const [adsbApiKey, setAdsbApiKey] = useState('');
  const [rememberAdsbApiKey, setRememberAdsbApiKey] = useState(false);
  const [adsbKeyStorageError, setAdsbKeyStorageError] = useState('');
  const [adsbAircraft, setAdsbAircraft] = useState<AdsbAircraft[]>([]);
  const [adsbSequence, setAdsbSequence] = useState(0);
  const [adsbStatus, setAdsbStatus] = useState('ADS-B off - add an API key in preflight.');

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;

      try {
        const savedKey = window.sessionStorage.getItem(ADSB_API_KEY_SESSION_STORAGE_KEY);
        if (savedKey) {
          setAdsbApiKey(savedKey);
          setRememberAdsbApiKey(true);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setAdsbKeyStorageError(`Could not read the saved ADS-B key: ${message}`);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  const handleAdsbApiKeyChange = (value: string): void => {
    setAdsbApiKey(value);
    try {
      if (rememberAdsbApiKey && value) {
        window.sessionStorage.setItem(ADSB_API_KEY_SESSION_STORAGE_KEY, value);
      } else {
        window.sessionStorage.removeItem(ADSB_API_KEY_SESSION_STORAGE_KEY);
      }
      setAdsbKeyStorageError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAdsbKeyStorageError(`Could not save the ADS-B key in this tab: ${message}`);
    }
  };

  const handleRememberAdsbApiKeyChange = (remember: boolean): void => {
    setRememberAdsbApiKey(remember);
    try {
      if (remember && adsbApiKey) {
        window.sessionStorage.setItem(ADSB_API_KEY_SESSION_STORAGE_KEY, adsbApiKey);
      } else {
        window.sessionStorage.removeItem(ADSB_API_KEY_SESSION_STORAGE_KEY);
      }
      setAdsbKeyStorageError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAdsbKeyStorageError(`Could not save the ADS-B key in this tab: ${message}`);
    }
  };

  // WebRTC signaling state and the latest telemetry received from each player.
  const [multiplayerRole, setMultiplayerRole] = useState<'solo' | 'host' | 'join'>('solo');
  const [multiplayerStatus, setMultiplayerStatus] = useState('Solo flight');
  const [multiplayerBusy, setMultiplayerBusy] = useState(false);
  const [multiplayerConnected, setMultiplayerConnected] = useState(false);
  const [localDescription, setLocalDescription] = useState('');
  const [remoteDescription, setRemoteDescription] = useState('');
  const [hostPeerSessions, setHostPeerSessions] = useState<HostPeerSession[]>([]);
  const [remoteTelemetryByPlayer, setRemoteTelemetryByPlayer] = useState<
    Record<string, FlightTelemetry>
  >({});

  // Live aircraft instruments and radar display state.
  const [simulationStarted, setSimulationStarted] = useState(false);
  const [flightReady, setFlightReady] = useState(false);
  const [altitude, setAltitude] = useState<number>(5000);
  const [airspeed, setAirspeed] = useState<number>(300);
  const [throttle, setThrottle] = useState<number>(43);
  const [pitch, setPitch] = useState<number>(0);
  const [roll, setRoll] = useState<number>(0);
  const [heading, setHeading] = useState<number>(0);
  const [verticalSpeed, setVerticalSpeed] = useState<number>(0);
  const [crashed, setCrashed] = useState(false);
  // React state drives the HUD; the ref lets the key handler and Wasm startup read synchronously.
  const [landingGearDown, setLandingGearDown] = useState(true);
  const [radarEnabled, setRadarEnabled] = useState(true);
  const [radarContacts, setRadarContacts] = useState<RadarContact[]>([]);
  const [radarScanAzimuth, setRadarScanAzimuth] = useState(-60);
  const [radarScanBar, setRadarScanBar] = useState(1);
  const [radarWarnings, setRadarWarnings] = useState<RadarWarningContact[]>([]);
  const [primaryTargetId, setPrimaryTargetId] = useState<number | null>(null);
  const [localPlayerId, setLocalPlayerId] = useState('');
  const localMissilesRef = useRef<MissileTelemetry[]>([]);
  // The renderer reads live decoy snapshots without waiting for React state updates.
  const localCountermeasuresRef = useRef<CountermeasureTelemetry[]>([]);
  const [posX, setPosX] = useState<number>(0);
  const [posZ, setPosZ] = useState<number>(0);
  const [status, setStatus] = useState<string>('Initializing flight dynamics...');

  // Mutable values shared with callbacks and animation loops without rerendering.
  const throttleRef = useRef(0.43);
  // Keep the current gear state available before React renders the HUD update.
  const landingGearDownRef = useRef(true);
  const weatherRef = useRef(weather);
  const radarEnabledRef = useRef(radarEnabled);
  const engineRef = useRef<SimEngineInstance | null>(null);
  const wasmModuleRef = useRef<SimEngineModule | null>(null);
  const latestPositionRef = useRef({ posX, posZ });
  const peerConnectionsRef = useRef(new Map<string, RTCPeerConnection>());
  const dataChannelsRef = useRef(new Map<string, RTCDataChannel>());
  const peerPlayersRef = useRef(new Map<string, Set<string>>());
  const multiplayerOperationRef = useRef(false);
  const hostTimeSequenceRef = useRef(0);
  const hostWeatherSequenceRef = useRef(0);
  const playerIdRef = useRef('');
  const telemetrySequenceRef = useRef(0);
  const remoteTelemetriesRef = useRef<FlightTelemetry[]>([]);
  // Newest snapshot per peer; React state only tracks which peers exist, not every packet.
  const remotePlayersRef = useRef<Record<string, FlightTelemetry>>({});
  const adsbTelemetriesRef = useRef<FlightTelemetry[]>([]);
  const remoteTelemetryReceivedAtRef = useRef(new Map<string, number>());
  const remoteTelemetrySamplesRef = useRef(new Map<string, ReceivedFlightTelemetry[]>());
  const localPoseRef = useRef<LocalPose | null>(null);
  const radarTargetIdsRef = useRef(new Map<string, number>());
  const radarTargetPlayerIdsRef = useRef(new Map<number, string>());
  const radarTargetKindsRef = useRef(new Map<number, 'player' | 'adsb'>());
  const nextRadarTargetIdRef = useRef(1);
  const radarContactsRef = useRef<RadarContact[]>([]);
  const primaryTargetIdRef = useRef<number | null>(null);
  const adsbAircraftRef = useRef<AdsbAircraft[]>([]);
  const adsbSequenceRef = useRef(0);
  const missileLaunchRequestedRef = useRef(false);
  const missileLaunchTypeRef = useRef(1);
  const countermeasureDeployRequestedRef = useRef<'chaff' | 'flare' | null>(null);
  const processedMissileImpactsRef = useRef(new Map<string, number>());
  const terrainNeighborhoodKey = getTerrainNeighborhoodKey(terrainOrigin, posX, posZ);

  const adsbTelemetries = useMemo<FlightTelemetry[]>(
    () =>
      adsbAircraft.map(aircraft => ({
        playerId: `adsb:${aircraft.hex}`,
        isHost: false,
        posX: 0,
        posZ: 0,
        altitude: aircraft.altitude,
        pitch: 0,
        roll: 0,
        heading: aircraft.heading,
        airspeed: aircraft.groundSpeed,
        throttle: 0,
        verticalSpeed: aircraft.verticalSpeed,
        crashed: false,
        latitude: aircraft.latitude,
        longitude: aircraft.longitude,
        sourceAgeSeconds: aircraft.positionAgeSeconds,
        sequence: adsbSequence,
        simulationTimeMinutes: 0,
      })),
    [adsbAircraft, adsbSequence],
  );
  const remoteTelemetries = useMemo(
    () => [...Object.values(remoteTelemetryByPlayer), ...adsbTelemetries],
    [adsbTelemetries, remoteTelemetryByPlayer],
  );

  const applyAdsbSnapshot = useCallback((aircraft: AdsbAircraft[], sequence: number): void => {
    const activeIds = new Set(aircraft.map(contact => `adsb:${contact.hex}`));
    remoteTelemetryReceivedAtRef.current.forEach((_, playerId) => {
      if (playerId.startsWith('adsb:') && !activeIds.has(playerId)) {
        remoteTelemetryReceivedAtRef.current.delete(playerId);
      }
    });
    const receivedAt = performance.now();
    aircraft.forEach(contact =>
      remoteTelemetryReceivedAtRef.current.set(
        `adsb:${contact.hex}`,
        receivedAt - contact.positionAgeSeconds * 1000,
      ),
    );
    adsbAircraftRef.current = aircraft;
    adsbSequenceRef.current = sequence;
    setAdsbAircraft(aircraft);
    setAdsbSequence(sequence);
  }, []);

  const handleRadarToggle = (): void => {
    const nextEnabled = !radarEnabledRef.current;
    radarEnabledRef.current = nextEnabled;
    engineRef.current?.setRadarEnabled(nextEnabled);
    setRadarEnabled(nextEnabled);
    setRadarContacts([]);
    radarContactsRef.current = [];
    primaryTargetIdRef.current = null;
    setPrimaryTargetId(null);
  };

  // Synchronizes connection state and host-facing joiner status.
  const refreshConnectedPeers = (): void => {
    const connectedCount = Array.from(dataChannelsRef.current.values())
      .filter(channel => channel.readyState === 'open').length;
    setMultiplayerConnected(connectedCount > 0);
    if (multiplayerRole === 'host') {
      setMultiplayerStatus(
        connectedCount === 0
          ? 'No joiners connected. Create an offer for each player.'
          : `${connectedCount} joiner${connectedCount === 1 ? '' : 's'} connected.`,
      );
    }
  };

  // Sends the host's current time with a sequence number for stale-message filtering.
  const sendHostTime = (channel: RTCDataChannel, minutes: number): void => {
    if (channel.readyState !== 'open') return;
    const sequence = hostTimeSequenceRef.current;
    hostTimeSequenceRef.current += 1;
    try {
      channel.send(JSON.stringify({ type: 'flight-time', minutes, sequence }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMultiplayerStatus(`Could not sync host time: ${message}`);
    }
  };

  const sendHostWeather = (channel: RTCDataChannel, preset: WeatherPreset): void => {
    if (channel.readyState !== 'open') return;
    const sequence = hostWeatherSequenceRef.current;
    hostWeatherSequenceRef.current += 1;
    try {
      channel.send(JSON.stringify({ type: 'flight-weather', preset, sequence }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMultiplayerStatus(`Could not sync host weather: ${message}`);
    }
  };

  const sendAdsbSnapshot = useCallback((
    channel: RTCDataChannel,
    sequence: number,
    aircraft: AdsbAircraft[],
  ): void => {
    if (
      channel.readyState !== 'open' ||
      channel.bufferedAmount > MAX_TELEMETRY_BUFFERED_BYTES
    ) {
      return;
    }
    try {
      channel.send(createAdsbSnapshotMessage(sequence, aircraft));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMultiplayerStatus(`Could not relay ADS-B contacts: ${message}`);
    }
  }, []);

  // Closes all peer resources and clears multiplayer state.
  const closePeerConnections = (): void => {
    dataChannelsRef.current.forEach(channel => channel.close());
    peerConnectionsRef.current.forEach(connection => connection.close());
    dataChannelsRef.current.clear();
    peerConnectionsRef.current.clear();
    peerPlayersRef.current.clear();
    remoteTelemetryReceivedAtRef.current.clear();
    remoteTelemetrySamplesRef.current.clear();
    remotePlayersRef.current = {};
    radarTargetIdsRef.current.clear();
    radarTargetPlayerIdsRef.current.clear();
    radarTargetKindsRef.current.clear();
    nextRadarTargetIdRef.current = 1;
    setRemoteTelemetryByPlayer({});
    setRadarContacts([]);
    radarContactsRef.current = [];
    primaryTargetIdRef.current = null;
    setPrimaryTargetId(null);
    applyAdsbSnapshot([], 0);
    setRadarWarnings([]);
    setHostPeerSessions([]);
    setMultiplayerConnected(false);
  };

  // Tracks connection lifecycle changes for one signaling session.
  const configurePeerConnection = (
    connection: RTCPeerConnection,
    sessionId: string,
    role: 'host' | 'join',
  ): void => {
    connection.onconnectionstatechange = () => {
      if (peerConnectionsRef.current.get(sessionId) !== connection) return;
      if (connection.connectionState === 'connected') {
        setHostPeerSessions(sessions =>
          sessions.map(session =>
            session.id === sessionId ? { ...session, status: 'connected' } : session,
          ),
        );
      } else if (connection.connectionState === 'failed') {
        setHostPeerSessions(sessions =>
          sessions.map(session =>
            session.id === sessionId ? { ...session, status: 'connection failed' } : session,
          ),
        );
        if (role === 'join') setMultiplayerStatus('Connection failed. This network may require a TURN relay.');
      } else if (connection.connectionState === 'disconnected') {
        setHostPeerSessions(sessions =>
          sessions.map(session =>
            session.id === sessionId ? { ...session, status: 'disconnected' } : session,
          ),
        );
      }
    };
  };

  // Registers data-channel handlers for time and telemetry exchange.
  const configureDataChannel = (
    channel: RTCDataChannel,
    sessionId: string,
    role: 'host' | 'join',
  ): void => {
    const lastReceivedSequences = new Map<string, number>();
    let lastReceivedTimeSequence = -1;
    let lastReceivedWeatherSequence = -1;
    let lastReceivedAdsbSequence = -1;
    let receivedHostTelemetry = false;
    dataChannelsRef.current.set(sessionId, channel);
    peerPlayersRef.current.set(sessionId, new Set());
    channel.onopen = () => {
      if (dataChannelsRef.current.get(sessionId) !== channel) return;
      setHostPeerSessions(sessions =>
        sessions.map(session =>
          session.id === sessionId ? { ...session, status: 'connected' } : session,
        ),
      );
      refreshConnectedPeers();
      if (role === 'join') {
        setMultiplayerStatus('Connected to host.');
      } else {
        const timeParts = initialTimeInput.split(':').map(Number);
        const selectedTime = timeParts[0] * 60 + timeParts[1];
        sendHostTime(channel, simulationStarted ? simulationTimeRef.current : selectedTime);
        sendHostWeather(channel, weatherPresetRef.current);
        sendAdsbSnapshot(channel, adsbSequenceRef.current, adsbAircraftRef.current);
      }
    };
    channel.onclose = () => {
      if (dataChannelsRef.current.get(sessionId) !== channel) return;
      dataChannelsRef.current.delete(sessionId);
      peerConnectionsRef.current.get(sessionId)?.close();
      peerConnectionsRef.current.delete(sessionId);
      const playerIds = peerPlayersRef.current.get(sessionId) ?? new Set<string>();
      peerPlayersRef.current.delete(sessionId);
      playerIds.forEach(playerId => {
        delete remotePlayersRef.current[playerId];
        remoteTelemetryReceivedAtRef.current.delete(playerId);
        remoteTelemetrySamplesRef.current.delete(playerId);
      });
      remoteTelemetriesRef.current = [
        ...Object.values(remotePlayersRef.current),
        ...adsbTelemetriesRef.current,
      ];
      setRemoteTelemetryByPlayer({ ...remotePlayersRef.current });
      setHostPeerSessions(sessions =>
        sessions.map(session =>
          session.id === sessionId ? { ...session, status: 'disconnected' } : session,
        ),
      );
      refreshConnectedPeers();
    };
    channel.onerror = () => {
      setHostPeerSessions(sessions =>
        sessions.map(session =>
          session.id === sessionId ? { ...session, status: 'data channel error' } : session,
        ),
      );
    };
    channel.onmessage = event => {
      if (dataChannelsRef.current.get(sessionId) !== channel) return;
      if (typeof event.data !== 'string' || event.data.length > 16_384) {
        setMultiplayerStatus('Received an unsupported multiplayer message.');
        return;
      }
      const hostTime = parseFlightTimeMessage(event.data);
      if (hostTime) {
        if (
          role === 'join' &&
          !receivedHostTelemetry &&
          hostTime.sequence > lastReceivedTimeSequence
        ) {
          lastReceivedTimeSequence = hostTime.sequence;
          simulationTimeRef.current = hostTime.minutes;
          setFlightStartTimeMinutes(hostTime.minutes);
          setSimulationTimeMinutes(hostTime.minutes);
          setInitialTimeInput(formatTimeOfDay(hostTime.minutes));
        }
        return;
      }

      const hostWeather = parseFlightWeatherMessage(event.data);
      if (hostWeather) {
        if (role === 'join' && hostWeather.sequence > lastReceivedWeatherSequence) {
          lastReceivedWeatherSequence = hostWeather.sequence;
          applyWeatherPreset(hostWeather.preset);
        }
        return;
      }

      const adsbSnapshot = parseAdsbSnapshotMessage(event.data);
      if (adsbSnapshot) {
        if (role === 'join' && adsbSnapshot.sequence > lastReceivedAdsbSequence) {
          lastReceivedAdsbSequence = adsbSnapshot.sequence;
          applyAdsbSnapshot(adsbSnapshot.aircraft, adsbSnapshot.sequence);
          setAdsbStatus(`LIVE ADS-B · ${adsbSnapshot.aircraft.length} tracks from host`);
        }
        return;
      }

      const telemetry = parseFlightTelemetryMessage(event.data);
      if (!telemetry) {
        setMultiplayerStatus('Received invalid telemetry from a peer.');
        return;
      }
      if (telemetry.sequence <= (lastReceivedSequences.get(telemetry.playerId) ?? -1)) {
        return;
      }
      lastReceivedSequences.set(telemetry.playerId, telemetry.sequence);
      peerPlayersRef.current.get(sessionId)?.add(telemetry.playerId);
      // Stamp arrival here, not when React renders, so interpolation sees real packet timing.
      const receivedAt = performance.now();
      remoteTelemetryReceivedAtRef.current.set(telemetry.playerId, receivedAt);
      const receivedSamples = remoteTelemetrySamplesRef.current.get(telemetry.playerId) ?? [];
      receivedSamples.push({ telemetry, receivedAt });
      if (receivedSamples.length > MAX_RECEIVED_TELEMETRY_SAMPLES) {
        receivedSamples.splice(0, receivedSamples.length - MAX_RECEIVED_TELEMETRY_SAMPLES);
      }
      remoteTelemetrySamplesRef.current.set(telemetry.playerId, receivedSamples);
      // Only a new peer needs a React update; later packets reach consumers through refs.
      const isNewPlayer = !(telemetry.playerId in remotePlayersRef.current);
      remotePlayersRef.current[telemetry.playerId] = telemetry;
      remoteTelemetriesRef.current = [
        ...Object.values(remotePlayersRef.current),
        ...adsbTelemetriesRef.current,
      ];
      if (isNewPlayer) setRemoteTelemetryByPlayer({ ...remotePlayersRef.current });

      if (role === 'host') {
        for (const [otherSessionId, otherChannel] of dataChannelsRef.current) {
          if (otherSessionId !== sessionId && otherChannel.readyState === 'open') {
            try {
              otherChannel.send(event.data);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              setMultiplayerStatus(`Could not relay peer telemetry: ${message}`);
            }
          }
        }
      } else if (telemetry.isHost) {
        receivedHostTelemetry = true;
        simulationTimeRef.current = telemetry.simulationTimeMinutes;
        setSimulationTimeMinutes(telemetry.simulationTimeMinutes);
        setInitialTimeInput(formatTimeOfDay(telemetry.simulationTimeMinutes));
      }
    };
  };

  // Updates the selected time and immediately syncs valid host changes to joiners.
  const handleInitialTimeChange = (value: string): void => {
    if (multiplayerRole === 'join') return;
    setInitialTimeInput(value);
    if (multiplayerRole !== 'host' || !/^\d{2}:\d{2}$/.test(value)) return;
    const [hours, minutes] = value.split(':').map(Number);
    const timeOfDayMinutes = hours * 60 + minutes;
    dataChannelsRef.current.forEach(channel => sendHostTime(channel, timeOfDayMinutes));
  };

  // Resets signaling state when switching between solo, host, and join modes.
  const handleMultiplayerRoleChange = (role: 'solo' | 'host' | 'join'): void => {
    closePeerConnections();
    setMultiplayerRole(role);
    setLocalDescription('');
    setRemoteDescription('');
    const roleLabel = role === 'host' ? 'host' : 'join';
    setMultiplayerStatus(
      role === 'solo' ? 'Solo flight' : `Ready to ${roleLabel} a flight.`,
    );
  };

  // Creates a host offer and waits for ICE gathering before exposing it for sharing.
  const handleCreateOffer = async (): Promise<void> => {
    if (multiplayerOperationRef.current) return;
    multiplayerOperationRef.current = true;
    setMultiplayerBusy(true);
    const sessionId = createId();
    setHostPeerSessions(sessions => [
      ...sessions,
      {
        id: sessionId,
        offer: '',
        answer: '',
        answerApplied: false,
        status: 'creating offer',
      },
    ]);

    try {
      const connection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      peerConnectionsRef.current.set(sessionId, connection);
      configurePeerConnection(connection, sessionId, 'host');
      configureDataChannel(
        connection.createDataChannel('flight-telemetry', {
          ordered: false,
          maxRetransmits: 0,
        }),
        sessionId,
        'host',
      );
      await connection.setLocalDescription(await connection.createOffer());
      await waitForIceGatheringComplete(connection);
      if (!connection.localDescription) {
        throw new Error('The peer connection did not produce a local offer.');
      }
      const offer = encodeSessionDescription(connection.localDescription);
      setHostPeerSessions(sessions =>
        sessions.map(session =>
          session.id === sessionId ? { ...session, offer, status: 'offer ready' } : session,
        ),
      );
      setMultiplayerStatus('Offer ready. Share it with one joiner and apply their answer here.');
    } catch (error) {
      dataChannelsRef.current.get(sessionId)?.close();
      peerConnectionsRef.current.get(sessionId)?.close();
      dataChannelsRef.current.delete(sessionId);
      peerConnectionsRef.current.delete(sessionId);
      setHostPeerSessions(sessions =>
        sessions.map(session =>
          session.id === sessionId ? { ...session, status: 'offer failed' } : session,
        ),
      );
      const message = error instanceof Error ? error.message : String(error);
      setMultiplayerStatus(`Could not create offer: ${message}`);
    } finally {
      multiplayerOperationRef.current = false;
      setMultiplayerBusy(false);
    }
  };

  // Applies a host offer and creates a shareable joiner answer.
  const handleCreateAnswer = async (): Promise<void> => {
    if (multiplayerOperationRef.current) return;
    multiplayerOperationRef.current = true;
    setMultiplayerBusy(true);
    closePeerConnections();
    setLocalDescription('');
    setMultiplayerStatus('Reading offer and gathering ICE candidates...');

    try {
      const connection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302'}],
      });
      peerConnectionsRef.current.set('host', connection);
      configurePeerConnection(connection, 'host', 'join');
      connection.ondatachannel = event =>
        configureDataChannel(event.channel, 'host', 'join');
      await connection.setRemoteDescription(decodeSessionDescription(remoteDescription, 'offer'));
      await connection.setLocalDescription(await connection.createAnswer());
      await waitForIceGatheringComplete(connection);
      if (!connection.localDescription) {
        throw new Error('The peer connection did not produce a local answer.');
      }
      setLocalDescription(encodeSessionDescription(connection.localDescription));
      setMultiplayerStatus('Answer ready. Share it with the host to complete the connection.');
    } catch (error) {
      closePeerConnections();
      const message = error instanceof Error ? error.message : String(error);
      setMultiplayerStatus(`Could not create answer: ${message}`);
    } finally {
      multiplayerOperationRef.current = false;
      setMultiplayerBusy(false);
    }
  };

  // Applies a joiner's answer to the matching host peer connection.
  const handleApplyAnswer = async (sessionId: string): Promise<void> => {
    if (multiplayerOperationRef.current) return;
    const session = hostPeerSessions.find(candidate => candidate.id === sessionId);
    const connection = peerConnectionsRef.current.get(sessionId);
    if (!session || !connection) {
      setMultiplayerStatus('Create a fresh offer before applying this answer.');
      return;
    }
    if (session.answerApplied || connection.remoteDescription?.type === 'answer') {
      setHostPeerSessions(sessions =>
        sessions.map(candidate =>
          candidate.id === sessionId
            ? { ...candidate, answerApplied: true, status: 'answer applied' }
            : candidate,
        ),
      );
      setMultiplayerStatus('This answer has already been applied. Create a fresh offer to connect another joiner.');
      return;
    }
    if (connection.signalingState !== 'have-local-offer') {
      setMultiplayerStatus(
        `Cannot apply answer while the peer connection is ${connection.signalingState}. Create a fresh offer.`,
      );
      return;
    }

    multiplayerOperationRef.current = true;
    setMultiplayerBusy(true);
    setHostPeerSessions(sessions =>
      sessions.map(candidate =>
        candidate.id === sessionId ? { ...candidate, status: 'connecting' } : candidate,
      ),
    );
    try {
      await connection.setRemoteDescription(decodeSessionDescription(session.answer, 'answer'));
      setHostPeerSessions(sessions =>
        sessions.map(candidate =>
          candidate.id === sessionId
            ? { ...candidate, answerApplied: true, status: 'answer applied' }
            : candidate,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHostPeerSessions(sessions =>
        sessions.map(candidate =>
          candidate.id === sessionId ? { ...candidate, status: 'answer rejected' } : candidate,
        ),
      );
      setMultiplayerStatus(`Could not apply answer: ${message}`);
    } finally {
      multiplayerOperationRef.current = false;
      setMultiplayerBusy(false);
    }
  };

  // Stores the answer text associated with a specific host offer.
  const handleHostAnswerChange = (sessionId: string, answer: string): void => {
    setHostPeerSessions(sessions =>
      sessions.map(session =>
        session.id === sessionId ? { ...session, answer } : session,
      ),
    );
  };

  const applyWeatherPreset = (preset: WeatherPreset): void => {
    weatherPresetRef.current = preset;
    setWeatherPreset(preset);
    if (preset === 'real') {
      const loadingWeather = createRealWeatherLoadingState();
      weatherRef.current = loadingWeather;
      setWeather(loadingWeather);
      setWeatherStatus('');
      return;
    }
    const nextWeather = createPresetWeather(preset);
    weatherRef.current = nextWeather;
    setWeather(nextWeather);
    setWeatherStatus('');
  };

  const handleWeatherPresetChange = (preset: WeatherPreset): void => {
    if (multiplayerRole === 'join') return;
    applyWeatherPreset(preset);
    if (multiplayerRole === 'host') {
      dataChannelsRef.current.forEach(channel => sendHostWeather(channel, preset));
    }
  };

  // Validates preflight inputs and initializes state for a new flight.
  const handleStartFlight = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (multiplayerRole !== 'solo' && !multiplayerConnected) {
      setSetupError('Complete the peer connection before starting a multiplayer flight.');
      return;
    }

    const latitude = Number(latitudeInput);
    const longitude = Number(longitudeInput);
    const startingAltitude = Number(startingAltitudeInput);
    const startingHeading = Number(startingHeadingInput);
    const timeParts = initialTimeInput.split(':').map(Number);
    if (
      !Number.isFinite(latitude) ||
      latitude < -85 ||
      latitude > 85 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      !Number.isFinite(startingAltitude) ||
      startingAltitude < 0 ||
      startingAltitude > 60000 ||
      !Number.isInteger(startingHeading) ||
      startingHeading < 0 ||
      startingHeading > 359 ||
      timeParts.length !== 2 ||
      !Number.isInteger(timeParts[0]) ||
      !Number.isInteger(timeParts[1]) ||
      timeParts[0] < 0 ||
      timeParts[0] > 23 ||
      timeParts[1] < 0 ||
      timeParts[1] > 59
    ) {
      setSetupError('Enter valid coordinates, altitude, heading, and initial time of day.');
      return;
    }

    setSetupError('');
    setPosX(0);
    setPosZ(0);
    setAltitude(startingAltitude);
    setPitch(0);
    setRoll(0);
    setHeading(startingHeading);
    setVerticalSpeed(0);
    // A new flight always begins with the landing gear deployed.
    landingGearDownRef.current = true;
    setLandingGearDown(true);
    localPoseRef.current = null;
    const startTimeMinutes =
      multiplayerRole === 'join' && multiplayerConnected
        ? simulationTimeRef.current
        : timeParts[0] * 60 + timeParts[1];
    const flightWeather = weatherPreset === 'real'
      ? createRealWeatherLoadingState()
      : weatherRef.current;
    weatherRef.current = flightWeather;
    setWeather(flightWeather);
    setWeatherStatus(
      weatherPreset === 'real' ? 'REAL weather · fetching aircraft location…' : '',
    );
    setTerrainGrid(null);
    setTerrainOrigin({ latitude, longitude });
    setFlightStartTimeMinutes(startTimeMinutes);
    setSimulationTimeMinutes(startTimeMinutes);
    simulationTimeRef.current = startTimeMinutes;
    setTerrainStatus('waiting for flight dynamics');
    setStatus('Loading flight dynamics...');
    setAdsbStatus(
      multiplayerRole === 'join'
        ? 'Waiting for ADS-B contacts from host.'
        : adsbApiKey.trim()
          ? 'Connecting to FlyItalyADSB...'
          : 'ADS-B off - add an API key in preflight.',
    );
    setSimulationStarted(true);
    localMissilesRef.current = [];
    localCountermeasuresRef.current = [];
    missileLaunchRequestedRef.current = false;
    missileLaunchTypeRef.current = 1;
    countermeasureDeployRequestedRef.current = null;
    processedMissileImpactsRef.current.clear();
    primaryTargetIdRef.current = null;
    setPrimaryTargetId(null);
    if (!playerIdRef.current) playerIdRef.current = createId();
    setLocalPlayerId(playerIdRef.current);
  };

  // Closes active sessions and restores the preflight defaults.
  const handleEndFlight = (): void => {
    closePeerConnections();
    setMultiplayerRole('solo');
    setMultiplayerStatus('Solo flight');
    setLocalDescription('');
    setRemoteDescription('');
    setSimulationStarted(false);
    setFlightReady(false);
    setTerrainGrid(null);
    setTerrainStatus('waiting for flight dynamics');
    setStatus('Ready for pre-flight setup');
    setPosX(0);
    setPosZ(0);
    setAltitude(5000);
    setAirspeed(300);
    setThrottle(43);
    setPitch(0);
    setRoll(0);
    setHeading(0);
    setVerticalSpeed(0);
    // Restore the default gear state when returning to preflight.
    landingGearDownRef.current = true;
    setLandingGearDown(true);
    setCrashed(false);
    localMissilesRef.current = [];
    localCountermeasuresRef.current = [];
    missileLaunchRequestedRef.current = false;
    missileLaunchTypeRef.current = 1;
    countermeasureDeployRequestedRef.current = null;
    processedMissileImpactsRef.current.clear();
    setAdsbStatus('ADS-B off - add an API key in preflight.');
    setWeatherPreset('real');
    weatherPresetRef.current = 'real';
    const defaultWeather = createRealWeatherLoadingState();
    weatherRef.current = defaultWeather;
    setWeather(defaultWeather);
    setWeatherStatus('');
  };

  // Simulation lifecycle and synchronization effects.

  // Closes outstanding peer resources when the page unmounts.
  useEffect(() => () => {
    dataChannelsRef.current.forEach(channel => channel.close());
    peerConnectionsRef.current.forEach(connection => connection.close());
  }, []);

  // Initializes the preflight clock from the browser's local time.
  useEffect(() => {
    const now = new Date();
    const currentTimeMinutes = now.getHours() * 60 + now.getMinutes();
    const timeoutId = window.setTimeout(() => {
      setInitialTimeInput(formatTimeOfDay(currentTimeMinutes));
      setFlightStartTimeMinutes(currentTimeMinutes);
      setSimulationTimeMinutes(currentTimeMinutes);
      simulationTimeRef.current = currentTimeMinutes;
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  // Loads the Wasm engine, runs the flight loop, and releases listeners on cleanup.
  useEffect(() => {
    if (!simulationStarted) return;

    let animationFrameId = 0;
    let disposed = false;
    let engineInstance: SimEngineInstance | null = null;

    const keysPressed = new Set<string>();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
        event.preventDefault();
      }
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select'));
      // G toggles once per key press and synchronizes the UI with the active Wasm engine.
      if (event.code === 'KeyG' && !typing) {
        event.preventDefault();
        if (!event.repeat) {
          const nextGearDown = !landingGearDownRef.current;
          landingGearDownRef.current = nextGearDown;
          setLandingGearDown(nextGearDown);
          engineInstance?.setLandingGearDown(nextGearDown);
          setStatus(`Landing gear ${nextGearDown ? 'DOWN' : 'UP'}`);
        }
        return;
      }
      if (event.code === 'KeyN' && !typing) {
        event.preventDefault();
        if (!event.repeat) {
          const contacts = sortRadarContactsByRange(radarContactsRef.current);
          if (contacts.length === 0) {
            setStatus('No active radar tracks to cycle.');
          } else {
            const currentIndex = contacts.findIndex(
              contact => contact.targetId === primaryTargetIdRef.current,
            );
            if (currentIndex === contacts.length - 1) {
              primaryTargetIdRef.current = null;
              setPrimaryTargetId(null);
              setStatus('Primary target deselected.');
            } else {
              const nextIndex = currentIndex + 1;
              const nextContact = contacts[nextIndex];
              primaryTargetIdRef.current = nextContact.targetId;
              setPrimaryTargetId(nextContact.targetId);
              const targetLabel =
                nextContact.kind === 'adsb' ? 'Passive ADS-B track' : 'Radar track';
              setStatus(`${targetLabel} T${nextIndex + 1} selected.`);
            }
          }
        }
      }
      // Queue weapon actions here; the simulation loop applies them at its next tick.
      if (event.code === 'KeyM' && !typing) {
        event.preventDefault();
        if (!event.repeat) {
          missileLaunchTypeRef.current = 1;
          missileLaunchRequestedRef.current = true;
        }
      }
      if (event.code === 'KeyI' && !typing) {
        event.preventDefault();
        if (!event.repeat) {
          missileLaunchTypeRef.current = 2;
          missileLaunchRequestedRef.current = true;
        }
      }
      if (event.code === 'KeyC' && !typing) {
        event.preventDefault();
        if (!event.repeat) countermeasureDeployRequestedRef.current = 'chaff';
      }
      if (event.code === 'KeyF' && !typing) {
        event.preventDefault();
        if (!event.repeat) countermeasureDeployRequestedRef.current = 'flare';
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
        const wasmAssetBasePath = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/wasm/`;
        const moduleFactory = (
          await import(/* webpackIgnore: true */ `${wasmAssetBasePath}sim-core.js`)
        ).default as SimEngineModuleFactory;
        const wasmModule = await moduleFactory({
          locateFile: (path: string) => `${wasmAssetBasePath}${path}`,
        });
        if (disposed) return;

        engineInstance = new wasmModule.SimEngine();
        engineInstance.setInitialConditions(
          Number(startingAltitudeInput),
          Number(startingHeadingInput),
        );
        // Match the fresh engine's physical gear state to the initial HUD state.
        engineInstance.setLandingGearDown(landingGearDownRef.current);
        engineRef.current = engineInstance;
        wasmModuleRef.current = wasmModule;
        setStatus('');
        setFlightReady(true);

        let lastTime = performance.now();
        let telemetrySendElapsed = 0;
        let radarUiElapsed = 0;
        let rwrUiElapsed = 0;
        let hudUiElapsed = 0;

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
            // Ctrl brakes during gear-down ground contact; otherwise it remains throttle-down.
            const brakePressed =
              keysPressed.has('ControlLeft') || keysPressed.has('ControlRight');
            engineInstance.setBrakeInput(brakePressed);
            if (brakePressed && !engineInstance.getOnGround()) {
              throttleRef.current = Math.max(0.0, throttleRef.current - 0.4 * clampedDt);
            }

            engineInstance.setPitchInput(pitchInput);
            engineInstance.setRollInput(rollInput);
            engineInstance.setYawInput(yawInput);
            engineInstance.setThrottle(throttleRef.current);
            engineInstance.setWind(
              weatherRef.current.windEastKnots,
              weatherRef.current.windNorthKnots,
            );
            if (missileLaunchRequestedRef.current) {
              missileLaunchRequestedRef.current = false;
              const missileTypeId = missileLaunchTypeRef.current;
              const selectedTargetId = primaryTargetIdRef.current;
              const selectedTargetIsAdsb =
                selectedTargetId !== null &&
                radarTargetKindsRef.current.get(selectedTargetId) === 'adsb';
              const launchResult = engineInstance.launchMissile(
                missileTypeId,
                selectedTargetId ?? 0,
              );
              setStatus(
                launchResult === 2
                  ? selectedTargetIsAdsb
                    ? `${missileTypeId === 2 ? 'Infrared' : 'Radar'}-guided missile launched.`
                    : `${missileTypeId === 2 ? 'Infrared' : 'Radar'}-guided missile launched.`
                  : launchResult === 1
                    ? 'Unguided missile launched.'
                    : launchResult === 3
                      ? 'Missile launch rejected: no missile slot is available.'
                      : launchResult === 4
                        ? 'Missile launch rejected: radar track is stale or no longer available.'
                        : launchResult === 5
                          ? 'Missile launch rejected: track is outside the 10 NM missile range.'
                          : 'Missile launch rejected: invalid flight state.',
              );
            }
            if (countermeasureDeployRequestedRef.current !== null) {
              // Keep dispenser state changes on the simulation tick with missile launches.
              const countermeasureType = countermeasureDeployRequestedRef.current;
              countermeasureDeployRequestedRef.current = null;
              const deployed = countermeasureType === 'chaff'
                ? engineInstance.deployChaff()
                : engineInstance.deployFlare();
              setStatus(
                deployed
                  ? `${countermeasureType === 'chaff' ? 'Chaff' : 'Flare'} deployed.`
                  : `${countermeasureType === 'chaff' ? 'Chaff' : 'Flare'} unavailable: depleted, cooling down, or dispenser full.`,
              );
            }

            // Refresh collision targets even if radar is powered off or has no acquired tracks.
            const now = performance.now();
            const recentAircraftTargets = remoteTelemetriesRef.current
              .filter(
                telemetry => {
                  const isAdsb = telemetry.playerId.startsWith('adsb:');
                  return now -
                    (remoteTelemetryReceivedAtRef.current.get(telemetry.playerId) ?? 0) <=
                    (isAdsb ? ADSB_TRACK_TTL_MS : 2000);
                },
              )
              .sort((left, right) =>
                Number(left.playerId.startsWith('adsb:')) -
                Number(right.playerId.startsWith('adsb:')),
              )
              .slice(0, MAX_RADAR_TARGETS);
            engineInstance.clearMissileTargets();
            engineInstance.clearCountermeasureTargets();
            if (radarEnabledRef.current) engineInstance.clearRadarTargets();
            for (const target of recentAircraftTargets) {
              const isAdsb = target.playerId.startsWith('adsb:');
              let targetId = radarTargetIdsRef.current.get(target.playerId);
              if (targetId === undefined) {
                targetId = nextRadarTargetIdRef.current;
                nextRadarTargetIdRef.current += 1;
                radarTargetIdsRef.current.set(target.playerId, targetId);
              }
              radarTargetKindsRef.current.set(targetId, isAdsb ? 'adsb' : 'player');
              if (isAdsb) {
                radarTargetPlayerIdsRef.current.delete(targetId);
              } else {
                radarTargetPlayerIdsRef.current.set(targetId, target.playerId);
              }
              const targetPosition = getLocalPosition(terrainOrigin, target);
              if (!isAdsb && !engineInstance.addMissileTarget(
                targetId,
                targetPosition.posXFeet,
                target.altitude,
                targetPosition.posZFeet,
              )) {
                setStatus('Missile system could not accept an aircraft target.');
              }
              if (radarEnabledRef.current && !engineInstance.addRadarTarget(
                targetId,
                targetPosition.posXFeet,
                target.altitude,
                targetPosition.posZFeet,
              )) {
                setStatus('Radar could not accept an aircraft target.');
              }
              if (!isAdsb) {
                // ADS-B contacts have no player-owned stores; only peer decoys enter seeker search.
                for (const countermeasure of target.countermeasures ?? []) {
                  const position = getLocalPosition(terrainOrigin, countermeasure);
                  if (!engineInstance.addCountermeasureTarget(
                    countermeasure.countermeasureId,
                    countermeasure.typeId,
                    position.posXFeet,
                    countermeasure.altitude,
                    position.posZFeet,
                    countermeasure.ageSeconds,
                  )) {
                    setStatus('Missile system could not accept a countermeasure target.');
                  }
                }
              }
            }

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

            // Apply each fresh remote hit once so repeated relay snapshots cannot extend damage.
            for (const remote of remoteTelemetriesRef.current) {
              if (
                remote.playerId === playerIdRef.current ||
                remote.playerId.startsWith('adsb:') ||
                now - (remoteTelemetryReceivedAtRef.current.get(remote.playerId) ?? 0) > 2000
              ) {
                continue;
              }
              for (const missile of remote.missiles ?? []) {
                if (!missile.exploded || missile.impactPlayerId !== playerIdRef.current) continue;
                const impactKey = `${remote.playerId}:${missile.missileId}`;
                if (processedMissileImpactsRef.current.has(impactKey)) continue;
                processedMissileImpactsRef.current.set(impactKey, now);
                engineInstance.applyMissileImpact();
              }
            }
            processedMissileImpactsRef.current.forEach((time, impactKey) => {
              if (now - time > 30_000) processedMissileImpactsRef.current.delete(impactKey);
            });

            const [
              nextPosX,
              nextAltitude,
              nextPosZ,
              nextAirspeed,
              nextThrottle,
              nextPitch,
              nextRoll,
              nextHeading,
              nextVerticalSpeed,
            ] = telemetry;
            // Published synchronously so the renderer never waits on React to move the camera.
            localPoseRef.current = {
              timeMs: currentTime,
              posX: nextPosX,
              altitude: nextAltitude,
              posZ: nextPosZ,
              pitch: nextPitch,
              roll: nextRoll,
              heading: nextHeading,
            };
            const nextCrashed = engineInstance.getCrashed();
            setCrashed(nextCrashed);
            // The camera reads localPoseRef every frame, so React only needs HUD-rate updates.
            hudUiElapsed += clampedDt;
            if (hudUiElapsed >= HUD_UI_INTERVAL_SECONDS) {
              hudUiElapsed %= HUD_UI_INTERVAL_SECONDS;
              setPosX(nextPosX);
              setAltitude(nextAltitude);
              setPosZ(nextPosZ);
              setAirspeed(nextAirspeed);
              setThrottle(nextThrottle);
              setPitch(nextPitch);
              setRoll(nextRoll);
              setHeading(nextHeading);
              setVerticalSpeed(nextVerticalSpeed);
            }

            const missileEngine = engineInstance;
            const readMissiles = (): MissileTelemetry[] =>
              Array.from({ length: missileEngine.getMissileCount() }, (_, index) => {
                const missilePosition = getAircraftCoordinates(
                  terrainOrigin,
                  missileEngine.getMissilePosX(index),
                  missileEngine.getMissilePosZ(index),
                );
                const targetId = missileEngine.getMissileTargetId(index);
                return {
                  missileId: missileEngine.getMissileId(index),
                  typeId: missileEngine.getMissileTypeId(index),
                  ...missilePosition,
                  altitude: missileEngine.getMissileAltitude(index),
                  heading: missileEngine.getMissileHeading(index),
                  pitch: missileEngine.getMissilePitch(index),
                  exploded: missileEngine.getMissileExploded(index),
                  triggersRwr: missileEngine.getMissileTriggersRwr(index),
                  targetPlayerId:
                    radarTargetPlayerIdsRef.current.get(targetId) ?? null,
                  impactPlayerId:
                    radarTargetPlayerIdsRef.current.get(
                      missileEngine.getMissileImpactTargetId(index),
                    ) ?? null,
                };
              });
            localMissilesRef.current = readMissiles();
            const readCountermeasures = (): CountermeasureTelemetry[] =>
              // Convert local simulator feet into the geographic snapshot format used by peers.
              Array.from(
                { length: missileEngine.getCountermeasureCount() },
                (_, index) => {
                  const position = getAircraftCoordinates(
                    terrainOrigin,
                    missileEngine.getCountermeasurePosX(index),
                    missileEngine.getCountermeasurePosZ(index),
                  );
                  return {
                    countermeasureId: missileEngine.getCountermeasureId(index),
                    typeId: missileEngine.getCountermeasureType(index) === 2 ? 2 : 1,
                    ...position,
                    altitude: missileEngine.getCountermeasureAltitude(index),
                    ageSeconds: missileEngine.getCountermeasureAge(index),
                  };
                },
              );
            localCountermeasuresRef.current = readCountermeasures();

            // Read radar returns at 10 Hz instead of triggering a render every frame.
            if (radarEnabledRef.current) {
              radarUiElapsed += clampedDt;
              if (radarUiElapsed >= 0.1) {
                radarUiElapsed %= 0.1;
                const radarEngine = engineInstance;
                const contactCount = radarEngine.getRadarContactCount();
                const nextRadarContacts = Array.from({ length: contactCount }, (_, index) => ({
                  targetId: radarEngine.getRadarContactTargetId(index),
                  rangeNm: radarEngine.getRadarContactRangeNm(index),
                  azimuth: radarEngine.getRadarContactAzimuth(index),
                  elevation: radarEngine.getRadarContactElevation(index),
                  ageSeconds: radarEngine.getRadarContactAge(index),
                  kind:
                    radarTargetKindsRef.current.get(
                      radarEngine.getRadarContactTargetId(index),
                    ) ?? 'player',
                }));
                setRadarContacts(nextRadarContacts);
                setRadarScanAzimuth(radarEngine.getRadarScanAzimuth());
                setRadarScanBar(radarEngine.getRadarScanBar());
              }
            }

            rwrUiElapsed += clampedDt;
            if (rwrUiElapsed >= 0.1) {
              rwrUiElapsed %= 0.1;
              setRadarWarnings(
                getRadarWarningContacts(
                  playerIdRef.current,
                  remoteTelemetriesRef.current,
                  remoteTelemetryReceivedAtRef.current,
                  performance.now(),
                  terrainOrigin,
                  nextPosX,
                  nextPosZ,
                  nextAltitude,
                  nextHeading,
                  nextPitch,
                  nextRoll,
                ),
              );
            }

            // Frequent disposable snapshots carry both missile and decoy state to peers.
            telemetrySendElapsed += clampedDt;
            const openChannels = Array.from(dataChannelsRef.current.values())
              .filter(channel => channel.readyState === 'open');
            if (
              telemetrySendElapsed >= TELEMETRY_SEND_INTERVAL_SECONDS &&
              openChannels.length > 0
            ) {
              telemetrySendElapsed %= TELEMETRY_SEND_INTERVAL_SECONDS;
              const aircraftCoordinates = getAircraftCoordinates(
                terrainOrigin,
                nextPosX,
                nextPosZ,
              );
              if (!playerIdRef.current) playerIdRef.current = createId();
              const telemetryEngine = engineInstance;
              const radarDetectedPlayerIds = telemetryEngine
                ? Array.from(
                    { length: telemetryEngine.getRadarContactCount() },
                    (_, index) =>
                      radarTargetPlayerIdsRef.current.get(
                        telemetryEngine.getRadarContactTargetId(index),
                      ),
                  ).filter((playerId): playerId is string => playerId !== undefined)
                : [];
              const telemetry: FlightTelemetry = {
                playerId: playerIdRef.current,
                isHost: multiplayerRole === 'host',
                posX: nextPosX,
                posZ: nextPosZ,
                altitude: nextAltitude,
                pitch: nextPitch,
                roll: nextRoll,
                heading: nextHeading,
                airspeed: nextAirspeed,
                throttle: nextThrottle,
                verticalSpeed: nextVerticalSpeed,
                crashed: nextCrashed,
                ...aircraftCoordinates,
                sequence: telemetrySequenceRef.current,
                simulationTimeMinutes: simulationTimeRef.current,
                sampleTimeMs: currentTime,
                radarDetectedPlayerIds,
                missiles: readMissiles(),
                countermeasures: readCountermeasures(),
              };
              telemetrySequenceRef.current += 1;
              const message = JSON.stringify({ type: 'telemetry', telemetry });
              for (const channel of openChannels) {
                // Skip stale snapshots rather than letting a congested channel build a queue.
                if (channel.bufferedAmount > MAX_TELEMETRY_BUFFERED_BYTES) continue;
                try {
                  channel.send(message);
                } catch (error) {
                  const errorMessage = error instanceof Error ? error.message : String(error);
                  setMultiplayerStatus(`Could not send flight telemetry: ${errorMessage}`);
                }
              }
            }
          }

          animationFrameId = requestAnimationFrame(loop);
        };

        animationFrameId = requestAnimationFrame(loop);
      } catch (error) {
        console.error('Failed to load Wasm module:', error);
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
  }, [
    multiplayerRole,
    simulationStarted,
    startingAltitudeInput,
    startingHeadingInput,
    terrainOrigin,
  ]);

  // Applies radar power changes to the active WebAssembly simulation instance.
  useEffect(() => {
    radarEnabledRef.current = radarEnabled;
    engineRef.current?.setRadarEnabled(radarEnabled);
  }, [flightReady, radarEnabled]);

  // Keeps radar and visual targets aligned with the latest peer and ADS-B telemetry.
  useEffect(() => {
    adsbTelemetriesRef.current = adsbTelemetries;
    remoteTelemetriesRef.current = [
      ...Object.values(remotePlayersRef.current),
      ...adsbTelemetries,
    ];
  }, [adsbTelemetries, remoteTelemetries]);

  useEffect(() => {
    radarContactsRef.current = radarContacts;
    if (
      primaryTargetIdRef.current !== null &&
      !radarContacts.some(contact => contact.targetId === primaryTargetIdRef.current)
    ) {
      primaryTargetIdRef.current = null;
      setPrimaryTargetId(null);
    }
  }, [radarContacts]);

  // Only solo players and hosts call FlyItalyADSB; joiners receive host snapshots.
  useEffect(() => {
    if (!simulationStarted) return;
    if (multiplayerRole === 'join' || !adsbApiKey.trim()) return;

    let cancelled = false;
    let requestPending = false;
    let activeController: AbortController | null = null;
    const pollAircraft = async (): Promise<void> => {
      if (requestPending) return;
      requestPending = true;
      const controller = new AbortController();
      activeController = controller;
      try {
        const position = latestPositionRef.current;
        const center = getAircraftCoordinates(terrainOrigin, position.posX, position.posZ);
        const aircraft = await fetchAdsbAircraft(
          center.latitude,
          center.longitude,
          adsbApiKey,
          controller.signal,
        );
        if (cancelled) return;

        const sequence = adsbSequenceRef.current + 1;
        applyAdsbSnapshot(aircraft, sequence);
        setAdsbStatus(
          `LIVE ADS-B · ${aircraft.length} tracks (${multiplayerRole === 'host' ? 'host relay' : 'solo'})`,
        );
        if (multiplayerRole === 'host') {
          dataChannelsRef.current.forEach(channel =>
            sendAdsbSnapshot(channel, sequence, aircraft),
          );
        }
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        const message = error instanceof Error ? error.message : String(error);
        setAdsbStatus(`ADS-B unavailable: ${message}`);
      } finally {
        if (activeController === controller) activeController = null;
        requestPending = false;
      }
    };

    void pollAircraft();
    const intervalId = window.setInterval(() => void pollAircraft(), ADSB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      activeController?.abort();
    };
  }, [
    adsbApiKey,
    applyAdsbSnapshot,
    multiplayerRole,
    sendAdsbSnapshot,
    simulationStarted,
    terrainOrigin,
  ]);

  // REAL weather is fetched locally for the aircraft's current coordinates.
  useEffect(() => {
    if (!simulationStarted || weatherPreset !== 'real') return;

    let cancelled = false;
    let requestPending = false;
    let activeController: AbortController | null = null;
    const updateWeather = async (): Promise<void> => {
      if (requestPending) return;
      requestPending = true;
      const controller = new AbortController();
      activeController = controller;
      const position = latestPositionRef.current;
      const location = getAircraftCoordinates(terrainOrigin, position.posX, position.posZ);
      setWeatherStatus('REAL weather · fetching aircraft location…');

      try {
        const currentWeather = await fetchCurrentWeather(
          location.latitude,
          location.longitude,
          controller.signal,
        );
        if (cancelled) return;
        weatherRef.current = currentWeather;
        setWeather(currentWeather);
        setWeatherStatus(`REAL weather · updated ${new Date().toLocaleTimeString()}`);
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        const message = error instanceof Error ? error.message : String(error);
        setWeatherStatus(`REAL weather unavailable: ${message}; retrying in one minute.`);
      } finally {
        if (activeController === controller) activeController = null;
        requestPending = false;
      }
    };

    void updateWeather();
    const intervalId = window.setInterval(
      () => void updateWeather(),
      REAL_WEATHER_POLL_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      activeController?.abort();
    };
  }, [simulationStarted, terrainOrigin, weatherPreset]);

  // Advances the local clock unless a connected host controls joiner time.
  useEffect(() => {
    if (!simulationStarted) return;
    if (multiplayerRole === 'join' && multiplayerConnected) return;

    const startedAt = Date.now();
    const updateSimulationTime = () => {
      const elapsedMinutes = (Date.now() - startedAt) / 60_000;
      setSimulationTimeMinutes((flightStartTimeMinutes + elapsedMinutes) % (24 * 60));
    };

    updateSimulationTime();
    const intervalId = window.setInterval(updateSimulationTime, 1000);
    return () => window.clearInterval(intervalId);
  }, [flightStartTimeMinutes, multiplayerConnected, multiplayerRole, simulationStarted]);

  // Keeps the current clock value available to callbacks outside React's render cycle.
  useEffect(() => {
    simulationTimeRef.current = simulationTimeMinutes;
  }, [simulationTimeMinutes]);

  // Tracks the latest simulator position for asynchronous terrain requests.
  useEffect(() => {
    latestPositionRef.current = { posX, posZ };
  }, [posX, posZ]);

  // Loads terrain for the current neighborhood and uploads it into Wasm memory.
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

  // Render the preflight form until a flight is requested.
  if (!simulationStarted) {
    return (
      <PreflightScreen
        multiplayerRole={multiplayerRole}
        multiplayerStatus={multiplayerStatus}
        multiplayerBusy={multiplayerBusy}
        canStartFlight={multiplayerRole === 'solo' || multiplayerConnected}
        hostPeerSessions={hostPeerSessions}
        localDescription={localDescription}
        remoteDescription={remoteDescription}
        latitude={latitudeInput}
        longitude={longitudeInput}
        startingAltitude={startingAltitudeInput}
        startingHeading={startingHeadingInput}
        weatherPreset={weatherPreset}
        weatherLabel={weatherPreset === 'real' ? 'Open-Meteo weather in flight' : weather.label}
        initialTime={initialTimeInput}
        adsbApiKey={adsbApiKey}
        rememberAdsbApiKey={rememberAdsbApiKey}
        adsbKeyStorageError={adsbKeyStorageError}
        error={setupError}
        onMultiplayerRoleChange={handleMultiplayerRoleChange}
        onCreateOffer={handleCreateOffer}
        onCreateAnswer={handleCreateAnswer}
        onApplyAnswer={handleApplyAnswer}
        onHostAnswerChange={handleHostAnswerChange}
        onRemoteDescriptionChange={setRemoteDescription}
        onLatitudeChange={setLatitudeInput}
        onLongitudeChange={setLongitudeInput}
        onStartingAltitudeChange={setStartingAltitudeInput}
        onStartingHeadingChange={setStartingHeadingInput}
        onWeatherPresetChange={handleWeatherPresetChange}
        onInitialTimeChange={handleInitialTimeChange}
        onAdsbApiKeyChange={handleAdsbApiKeyChange}
        onRememberAdsbApiKeyChange={handleRememberAdsbApiKeyChange}
        onSubmit={handleStartFlight}
      />
    );
  }

  // Render the active cockpit, instruments, and flight controls.
  return (
    <main className="flex min-h-screen flex-col items-stretch justify-start bg-zinc-950 font-mono text-zinc-100">
      <div className="w-full">
        <div>
          <FlightViewport
            posX={posX}
            posZ={posZ}
            altitude={altitude}
            pitch={pitch}
            roll={roll}
            throttle={throttle}
            verticalSpeed={verticalSpeed}
            heading={heading}
            airspeed={airspeed}
            crashed={crashed}
            landingGearDown={landingGearDown}
            localPlayerId={localPlayerId}
            localPoseRef={localPoseRef}
            localMissilesRef={localMissilesRef}
            localCountermeasuresRef={localCountermeasuresRef}
            radarEnabled={radarEnabled}
            remoteTelemetries={remoteTelemetries}
            remoteTelemetrySamplesRef={remoteTelemetrySamplesRef}
            radarContacts={radarContacts}
            radarWarnings={radarWarnings}
            radarScanAzimuth={radarScanAzimuth}
            radarScanBar={radarScanBar}
            primaryTargetId={primaryTargetId}
            terrainOrigin={terrainOrigin}
            terrainGrid={terrainGrid}
            terrainStatus={terrainStatus}
            weather={weather}
            simulationTimeMinutes={simulationTimeMinutes}
          />
        </div>

        <div className="mb-4 flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-zinc-300">Radar</p>
            <p className="mt-1 text-xs text-zinc-500">
              {radarEnabled ? 'Scanning and tracking enabled' : 'Radar system disabled'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={radarEnabled}
            aria-label="Radar"
            onClick={handleRadarToggle}
            className={`relative h-7 w-12 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
              radarEnabled ? 'border-emerald-500 bg-emerald-600' : 'border-zinc-600 bg-zinc-700'
            }`}
          >
            <span
              aria-hidden="true"
              className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                radarEnabled ? 'translate-x-6' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        <div className="bg-zinc-950/50 border border-zinc-800/80 rounded-lg p-4 text-xs text-zinc-400">
          <p className="font-bold text-zinc-300 mb-2">PILOT FLIGHT CONTROLS:</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <strong className="text-emerald-400">W / S</strong>: Pitch up / down
            </div>
            <div>
              <strong className="text-emerald-400">A / D</strong>: Bank for turns
            </div>
            <div>
              <strong className="text-emerald-400">Q / E</strong>: Rudder yaw / sideslip
            </div>
            <div>
              <strong className="text-emerald-400">SHIFT / CTRL</strong>: Throttle up / down
            </div>
            <div className="col-span-2">
              <strong className="text-emerald-400">N</strong>: Cycle nearest-first, then deselect target
            </div>
            <div className="col-span-2">
              <strong className="text-emerald-400">M / I</strong>: Launch radar / infrared missile
            </div>
            <div>
              <strong className="text-emerald-400">C</strong>: Deploy chaff
            </div>
            <div>
              <strong className="text-emerald-400">F</strong>: Deploy flare
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={handleEndFlight}
              className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-bold text-zinc-300 transition-colors hover:border-red-500/50 hover:bg-red-950/40 hover:text-red-300"
            >
              END FLIGHT
            </button>
          </div>
          {weatherStatus && (
            <p
              role={weatherStatus.startsWith('REAL weather unavailable:') ? 'alert' : 'status'}
              aria-live={weatherStatus.startsWith('REAL weather unavailable:') ? 'assertive' : 'polite'}
              className={`mt-3 rounded border px-3 py-2 text-right text-xs ${
                weatherStatus.startsWith('REAL weather unavailable:')
                  ? 'border-red-500/60 bg-red-950/85 text-red-300'
                  : 'border-zinc-800 bg-zinc-900/80 text-sky-200'
              }`}
            >
              {weatherStatus}
            </p>
          )}
          {(status ||
            (multiplayerRole !== 'solo' && multiplayerStatus) ||
            adsbStatus ||
            remoteTelemetries.some(telemetry => telemetry.playerId.startsWith('adsb:'))) && (
            <div className="mt-4 grid gap-2 border-t border-zinc-800 pt-3">
              {status && <p className="text-zinc-300">{status}</p>}
              {multiplayerRole !== 'solo' && multiplayerStatus && (
                <p className="text-emerald-300">{multiplayerStatus}</p>
              )}
              {adsbStatus && <p className="text-sky-300">{adsbStatus}</p>}
              {remoteTelemetries.some(telemetry => telemetry.playerId.startsWith('adsb:')) && (
                <p className="text-zinc-400">
                  Flight data: FlyItalyADSB (flyitalyadsb.com), CC BY-SA 4.0
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}