/**
 * Inline icon set. The storefront carries no UI dependency (the ERP has
 * lucide-react; this app deliberately does not), so the handful of glyphs the
 * chrome needs are drawn here at the same stroke weight as the ERP's icons.
 */
type IconProps = { size?: number; className?: string };

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

export function BagIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6 8h12l-1 12H7L6 8Z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

export function SearchIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function MoonIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

export function SunIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function MenuIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function CheckIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

export function AlertIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4m0 4h.01" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m5 9 7 7 7-7" />
    </svg>
  );
}

export function StoreIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 10v9h16v-9" />
      <path d="M3 10l2-6h14l2 6a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0Z" />
    </svg>
  );
}

export function ReceiptIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  );
}

export function BoxesIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
    </svg>
  );
}

export function SyncIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M20 11a8 8 0 0 0-13.6-4.6L3 9" />
      <path d="M4 13a8 8 0 0 0 13.6 4.6L21 15" />
      <path d="M3 4v5h5M21 20v-5h-5" />
    </svg>
  );
}

export function LogOutIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 8l-4 4 4 4M6 12h9" />
    </svg>
  );
}

export function HelpIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01" />
    </svg>
  );
}

export function TruckIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" />
      <circle cx="7" cy="18" r="1.6" />
      <circle cx="17.5" cy="18" r="1.6" />
    </svg>
  );
}

export function CardIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18M7 15h4" />
    </svg>
  );
}

export function SparkIcon({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3v4m0 10v4M3 12h4m10 0h4M6.3 6.3l2.8 2.8m5.8 5.8 2.8 2.8m0-11.4-2.8 2.8m-5.8 5.8-2.8 2.8" />
    </svg>
  );
}

export function ArrowUpRightIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

export function ArrowLeftIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M19 12H5m6-7-7 7 7 7" />
    </svg>
  );
}

export function UsersIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.6a3 3 0 0 1 0 5.8M17.5 19a5 5 0 0 0-2-4" />
    </svg>
  );
}

export function PulseIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 12h3.5l2-5 3 10 2.5-5H21" />
    </svg>
  );
}

export function CogIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 11.5 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.4 11a2 2 0 1 1 0 4Z" />
    </svg>
  );
}

export function RefreshIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M20 11a8 8 0 0 0-13.6-4.6L3 9" />
      <path d="M4 13a8 8 0 0 0 13.6 4.6L21 15" />
      <path d="M3 4v5h5M21 20v-5h-5" />
    </svg>
  );
}
