'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import FlightViewport from './components/FlightViewport';
import PreflightScreen from './components/PreflightScreen';
import type { RadarContact } from './components/RadarScope';
import type { HostPeerSession } from './components/PreflightScreen';
import {
  getAircraftCoordinates,
  getLocalPosition,
  getTerrainNeighborhoodKey,
  loadTerrainGrid,
} from './terrain';
import type { TerrainGrid, TerrainOrigin } from './terrain';
import {
  decodeSessionDescription,
  encodeSessionDescription,
  parseFlightTimeMessage,
  parseFlightTelemetryMessage,
  waitForIceGatheringComplete,
} from './webrtc';
import type { FlightTelemetry } from './webrtc';

interface SimEngineInstance {
  tick(dt: number): void;
  setPitchInput(value: number): void;
  setRollInput(value: number): void;
  setYawInput(value: number): void;
  setThrottle(value: number): void;
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
  getCrashed(): boolean;
  clearRadarTargets(): void;
  addRadarTarget(id: number, posX: number, altitude: number, posZ: number): boolean;
  getRadarContactCount(): number;
  getRadarContactTargetId(index: number): number;
  getRadarContactRangeNm(index: number): number;
  getRadarContactAzimuth(index: number): number;
  getRadarContactElevation(index: number): number;
  getRadarContactAge(index: number): number;
  getRadarScanAzimuth(): number;
  getRadarScanBar(): number;
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

// Formats elapsed simulation minutes as a zero-padded 24-hour clock.
function formatTimeOfDay(totalMinutes: number): string {
  const wholeMinutes = Math.floor(totalMinutes) % (24 * 60);
  const hours = Math.floor(wholeMinutes / 60);
  const minutes = wholeMinutes % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

// Owns preflight state, the Wasm simulation loop, and multiplayer coordination.
export default function Home() {
  // Preflight selections and the terrain currently loaded into the simulation.
  const [latitudeInput, setLatitudeInput] = useState(String(DEFAULT_LATITUDE));
  const [longitudeInput, setLongitudeInput] = useState(String(DEFAULT_LONGITUDE));
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
  const [setupError, setSetupError] = useState('');

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
  const [groundElevation, setGroundElevation] = useState<number>(0);
  const [airspeed, setAirspeed] = useState<number>(300);
  const [throttle, setThrottle] = useState<number>(43);
  const [pitch, setPitch] = useState<number>(0);
  const [roll, setRoll] = useState<number>(0);
  const [heading, setHeading] = useState<number>(0);
  const [verticalSpeed, setVerticalSpeed] = useState<number>(0);
  const [crashed, setCrashed] = useState(false);
  const [radarContacts, setRadarContacts] = useState<RadarContact[]>([]);
  const [radarScanAzimuth, setRadarScanAzimuth] = useState(-60);
  const [radarScanBar, setRadarScanBar] = useState(1);
  const [posX, setPosX] = useState<number>(0);
  const [posZ, setPosZ] = useState<number>(0);
  const [status, setStatus] = useState<string>('Initializing flight dynamics...');

  // Mutable values shared with callbacks and animation loops without rerendering.
  const throttleRef = useRef(0.43);
  const engineRef = useRef<SimEngineInstance | null>(null);
  const wasmModuleRef = useRef<SimEngineModule | null>(null);
  const latestPositionRef = useRef({ posX, posZ });
  const peerConnectionsRef = useRef(new Map<string, RTCPeerConnection>());
  const dataChannelsRef = useRef(new Map<string, RTCDataChannel>());
  const peerPlayersRef = useRef(new Map<string, Set<string>>());
  const multiplayerOperationRef = useRef(false);
  const hostTimeSequenceRef = useRef(0);
  const playerIdRef = useRef('');
  const telemetrySequenceRef = useRef(0);
  const remoteTelemetriesRef = useRef<FlightTelemetry[]>([]);
  const remoteTelemetryReceivedAtRef = useRef(new Map<string, number>());
  const radarTargetIdsRef = useRef(new Map<string, number>());
  const nextRadarTargetIdRef = useRef(1);
  const terrainNeighborhoodKey = getTerrainNeighborhoodKey(terrainOrigin, posX, posZ);

  // Synchronizes connection state and host-facing joiner status.
  const refreshConnectedPeers = (): void => {
    const connectedCount = Array.from(dataChannelsRef.current.values())
      .filter(channel => channel.readyState === 'open').length;
    setMultiplayerConnected(connectedCount > 0);
    if (multiplayerRole === 'host') {
      setMultiplayerStatus(
        connectedCount === 0
          ? 'No joiners connected. Create an offer for each player.'
          : `${connectedCount} joiner${connectedCount === 1 ? '' : 's'} connected. The host relays flight data.`,
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

  // Closes all peer resources and clears multiplayer state.
  const closePeerConnections = (): void => {
    dataChannelsRef.current.forEach(channel => channel.close());
    peerConnectionsRef.current.forEach(connection => connection.close());
    dataChannelsRef.current.clear();
    peerConnectionsRef.current.clear();
    peerPlayersRef.current.clear();
    remoteTelemetryReceivedAtRef.current.clear();
    radarTargetIdsRef.current.clear();
    nextRadarTargetIdRef.current = 1;
    setRemoteTelemetryByPlayer({});
    setRadarContacts([]);
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
      }
    };
    channel.onclose = () => {
      if (dataChannelsRef.current.get(sessionId) !== channel) return;
      dataChannelsRef.current.delete(sessionId);
      peerConnectionsRef.current.get(sessionId)?.close();
      peerConnectionsRef.current.delete(sessionId);
      const playerIds = peerPlayersRef.current.get(sessionId) ?? new Set<string>();
      peerPlayersRef.current.delete(sessionId);
      setRemoteTelemetryByPlayer(current => {
        const next = { ...current };
        playerIds.forEach(playerId => {
          delete next[playerId];
          remoteTelemetryReceivedAtRef.current.delete(playerId);
        });
        return next;
      });
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
      remoteTelemetryReceivedAtRef.current.set(telemetry.playerId, performance.now());
      setRemoteTelemetryByPlayer(current => ({
        ...current,
        [telemetry.playerId]: telemetry,
      }));

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
    const sessionId = crypto.randomUUID();
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
        connection.createDataChannel('flight-telemetry', { ordered: false }),
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
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
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

  // Validates preflight inputs and initializes state for a new flight.
  const handleStartFlight = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (multiplayerRole !== 'solo' && !multiplayerConnected) {
      setSetupError('Complete the peer connection before starting a multiplayer flight.');
      return;
    }

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

    const startTimeMinutes =
      multiplayerRole === 'join' && multiplayerConnected
        ? simulationTimeRef.current
        : timeParts[0] * 60 + timeParts[1];
    setSetupError('');
    setTerrainGrid(null);
    setTerrainOrigin({ latitude, longitude });
    setFlightStartTimeMinutes(startTimeMinutes);
    setSimulationTimeMinutes(startTimeMinutes);
    simulationTimeRef.current = startTimeMinutes;
    setTerrainStatus('waiting for flight dynamics');
    setStatus('Loading flight dynamics...');
    setSimulationStarted(true);
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
    setGroundElevation(0);
    setAirspeed(300);
    setThrottle(43);
    setPitch(0);
    setRoll(0);
    setHeading(0);
    setVerticalSpeed(0);
    setCrashed(false);
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
        const moduleFactory = (
          // @ts-expect-error This public asset is not part of the TypeScript module graph.
          await import(/* webpackIgnore: true */ '/wasm/sim-core.js')
        ).default as SimEngineModuleFactory;
        const wasmModule = await moduleFactory({
          locateFile: (path: string) => `/wasm/${path}`,
        });
        if (disposed) return;

        engineInstance = new wasmModule.SimEngine();
        engineRef.current = engineInstance;
        wasmModuleRef.current = wasmModule;
        setStatus('');
        setFlightReady(true);

        let lastTime = performance.now();
        let telemetrySendElapsed = 0;
        let radarUiElapsed = 0;

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

            engineInstance.setPitchInput(pitchInput);
            engineInstance.setRollInput(rollInput);
            engineInstance.setYawInput(yawInput);
            engineInstance.setThrottle(throttleRef.current);

            // Refresh the radar target list from recent multiplayer reports.
            const now = performance.now();
            const radarTargets = remoteTelemetriesRef.current
              .filter(
                telemetry =>
                  now -
                    (remoteTelemetryReceivedAtRef.current.get(telemetry.playerId) ?? 0) <=
                  2000,
              )
              .slice(0, MAX_RADAR_TARGETS);
            engineInstance.clearRadarTargets();
            for (const target of radarTargets) {
              let targetId = radarTargetIdsRef.current.get(target.playerId);
              if (targetId === undefined) {
                targetId = nextRadarTargetIdRef.current;
                nextRadarTargetIdRef.current += 1;
                radarTargetIdsRef.current.set(target.playerId, targetId);
              }
              const targetPosition = getLocalPosition(terrainOrigin, target);
              if (!engineInstance.addRadarTarget(
                targetId,
                targetPosition.posXFeet,
                target.altitude,
                targetPosition.posZFeet,
              )) {
                setStatus('Radar could not accept an aircraft target.');
              }
            }

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

            const [
              nextPosX,
              nextAltitude,
              nextPosZ,
              nextGroundElevation,
              nextAirspeed,
              nextThrottle,
              nextPitch,
              nextRoll,
              nextHeading,
              nextVerticalSpeed,
            ] = telemetry;
            setPosX(nextPosX);
            setAltitude(nextAltitude);
            setPosZ(nextPosZ);
            setGroundElevation(nextGroundElevation);
            setAirspeed(nextAirspeed);
            setThrottle(nextThrottle);
            setPitch(nextPitch);
            setRoll(nextRoll);
            setHeading(nextHeading);
            setVerticalSpeed(nextVerticalSpeed);
            const nextCrashed = engineInstance.getCrashed();
            setCrashed(nextCrashed);

            // Read radar returns at 10 Hz instead of triggering a render every frame.
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
              }));
              setRadarContacts(nextRadarContacts);
              setRadarScanAzimuth(radarEngine.getRadarScanAzimuth());
              setRadarScanBar(radarEngine.getRadarScanBar());
            }

            // Send local aircraft state to connected peers at 10 Hz.
            telemetrySendElapsed += clampedDt;
            const openChannels = Array.from(dataChannelsRef.current.values())
              .filter(channel => channel.readyState === 'open');
            if (telemetrySendElapsed >= 0.1 && openChannels.length > 0) {
              telemetrySendElapsed %= 0.1;
              const aircraftCoordinates = getAircraftCoordinates(
                terrainOrigin,
                nextPosX,
                nextPosZ,
              );
              if (!playerIdRef.current) playerIdRef.current = crypto.randomUUID();
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
              };
              telemetrySequenceRef.current += 1;
              const message = JSON.stringify({ type: 'telemetry', telemetry });
              for (const channel of openChannels) {
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
  }, [multiplayerRole, simulationStarted, terrainOrigin]);

  // Keeps radar targets aligned with the latest validated multiplayer telemetry.
  useEffect(() => {
    remoteTelemetriesRef.current = Object.values(remoteTelemetryByPlayer);
  }, [remoteTelemetryByPlayer]);

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
        initialTime={initialTimeInput}
        timeControlledByHost={multiplayerRole === 'join'}
        error={setupError}
        onMultiplayerRoleChange={handleMultiplayerRoleChange}
        onCreateOffer={handleCreateOffer}
        onCreateAnswer={handleCreateAnswer}
        onApplyAnswer={handleApplyAnswer}
        onHostAnswerChange={handleHostAnswerChange}
        onRemoteDescriptionChange={setRemoteDescription}
        onLatitudeChange={setLatitudeInput}
        onLongitudeChange={setLongitudeInput}
        onInitialTimeChange={handleInitialTimeChange}
        onSubmit={handleStartFlight}
      />
    );
  }

  // Render the active cockpit, instruments, and flight controls.
  return (
    <main className="flex min-h-screen flex-col items-stretch justify-start bg-zinc-950 p-3 font-mono text-zinc-100 sm:p-5">
      <div className="mx-auto w-full max-w-[1600px] rounded-xl border border-zinc-800 bg-zinc-900 p-3 shadow-2xl sm:p-5">
        <div className="mb-4 flex items-center justify-between border-b border-zinc-800 pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-wider text-emerald-400">MACHWEB</h1>
            {status && <p className="mt-1 text-xs text-zinc-400">{status}</p>}
            {multiplayerRole !== 'solo' && (
              <p className="mt-1 text-xs text-emerald-300">{multiplayerStatus}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-4">
            <button
              onClick={handleEndFlight}
              className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-bold text-zinc-300 transition-colors hover:border-red-500/50 hover:bg-red-950/40 hover:text-red-300"
            >
              END FLIGHT
            </button>
          </div>
        </div>

        <div className="mb-4">
          <FlightViewport
            posX={posX}
            posZ={posZ}
            altitude={altitude}
            pitch={pitch}
            roll={roll}
            heading={heading}
            airspeed={airspeed}
            crashed={crashed}
            remoteTelemetries={Object.values(remoteTelemetryByPlayer)}
            radarContacts={radarContacts}
            radarScanAzimuth={radarScanAzimuth}
            radarScanBar={radarScanBar}
            terrainOrigin={terrainOrigin}
            terrainGrid={terrainGrid}
            terrainStatus={terrainStatus}
            simulationTimeMinutes={simulationTimeMinutes}
          />
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-center">
            <span className="mb-1 block text-xs uppercase tracking-widest text-zinc-500">
              Ground
            </span>
            <span className="text-2xl font-bold text-zinc-100">{groundElevation.toFixed(0)}</span>
            <span className="mt-1 block text-xs text-zinc-600">FEET MSL</span>
          </div>

          <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-center">
            <span className="mb-1 block text-xs uppercase tracking-widest text-zinc-500">
              Attitude
            </span>
            <div className="text-sm font-bold text-zinc-200 mt-1">
              P: {pitch.toFixed(0)}°<br />
              R: {roll.toFixed(0)}°
            </div>
            <span className="mt-1 block text-xs text-zinc-600">PITCH / ROLL</span>
          </div>

          <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-center">
            <span className="mb-1 block text-xs uppercase tracking-widest text-zinc-500">
              Throttle Setting
            </span>
            <span className="text-2xl font-bold text-amber-400">{throttle.toFixed(0)}%</span>
          </div>

          <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-center">
            <span className="mb-1 block text-xs uppercase tracking-widest text-zinc-500">
              Vertical Speed
            </span>
            <span className="text-2xl font-bold text-zinc-200">{verticalSpeed.toFixed(0)}</span>
            <span className="mt-1 block text-xs text-zinc-600">FT/MIN</span>
          </div>
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
          </div>
        </div>
      </div>
    </main>
  );
}