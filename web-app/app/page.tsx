'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import FlightViewport from './components/FlightViewport';
import PreflightScreen from './components/PreflightScreen';
import type { HostPeerSession } from './components/PreflightScreen';
import {
  getAircraftCoordinates,
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

function formatTimeOfDay(totalMinutes: number): string {
  const wholeMinutes = Math.floor(totalMinutes) % (24 * 60);
  const hours = Math.floor(wholeMinutes / 60);
  const minutes = wholeMinutes % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

export default function Home() {
  const [latitudeInput, setLatitudeInput] = useState(String(DEFAULT_LATITUDE));
  const [longitudeInput, setLongitudeInput] = useState(String(DEFAULT_LONGITUDE));
  const [initialTimeInput, setInitialTimeInput] = useState('12:00');
  const [flightStartTimeMinutes, setFlightStartTimeMinutes] = useState(12 * 60);
  const [simulationTimeMinutes, setSimulationTimeMinutes] = useState(12 * 60);
  const simulationTimeRef = useRef(simulationTimeMinutes);
  const [terrainOrigin, setTerrainOrigin] = useState<TerrainOrigin>({
    latitude: DEFAULT_LATITUDE,
    longitude: DEFAULT_LONGITUDE,
  });
  const [terrainGrid, setTerrainGrid] = useState<TerrainGrid | null>(null);
  const [terrainStatus, setTerrainStatus] = useState('waiting for flight dynamics');
  const [setupError, setSetupError] = useState('');
  const [multiplayerRole, setMultiplayerRole] = useState<'solo' | 'host' | 'join'>('solo');
  const [multiplayerStatus, setMultiplayerStatus] = useState('Solo flight');
  const [multiplayerBusy, setMultiplayerBusy] = useState(false);
  const [multiplayerConnected, setMultiplayerConnected] = useState(false);
  const [localDescription, setLocalDescription] = useState('');
  const [remoteDescription, setRemoteDescription] = useState('');
  const [hostPeerSessions, setHostPeerSessions] = useState<HostPeerSession[]>([]);
  const [remoteTelemetryByPlayer, setRemoteTelemetryByPlayer] = useState<Record<string, FlightTelemetry>>({});
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
  const peerConnectionsRef = useRef(new Map<string, RTCPeerConnection>());
  const dataChannelsRef = useRef(new Map<string, RTCDataChannel>());
  const peerPlayersRef = useRef(new Map<string, Set<string>>());
  const multiplayerOperationRef = useRef(false);
  const hostTimeSequenceRef = useRef(0);
  const playerIdRef = useRef('');
  const telemetrySequenceRef = useRef(0);
  const terrainNeighborhoodKey = getTerrainNeighborhoodKey(terrainOrigin, posX, posZ);

  const refreshConnectedPeers = () => {
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

  const sendHostTime = (channel: RTCDataChannel, minutes: number) => {
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

  const closePeerConnections = () => {
    dataChannelsRef.current.forEach(channel => channel.close());
    peerConnectionsRef.current.forEach(connection => connection.close());
    dataChannelsRef.current.clear();
    peerConnectionsRef.current.clear();
    peerPlayersRef.current.clear();
    setRemoteTelemetryByPlayer({});
    setHostPeerSessions([]);
    setMultiplayerConnected(false);
  };

  const configurePeerConnection = (
    connection: RTCPeerConnection,
    sessionId: string,
    role: 'host' | 'join',
  ) => {
    connection.onconnectionstatechange = () => {
      if (peerConnectionsRef.current.get(sessionId) !== connection) return;
      if (connection.connectionState === 'connected') {
        setHostPeerSessions(sessions => sessions.map(session =>
          session.id === sessionId ? { ...session, status: 'connected' } : session,
        ));
      } else if (connection.connectionState === 'failed') {
        setHostPeerSessions(sessions => sessions.map(session =>
          session.id === sessionId ? { ...session, status: 'connection failed' } : session,
        ));
        if (role === 'join') setMultiplayerStatus('Connection failed. This network may require a TURN relay.');
      } else if (connection.connectionState === 'disconnected') {
        setHostPeerSessions(sessions => sessions.map(session =>
          session.id === sessionId ? { ...session, status: 'disconnected' } : session,
        ));
      }
    };
  };

  const configureDataChannel = (
    channel: RTCDataChannel,
    sessionId: string,
    role: 'host' | 'join',
  ) => {
    const lastReceivedSequences = new Map<string, number>();
    let lastReceivedTimeSequence = -1;
    let receivedHostTelemetry = false;
    dataChannelsRef.current.set(sessionId, channel);
    peerPlayersRef.current.set(sessionId, new Set());
    channel.onopen = () => {
      if (dataChannelsRef.current.get(sessionId) !== channel) return;
      setHostPeerSessions(sessions => sessions.map(session =>
        session.id === sessionId ? { ...session, status: 'connected' } : session,
      ));
      refreshConnectedPeers();
      if (role === 'host') {
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
        playerIds.forEach(playerId => delete next[playerId]);
        return next;
      });
      setHostPeerSessions(sessions => sessions.map(session =>
        session.id === sessionId ? { ...session, status: 'disconnected' } : session,
      ));
      refreshConnectedPeers();
    };
    channel.onerror = () => {
      setHostPeerSessions(sessions => sessions.map(session =>
        session.id === sessionId ? { ...session, status: 'data channel error' } : session,
      ));
    };
    channel.onmessage = event => {
      if (dataChannelsRef.current.get(sessionId) !== channel) return;
      if (typeof event.data !== 'string' || event.data.length > 16_384) {
        setMultiplayerStatus('Received an unsupported multiplayer message.');
        return;
      }
      const hostTime = parseFlightTimeMessage(event.data);
      if (hostTime) {
        if (role === 'join' && !receivedHostTelemetry && hostTime.sequence > lastReceivedTimeSequence) {
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
      if (telemetry.sequence <= (lastReceivedSequences.get(telemetry.playerId) ?? -1)) return;
      lastReceivedSequences.set(telemetry.playerId, telemetry.sequence);
      peerPlayersRef.current.get(sessionId)?.add(telemetry.playerId);
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

  const handleInitialTimeChange = (value: string) => {
    setInitialTimeInput(value);
    if (multiplayerRole !== 'host' || !/^\d{2}:\d{2}$/.test(value)) return;
    const [hours, minutes] = value.split(':').map(Number);
    const timeOfDayMinutes = hours * 60 + minutes;
    dataChannelsRef.current.forEach(channel => sendHostTime(channel, timeOfDayMinutes));
  };

  const handleMultiplayerRoleChange = (role: 'solo' | 'host' | 'join') => {
    closePeerConnections();
    setMultiplayerRole(role);
    setLocalDescription('');
    setRemoteDescription('');
    setMultiplayerStatus(role === 'solo' ? 'Solo flight' : `Ready to ${role === 'host' ? 'host' : 'join'} a flight.`);
  };

  const handleCreateOffer = async () => {
    if (multiplayerOperationRef.current) return;
    multiplayerOperationRef.current = true;
    setMultiplayerBusy(true);
    const sessionId = crypto.randomUUID();
    setHostPeerSessions(sessions => [...sessions, {
      id: sessionId,
      offer: '',
      answer: '',
      status: 'creating offer',
    }]);

    try {
      const connection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      peerConnectionsRef.current.set(sessionId, connection);
      configurePeerConnection(connection, sessionId, 'host');
      configureDataChannel(connection.createDataChannel('flight-telemetry', { ordered: false }), sessionId, 'host');
      await connection.setLocalDescription(await connection.createOffer());
      await waitForIceGatheringComplete(connection);
      if (!connection.localDescription) throw new Error('The peer connection did not produce a local offer.');
      const offer = encodeSessionDescription(connection.localDescription);
      setHostPeerSessions(sessions => sessions.map(session =>
        session.id === sessionId ? { ...session, offer, status: 'offer ready' } : session,
      ));
      setMultiplayerStatus('Offer ready. Share it with one joiner and apply their answer here.');
    } catch (error) {
      dataChannelsRef.current.get(sessionId)?.close();
      peerConnectionsRef.current.get(sessionId)?.close();
      dataChannelsRef.current.delete(sessionId);
      peerConnectionsRef.current.delete(sessionId);
      setHostPeerSessions(sessions => sessions.map(session =>
        session.id === sessionId ? { ...session, status: 'offer failed' } : session,
      ));
      const message = error instanceof Error ? error.message : String(error);
      setMultiplayerStatus(`Could not create offer: ${message}`);
    } finally {
      multiplayerOperationRef.current = false;
      setMultiplayerBusy(false);
    }
  };

  const handleCreateAnswer = async () => {
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
      connection.ondatachannel = event => configureDataChannel(event.channel, 'host', 'join');
      await connection.setRemoteDescription(decodeSessionDescription(remoteDescription, 'offer'));
      await connection.setLocalDescription(await connection.createAnswer());
      await waitForIceGatheringComplete(connection);
      if (!connection.localDescription) throw new Error('The peer connection did not produce a local answer.');
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

  const handleApplyAnswer = async (sessionId: string) => {
    if (multiplayerOperationRef.current) return;
    const session = hostPeerSessions.find(candidate => candidate.id === sessionId);
    const connection = peerConnectionsRef.current.get(sessionId);
    if (!session || !connection) {
      setMultiplayerStatus('Create a fresh offer before applying this answer.');
      return;
    }

    multiplayerOperationRef.current = true;
    setMultiplayerBusy(true);
    setHostPeerSessions(sessions => sessions.map(candidate =>
      candidate.id === sessionId ? { ...candidate, status: 'connecting' } : candidate,
    ));
    try {
      await connection.setRemoteDescription(decodeSessionDescription(session.answer, 'answer'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHostPeerSessions(sessions => sessions.map(candidate =>
        candidate.id === sessionId ? { ...candidate, status: 'answer rejected' } : candidate,
      ));
      setMultiplayerStatus(`Could not apply answer: ${message}`);
    } finally {
      multiplayerOperationRef.current = false;
      setMultiplayerBusy(false);
    }
  };

  const handleHostAnswerChange = (sessionId: string, answer: string) => {
    setHostPeerSessions(sessions => sessions.map(session =>
      session.id === sessionId ? { ...session, answer } : session,
    ));
  };

  const handleStartFlight = (event: FormEvent<HTMLFormElement>) => {
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

    const startTimeMinutes = multiplayerRole === 'join' && multiplayerConnected
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

  const handleEndFlight = () => {
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
    setVSpeed(0);
    setStalled(false);
  };

  const toggleAutoLevel = () => {
    const nextVal = !autoLevel;
    setAutoLevel(nextVal);
    autoLevelRef.current = nextVal;
  };

  useEffect(() => () => {
    dataChannelsRef.current.forEach(channel => channel.close());
    peerConnectionsRef.current.forEach(connection => connection.close());
  }, []);

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
        let telemetrySendElapsed = 0;

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
            const nextStalled = engineInstance.getStalled();
            setStalled(nextStalled);

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
                verticalSpeed: nextVSpeed,
                stalled: nextStalled,
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
  }, [multiplayerRole, simulationStarted, terrainOrigin]);

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

  useEffect(() => {
    simulationTimeRef.current = simulationTimeMinutes;
  }, [simulationTimeMinutes]);

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
            {multiplayerRole !== 'solo' && (
              <p className="mt-1 text-xs text-emerald-300">{multiplayerStatus}</p>
            )}
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
            remoteTelemetries={Object.values(remoteTelemetryByPlayer)}
            terrainOrigin={terrainOrigin}
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