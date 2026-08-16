import Link from "next/link";

/**
 * The wordmark.
 *
 * An inline SVG rather than an image file: it inherits currentColor, so the
 * same mark works on the navy rail and on a white login card without a second
 * asset, and it costs no request.
 */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5 overflow-hidden">
      <Mark />
      {!compact ? (
        <span className="whitespace-nowrap text-[15px] font-bold tracking-tight text-white">
          Mega<span className="text-brand-400">force</span>
        </span>
      ) : null}
    </Link>
  );
}

/** The chevron block on its own, for the favicon slot and tight spaces. */
export function Mark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="7" fill="#00417A" />
      {/* Two forward chevrons: freight moving, and the ">" of a pipeline. */}
      <path d="M8 9.5 L15 16 L8 22.5" stroke="#00D563" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M17 9.5 L24 16 L17 22.5" stroke="#FFFFFF" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.9" />
    </svg>
  );
}
