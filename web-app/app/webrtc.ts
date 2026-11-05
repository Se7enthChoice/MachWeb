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
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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

  return (
    numericFields.every(field => {
      const fieldValue = value[field];
      return typeof fieldValue === 'number' && Number.isFinite(fieldValue);
    }) &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    typeof value.crashed === 'boolean'
  );
}

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
