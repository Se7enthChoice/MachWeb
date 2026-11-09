// Flight telemetry data associated with a peer connection.
export interface FlightTelemetry {
  playerId: string;
  isHost: boolean;
  posX: number;
  posZ: number;
  altitude: number;
  pitch: number;
  roll: number;
  heading: number;
  airspeed: number;
  throttle: number;
  verticalSpeed: number;
  crashed: boolean;
  latitude: number;
  longitude: number;
  sequence: number;
  simulationTimeMinutes: number;
  radarDetectedPlayerIds?: string[];
  missiles?: MissileTelemetry[];
}

// Network-safe missile snapshot; exploded missiles retain impactPlayerId for crash reporting.
export interface MissileTelemetry {
  missileId: number; // Unique within the launching player's current flight.
  typeId: number; // Selects the C++ missile profile used for this launch.
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number;
  pitch: number;
  exploded: boolean; // Keeps the impact visible while the explosion effect is reported.
  triggersRwr: boolean; // Whether this in-flight weapon is an RWR threat.
  targetPlayerId: string | null; // Intended radar target; null for an unguided launch.
  impactPlayerId?: string | null; // Aircraft actually hit
}

// Encodes a WebRTC description as a UTF-8-safe Base64 string for manual exchange.
export function encodeSessionDescription(description: RTCSessionDescriptionInit): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ type: description.type, sdp: description.sdp }),
  );
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

// Decodes and validates a manually exchanged WebRTC offer or answer.
export function decodeSessionDescription(
  encoded: string,
  expectedType: 'offer' | 'answer',
): RTCSessionDescriptionInit {
  try {
    const binary = atob(encoded.trim());
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const description = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (
      typeof description !== 'object' ||
      description === null ||
      !('type' in description) ||
      description.type !== expectedType ||
      !('sdp' in description) ||
      typeof description.sdp !== 'string'
    ) {
      throw new Error(`The supplied text is not a valid WebRTC ${expectedType}.`);
    }

    return { type: expectedType, sdp: description.sdp };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The supplied text')) throw error;
    throw new Error(`Could not decode the WebRTC ${expectedType}. Check that the entire string was copied.`);
  }
}

// Resolves once ICE candidates are gathered, or rejects if gathering closes or times out.
export function waitForIceGatheringComplete(
  connection: RTCPeerConnection,
  timeoutMs = 30_000,
): Promise<void> {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      connection.removeEventListener('icegatheringstatechange', handleStateChange);
    };
    const handleStateChange = () => {
      if (connection.iceGatheringState === 'complete') {
        cleanup();
        resolve();
      } else if (connection.signalingState === 'closed') {
        cleanup();
        reject(new Error('The peer connection closed before ICE gathering completed.'));
      }
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out while gathering ICE candidates. Try creating the offer or answer again.'));
    }, timeoutMs);

    connection.addEventListener('icegatheringstatechange', handleStateChange);
    handleStateChange();
  });
}

// Narrows untrusted parsed JSON to a non-null object record.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Validates the complete telemetry payload before it is used or relayed.
function isFlightTelemetry(value: unknown): value is FlightTelemetry {
  if (!isRecord(value)) return false;
  if (typeof value.playerId !== 'string' || value.playerId.length === 0 || value.playerId.length > 64) {
    return false;
  }
  if (typeof value.isHost !== 'boolean') return false;
  const numericFields: Array<keyof Omit<FlightTelemetry, 'crashed'>> = [
    'posX',
    'posZ',
    'altitude',
    'pitch',
    'roll',
    'heading',
    'airspeed',
    'throttle',
    'verticalSpeed',
    'latitude',
    'longitude',
    'simulationTimeMinutes',
  ];

  const validMissiles =
    value.missiles === undefined ||
    (Array.isArray(value.missiles) &&
      value.missiles.length <= 16 &&
      value.missiles.every(missile =>
        isRecord(missile) &&
        typeof missile.missileId === 'number' &&
        Number.isSafeInteger(missile.missileId) &&
        missile.missileId > 0 &&
        typeof missile.typeId === 'number' &&
        Number.isSafeInteger(missile.typeId) &&
        missile.typeId > 0 &&
        typeof missile.latitude === 'number' &&
        Number.isFinite(missile.latitude) &&
        missile.latitude >= -90 &&
        missile.latitude <= 90 &&
        typeof missile.longitude === 'number' &&
        Number.isFinite(missile.longitude) &&
        missile.longitude >= -180 &&
        missile.longitude <= 180 &&
        typeof missile.altitude === 'number' &&
        Number.isFinite(missile.altitude) &&
        typeof missile.heading === 'number' &&
        Number.isFinite(missile.heading) &&
        typeof missile.pitch === 'number' &&
        Number.isFinite(missile.pitch) &&
        typeof missile.exploded === 'boolean' &&
        typeof missile.triggersRwr === 'boolean' &&
        (missile.targetPlayerId === null ||
          (typeof missile.targetPlayerId === 'string' &&
            missile.targetPlayerId.length > 0 &&
            missile.targetPlayerId.length <= 64)) &&
        (missile.impactPlayerId === undefined ||
          missile.impactPlayerId === null ||
          (typeof missile.impactPlayerId === 'string' &&
            missile.impactPlayerId.length > 0 &&
            missile.impactPlayerId.length <= 64)),
      ));

  return (
    numericFields.every(field => {
      const fieldValue = value[field];
      return typeof fieldValue === 'number' && Number.isFinite(fieldValue);
    }) &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    typeof value.crashed === 'boolean' &&
    (value.radarDetectedPlayerIds === undefined ||
      (Array.isArray(value.radarDetectedPlayerIds) &&
        value.radarDetectedPlayerIds.length <= 64 &&
        value.radarDetectedPlayerIds.every(
          playerId =>
            typeof playerId === 'string' && playerId.length > 0 && playerId.length <= 64,
          ))) &&
    validMissiles
  );
}

// Parses a host-time message, returning null for malformed or out-of-range data.
export function parseFlightTimeMessage(
  message: string,
): { minutes: number; sequence: number } | null {
  try {
    const parsed: unknown = JSON.parse(message);
    if (
      !isRecord(parsed) ||
      parsed.type !== 'flight-time' ||
      typeof parsed.minutes !== 'number' ||
      !Number.isFinite(parsed.minutes) ||
      parsed.minutes < 0 ||
      parsed.minutes >= 24 * 60 ||
      typeof parsed.sequence !== 'number' ||
      !Number.isSafeInteger(parsed.sequence) ||
      parsed.sequence < 0
    ) {
      return null;
    }

    return { minutes: parsed.minutes, sequence: parsed.sequence };
  } catch {
    return null;
  }
}

// Parses and validates a telemetry envelope received over a data channel.
export function parseFlightTelemetryMessage(message: string): FlightTelemetry | null {
  try {
    const parsed: unknown = JSON.parse(message);
    if (!isRecord(parsed) || parsed.type !== 'telemetry' || !isFlightTelemetry(parsed.telemetry)) {
      return null;
    }

    return parsed.telemetry;
  } catch {
    return null;
  }
}
