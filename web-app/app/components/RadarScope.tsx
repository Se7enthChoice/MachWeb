'use client';

import { useEffect, useState } from 'react';

export interface RadarContact {
  // Target IDs stay stable as tracks are refreshed from the simulation.
  targetId: number;
  // Latest detected slant range and body-relative angles supplied by the radar model.
  rangeNm: number;
  azimuth: number;
  elevation: number;
  // A stale return fades while the antenna scans other bars and bearings.
  ageSeconds: number;
}

// Scan state is supplied by the simulation; only range scaling is local display state.
interface RadarScopeProps {
  contacts: RadarContact[];
  scanAzimuth: number;
  scanBar: number;
}

// The scope uses a fixed SVG coordinate system and scales only range display.
const center = 100;
const radius = 82;
const initialRangeNm = 40;
const minimumRangeNm = 10;
const maximumRangeNm = 80;
// Quarter-range marks are shared by the scope rings and their numeric labels.
const rangeRings = [0.25, 0.5, 0.75];

// Converts relative bearing and range into the scope's forward-up screen position.
function getContactPosition(
  contact: RadarContact,
  maxRangeNm: number,
): { x: number; y: number } {
  const distance = (contact.rangeNm / maxRangeNm) * radius;
  const azimuthRadians = (contact.azimuth * Math.PI) / 180;
  return {
    x: center + Math.sin(azimuthRadians) * distance,
    y: center - Math.cos(azimuthRadians) * distance,
  };
}

export default function RadarScope({ contacts, scanAzimuth, scanBar }: RadarScopeProps) {
  const [maxRangeNm, setMaxRangeNm] = useState(initialRangeNm);

  // Capture the scope shortcuts before the flight controls handle the same key event.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select'))
      ) {
        return;
      }

      const zoomIn = event.code === 'Equal' && event.key === '=';
      const zoomOut = event.code === 'Minus' && event.key === '-';
      if (!zoomIn && !zoomOut) return;

      event.preventDefault();
      event.stopPropagation();
      setMaxRangeNm(current => zoomIn
        ? Math.max(minimumRangeNm, current / 2)
        : Math.min(maximumRangeNm, current * 2));
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // Contacts beyond the selected display scale are listed but not plotted at the rim.
  const visibleContacts = contacts.filter(contact => contact.rangeNm <= maxRangeNm);

  return (
    <section
      aria-label="Aircraft radar scope"
      className="pointer-events-none relative w-40 rounded-lg border border-emerald-500/40 bg-zinc-950/90 p-2 font-mono text-[10px] text-emerald-200 shadow-lg backdrop-blur sm:w-48"
    >
      <svg viewBox="0 0 200 200" className="block w-full" role="img" aria-label="Heading-up radar">
        <circle cx={center} cy={center} r={radius} fill="#03120f" stroke="#28664f" strokeWidth="1.5" />
        {/* Circular marks show selected-range fractions; the center marker is ownship. */}
        {rangeRings.map(scale => (
          <circle
            key={scale}
            cx={center}
            cy={center}
            r={radius * scale}
            fill="none"
            stroke="#1b4b3b"
            strokeWidth="0.8"
          />
        ))}
        <line x1={center} y1={center - radius} x2={center} y2={center + radius} stroke="#1b4b3b" strokeWidth="0.8" />
        <line x1={center - radius} y1={center} x2={center + radius} y2={center} stroke="#1b4b3b" strokeWidth="0.8" />
        <line
          x1={center}
          y1={center}
          x2={center - Math.sin(Math.PI / 3) * radius}
          y2={center - Math.cos(Math.PI / 3) * radius}
          stroke="#28664f"
          strokeWidth="0.8"
        />
        <line
          x1={center}
          y1={center}
          x2={center + Math.sin(Math.PI / 3) * radius}
          y2={center - Math.cos(Math.PI / 3) * radius}
          stroke="#28664f"
          strokeWidth="0.8"
        />
        {[...rangeRings, 1].map(scale => (
          <text
            key={scale}
            x="102"
            y={center - radius * scale + 2}
            fill="#5a9c7d"
            fontSize="7"
          >
            {Number.isInteger(maxRangeNm * scale)
              ? maxRangeNm * scale
              : (maxRangeNm * scale).toFixed(1)}
          </text>
        ))}
        <text x="20" y="57" fill="#5a9c7d" fontSize="7">-60</text>
        <text x="174" y="57" fill="#5a9c7d" fontSize="7">+60</text>
        {/* The line indicates the current scan azimuth, rotated relative to ownship. */}
        <line
          x1={center}
          y1={center}
          x2={center}
          y2={center - radius}
          stroke="#72ffb5"
          strokeOpacity="0.9"
          strokeWidth="1.5"
          transform={`rotate(${scanAzimuth} ${center} ${center})`}
        />
        {visibleContacts.map(contact => {
          const position = getContactPosition(contact, maxRangeNm);
          const opacity = Math.max(0.2, 1 - contact.ageSeconds / 4);
          return (
            <g key={contact.targetId} opacity={opacity}>
              <circle cx={position.x} cy={position.y} r="3" fill="#a7ffd0" />
            </g>
          );
        })}
        <path
          d="M 100 94 L 96 103 L 100 101 L 104 103 Z"
          fill="#eafff3"
          stroke="#03120f"
          strokeWidth="1"
        />
      </svg>
      <footer className="flex justify-between border-t border-emerald-900/80 px-1 pt-1 text-[9px]">
        <span>RANGE {maxRangeNm} NM</span>
        <span>{contacts.length} CONTACT{contacts.length === 1 ? '' : 'S'}</span>
      </footer>
      <div className="flex justify-between px-1 pt-1 text-[9px] text-emerald-300/70">
        <span>4-BAR · BAR {scanBar}/4</span>
        <span>= / - RANGE</span>
      </div>
      {contacts.length > 0 && (
        <div className="mt-1 space-y-0.5 border-t border-emerald-900/80 px-1 pt-1 text-[9px] text-emerald-100/90">
          {contacts.slice(0, 2).map((contact, index) => (
            <div key={contact.targetId} className="flex justify-between gap-2">
              <span>T{index + 1} {contact.azimuth >= 0 ? '+' : ''}{contact.azimuth.toFixed(0)}°</span>
              <span>{contact.rangeNm.toFixed(1)} NM</span>
              <span>{contact.elevation >= 0 ? 'UP ' : 'DN '}{Math.abs(contact.elevation).toFixed(0)}°</span>
            </div>
          ))}
          {contacts.length > 2 && <div>+{contacts.length - 2} TRACKS</div>}
        </div>
      )}
    </section>
  );
}
