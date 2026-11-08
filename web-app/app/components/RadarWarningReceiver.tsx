'use client';

export interface RadarWarningContact {
  emitterId: string;
  azimuth: number;
}

interface RadarWarningReceiverProps {
  contacts: RadarWarningContact[];
}

const center = 100;
const radius = 82;

function getBearingEndpoint(azimuth: number): { x: number; y: number } {
  const azimuthRadians = (azimuth * Math.PI) / 180;
  return {
    x: center + Math.sin(azimuthRadians) * radius * 0.88,
    y: center - Math.cos(azimuthRadians) * radius * 0.88,
  };
}

export default function RadarWarningReceiver({ contacts }: RadarWarningReceiverProps) {
  return (
    <section
      aria-label="Radar warning receiver"
      className="pointer-events-none relative w-40 rounded-lg border border-red-500/60 bg-zinc-950/90 p-2 font-mono text-[10px] text-red-200 shadow-lg shadow-red-950/50 backdrop-blur sm:w-48"
    >
      <header className="flex items-center justify-between border-b border-red-900/80 px-1 pb-1">
        <span className="font-bold tracking-wider text-red-300">RADAR WARNING RECEIVER</span>
      </header>
      <svg viewBox="0 0 200 200" className="block w-full" role="img" aria-label="Threat bearings">
        <circle cx={center} cy={center} r={radius} fill="#170606" stroke="#8f302b" strokeWidth="1.5" />
        <line x1={center} y1={center - radius} x2={center} y2={center + radius} stroke="#582320" strokeWidth="0.8" />
        <line x1={center - radius} y1={center} x2={center + radius} y2={center} stroke="#582320" strokeWidth="0.8" />
        {contacts.map((contact, index) => {
          const endpoint = getBearingEndpoint(contact.azimuth);
          return (
            <g key={contact.emitterId}>
              <line
                x1={center}
                y1={center}
                x2={endpoint.x}
                y2={endpoint.y}
                stroke="#ff766b"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <text
                x={endpoint.x + (contact.azimuth >= 0 ? 3 : -14)}
                y={endpoint.y - 3}
                fill="#ffd3ce"
                fontSize="7"
              >
                T{index + 1}
              </text>
            </g>
          );
        })}
        <path d="M 100 94 L 96 103 L 100 101 L 104 103 Z" fill="#fff1ef" stroke="#170606" strokeWidth="1" />
      </svg>
      <div className="space-y-0.5 border-t border-red-900/80 px-1 pt-1 text-[9px] text-red-100/90">
        {contacts.slice(0, 3).map((contact, index) => (
          <div key={contact.emitterId} className="flex justify-between gap-2">
            <span>T{index + 1} {contact.azimuth >= 0 ? '+' : ''}{contact.azimuth.toFixed(0)}°</span>
          </div>
        ))}
        {contacts.length > 3 && <div>+{contacts.length - 3} EMITTERS</div>}
      </div>
    </section>
  );
}
