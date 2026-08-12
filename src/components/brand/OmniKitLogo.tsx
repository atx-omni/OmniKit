interface OmniKitLogoProps {
  className?: string;
  variant?: 'dark' | 'light';
  size?: 'sm' | 'md' | 'lg';
  subtitle?: string;
}

const SIZE_CLASSES = {
  sm: {
    logo: 'h-5 w-auto',
    descriptor: 'text-[9px]',
    divider: 'h-3',
    gap: 'gap-1.5',
    subtitle: 'text-[9px]',
  },
  md: {
    logo: 'h-6 w-auto',
    descriptor: 'text-[10px]',
    divider: 'h-4',
    gap: 'gap-2',
    subtitle: 'text-[10px]',
  },
  lg: {
    logo: 'h-7 w-auto',
    descriptor: 'text-[11px]',
    divider: 'h-5',
    gap: 'gap-2.5',
    subtitle: 'text-[11px]',
  },
};

function OmniWordmark({ className }: { className: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 88 36"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M11.2149 6.97949C4.69396 6.97949 0 11.7946 0 18.1548C0 24.515 4.69396 29.3301 11.2149 29.3301C17.7358 29.3301 22.4298 24.5166 22.4298 18.1548C22.4298 11.793 17.7358 6.97949 11.2149 6.97949ZM11.2149 25.1003C7.17728 25.1003 4.48498 22.1091 4.48498 18.1548C4.48498 14.2006 7.17728 11.2094 11.2149 11.2094C15.2525 11.2094 17.9448 14.1665 17.9448 18.1548C17.9448 22.1431 15.2525 25.1003 11.2149 25.1003Z" fill="currentColor" />
      <path d="M19.9464 31.8739H2.48488C1.2767 31.8739 0.346069 32.6991 0.346069 33.9361C0.346069 35.1732 1.27833 36 2.48488 36H19.9464C21.1546 36 22.0852 35.1748 22.0852 33.9361C22.0852 32.6975 21.153 31.8739 19.9464 31.8739Z" fill="currentColor" />
      <path d="M85.066 5.84466C86.7918 5.84466 87.9999 4.57198 87.9999 2.92154C87.9999 1.2711 86.7918 -0.00158691 85.066 -0.00158691C83.3403 -0.00158691 82.1321 1.23705 82.1321 2.92154C82.1321 4.60602 83.3746 5.84466 85.066 5.84466Z" fill="currentColor" />
      <path d="M85.0661 7.49512C83.7207 7.49512 82.8228 8.49219 82.8228 9.79892V26.4752C82.8228 27.7819 83.7207 28.813 85.0661 28.813C86.4114 28.813 87.3094 27.7819 87.3094 26.4752V9.79892C87.3094 8.49219 86.4114 7.49512 85.0661 7.49512Z" fill="currentColor" />
      <path d="M69.9849 6.97949C67.4249 6.97949 65.2469 7.8193 63.6305 9.3368C63.4444 8.26515 62.6085 7.49505 61.4264 7.49505C60.0811 7.49505 59.1831 8.49212 59.1831 9.79886V26.4751C59.1831 27.7818 60.0795 28.813 61.4264 28.813C62.7734 28.813 63.6697 27.7818 63.6697 26.4751V17.2275C63.7709 12.842 66.5188 11.0715 69.3645 11.0715C72.2103 11.0715 75.1965 12.9976 75.0593 17.8111V26.4767C75.0593 27.7835 75.9557 28.8146 77.3026 28.8146C78.6496 28.8146 79.5459 27.7835 79.5459 26.4767V17.8111C79.6847 10.7619 75.8871 6.97949 69.9866 6.97949H69.9849Z" fill="currentColor" />
      <path d="M47.3821 6.97953C44.8155 6.97953 42.4645 8.0074 40.7975 9.74215C39.3852 8.00416 37.2758 6.97953 34.6129 6.97953C32.559 6.97953 30.8267 7.67829 29.5026 8.85532C29.1793 8.04145 28.4299 7.49509 27.434 7.49509C26.0887 7.49509 25.1907 8.49216 25.1907 9.79889V26.4751C25.1907 27.7819 26.087 28.813 27.434 28.813C28.7809 28.813 29.6773 27.7819 29.6773 26.4751V15.7424C29.7965 12.6831 31.5794 11.07 33.9908 11.07C36.4023 11.07 38.2032 12.6993 38.306 15.7878C38.2995 16.0002 38.3044 26.4735 38.3044 26.4735C38.3044 27.7802 39.2024 28.8114 40.5477 28.8114C41.893 28.8114 42.791 27.7802 42.791 26.4735C42.791 26.4735 42.7943 15.9856 42.791 15.7651C42.902 12.6912 44.6882 11.0683 47.1062 11.0683C49.694 11.0683 51.5585 12.9247 51.4197 16.4331V26.4735C51.4197 27.7802 52.3177 28.8114 53.663 28.8114C55.0084 28.8114 55.9063 27.7802 55.9063 26.4735V16.4331C56.0435 10.8965 52.9724 6.97791 47.3821 6.97791V6.97953Z" fill="currentColor" />
    </svg>
  );
}

export function OmniKitLogo({ className = '', variant = 'dark', size = 'md', subtitle }: OmniKitLogoProps) {
  const sizing = SIZE_CLASSES[size];
  const light = variant === 'light';

  return (
    <div
      className={`inline-flex min-w-0 items-center ${sizing.gap} ${className}`}
      role="img"
      aria-label={`Omni Kit${subtitle ? `, ${subtitle}` : ''}`}
      style={{ color: light ? 'var(--omni-brand-warm)' : 'var(--omni-brand-ink)' }}
    >
      <OmniWordmark className={`${sizing.logo} block shrink-0`} />
      <span
        aria-hidden="true"
        className={`${sizing.divider} w-px shrink-0`}
        style={{ backgroundColor: light ? 'rgba(255,255,255,0.28)' : 'var(--omni-border-strong)' }}
      />
      <span
        aria-hidden="true"
        className={`${sizing.descriptor} shrink-0 font-semibold leading-none tracking-normal`}
        style={{ color: light ? 'rgba(252,252,247,0.78)' : 'var(--omni-brand-wine)' }}
      >
        Kit
      </span>
      {subtitle && (
        <span
          aria-hidden="true"
          className={`${sizing.subtitle} min-w-0 truncate border-l pl-2 font-medium leading-none tracking-normal`}
          style={{
            borderColor: light ? 'rgba(255,255,255,0.2)' : 'var(--omni-border)',
            color: light ? 'rgba(255,255,255,0.72)' : 'var(--omni-brand-wine)',
          }}
        >
          {subtitle}
        </span>
      )}
    </div>
  );
}
