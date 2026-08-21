type LogoProps = {
  size?: number;
  className?: string;
};

export function BotxLogo({ size = 40, className }: LogoProps) {
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
        <linearGradient id="botx-logo-gradient" x1="17" y1="11" x2="50" y2="54" gradientUnits="userSpaceOnUse">
          <stop stopColor="#A991FF" />
          <stop offset="0.5" stopColor="#7357FF" />
          <stop offset="1" stopColor="#32D8A0" />
        </linearGradient>
      </defs>
      <rect fill="#10121B" height="60" rx="17" width="60" x="2" y="2" />
      <path
        d="M20.25 49V15h12a8 8 0 0 1 0 16h-12m0 0h14.5a9 9 0 0 1 0 18H20.25"
        stroke="url(#botx-logo-gradient)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="5.5"
      />
    </svg>
  );
}
