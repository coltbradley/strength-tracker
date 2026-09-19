// Load-mode icons: barbell, plate-loaded machine, pin stack, dumbbell,
// kettlebell — in the house style (see components/FabDock.tsx): a 24x24
// viewBox, a single <g> of currentColor strokes, decorative only
// (aria-hidden). `count` lets the dumbbell and kettlebell glyphs show one
// or two implements, so the same icon that names the equipment also
// announces the per-hand toggle's current state. Every caller is
// responsible for its own visible or aria- label — these components carry
// none, on purpose, so a decorative icon can never announce itself twice.

import type { ReactElement, ReactNode } from "react";

export interface LoadIconProps {
  size?: number;
  count?: 1 | 2;
}

function Svg({
  size = 20,
  children,
}: {
  size?: number;
  children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </g>
    </svg>
  );
}

export function BarbellIcon({ size }: LoadIconProps): ReactElement {
  return (
    <Svg size={size}>
      <path d="M2 12h4M18 12h4" />
      <path d="M5 8v8M19 8v8" />
      <path d="M7 10v4M17 10v4" />
      <path d="M7 12h10" />
    </Svg>
  );
}

export function PlateMachineIcon({ size }: LoadIconProps): ReactElement {
  return (
    <Svg size={size}>
      <rect x="3" y="9" width="4" height="6" rx="0.5" />
      <rect x="17" y="9" width="4" height="6" rx="0.5" />
      <path d="M7 12h10" />
      <path d="M10 5v14M14 5v14" />
    </Svg>
  );
}

export function StackIcon({ size }: LoadIconProps): ReactElement {
  return (
    <Svg size={size}>
      <rect x="6" y="4" width="12" height="3" />
      <rect x="6" y="8.5" width="12" height="3" />
      <rect x="6" y="13" width="12" height="3" />
      <circle cx="12" cy="19" r="1.4" />
    </Svg>
  );
}

function DumbbellGlyph({ transform }: { transform?: string }) {
  return (
    <g transform={transform}>
      <path d="M8 12h8" />
      <rect x="4.5" y="9" width="3" height="6" rx="0.6" />
      <rect x="16.5" y="9" width="3" height="6" rx="0.6" />
    </g>
  );
}

export function DumbbellIcon({
  size,
  count = 1,
}: LoadIconProps): ReactElement {
  return (
    <Svg size={size}>
      {count === 2 ? (
        <>
          <DumbbellGlyph transform="translate(-3 -4) scale(0.62)" />
          <DumbbellGlyph transform="translate(9 6) scale(0.62)" />
        </>
      ) : (
        <DumbbellGlyph />
      )}
    </Svg>
  );
}

function KettlebellGlyph({ transform }: { transform?: string }) {
  return (
    <g transform={transform}>
      <path d="M9.5 7a2.5 2.5 0 0 1 5 0v1.2h-5z" />
      <circle cx="12" cy="15.5" r="5" />
    </g>
  );
}

export function KettlebellIcon({
  size,
  count = 1,
}: LoadIconProps): ReactElement {
  return (
    <Svg size={size}>
      {count === 2 ? (
        <>
          <KettlebellGlyph transform="translate(-4 -2) scale(0.6)" />
          <KettlebellGlyph transform="translate(8 8) scale(0.6)" />
        </>
      ) : (
        <KettlebellGlyph />
      )}
    </Svg>
  );
}
