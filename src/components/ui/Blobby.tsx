import { BLOBBY_MOOD_TO_SRC, type BlobbyMood } from './blobbyAssets';

interface BlobbyProps {
  mood: BlobbyMood;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  alt?: string;
}

export function Blobby({ mood, size = 48, className = '', style, alt }: BlobbyProps) {
  return (
    <img
      src={BLOBBY_MOOD_TO_SRC[mood]}
      alt={alt ?? `Blobby ${mood}`}
      width={size}
      height={size}
      className={`select-none pointer-events-none object-contain ${className}`}
      style={{ width: size, height: size, ...style }}
      draggable={false}
    />
  );
}
