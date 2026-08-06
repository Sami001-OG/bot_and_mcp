type LogoProps = {
  size?: number;
  className?: string;
};

export function NexusLogo({ size = 40, className }: LogoProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 64 64"
      width={size}
    >
      <defs>
        <linearGradient id="nexus-logo-gradient" x1="10" x2="54" y1="8" y2="56">
          <stop stopColor="#A991FF" />
          <stop offset="0.5" stopColor="#7357FF" />
          <stop offset="1" stopColor="#32D8A0" />
        </linearGradient>
      </defs>
      <rect fill="#11131B" height="60" rx="17" width="60" x="2" y="2" />
      <path
        d="M15 43V21l17 22 17-22v22"
        stroke="url(#nexus-logo-gradient)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="6"
      />
      <circle cx="15" cy="21" fill="#A991FF" r="4" />
      <circle cx="32" cy="43" fill="#7357FF" r="4" />
      <circle cx="49" cy="21" fill="#32D8A0" r="4" />
    </svg>
  );
}
