/** Shared inline SVG icons (stroke-based, inherit `currentColor`). */

/** Shared props: 16px default, stroke inherits currentColor. */
function IconSvg({ children, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Trash / delete icon. Size defaults to 16; override via width/height props. */
export function TrashIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconSvg {...props}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </IconSvg>
  );
}

/** Pencil / edit icon. */
export function PencilIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconSvg {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </IconSvg>
  );
}

/** Pin icon (for "pin to top"). */
export function PinIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconSvg {...props}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z" />
    </IconSvg>
  );
}

/** Three-dot vertical "more actions" icon. */
export function MoreVerticalIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconSvg {...props}>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </IconSvg>
  );
}

/** Globe icon (public). */
export function GlobeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconSvg {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
    </IconSvg>
  );
}

/** Lock icon (private). */
export function LockIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconSvg {...props}>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </IconSvg>
  );
}

/** Mind-map icon (root with branching nodes). */
export function MindmapIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconSvg {...props}>
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="5" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
      <path d="M7.5 11 16.6 6.2" />
      <path d="M7.5 13 16.6 17.8" />
    </IconSvg>
  );
}

/** Outline / list icon (indented bullet rows). */
export function OutlineIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconSvg {...props}>
      <path d="M9 6h12" />
      <path d="M9 12h12" />
      <path d="M9 18h12" />
      <circle cx="4" cy="6" r="1" fill="currentColor" />
      <circle cx="4" cy="12" r="1" fill="currentColor" />
      <circle cx="4" cy="18" r="1" fill="currentColor" />
    </IconSvg>
  );
}
