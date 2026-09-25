export interface BoxingGloveIconProps {
  className?: string;
}

export function BoxingGloveIcon({ className = "w-4 h-4" }: BoxingGloveIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M7 20l1-4" />
      <path d="M9 16c-2 0-4-1-4-4V8c0-2 2-4 4-4h2c1 0 2 .5 2.5 1.5.5-1 1.5-1.5 2.5-1.5h1c2 0 4 2 4 4v1c0 3-2 5-4 6l-1 1" />
      <path d="M13 8v4" />
    </svg>
  );
}
