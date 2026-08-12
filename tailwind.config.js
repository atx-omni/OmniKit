/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          pink: '#FF5FA2',
          wine: '#4D122C',
          ink: '#220411',
          warm: '#FCFCF7',
          muted: '#EFE9E3',
          blue: '#C7EEFF',
          green: '#C2FCA0',
          purple: '#FCD1FF',
        },
        omni: {
          950: '#220411',
          900: '#220411',
          800: '#4D122C',
          700: '#7C244B',
          600: '#D94482',
          500: '#FF5FA2',
          400: '#FF86BA',
          300: '#FFA6DD',
          200: '#FFD0E8',
          100: '#FFE7F2',
          50: '#FFF5F8',
        },
        surface: {
          primary: '#FCFCF7',
          secondary: '#EFE9E3',
          tertiary: '#E7DED7',
        },
        content: {
          primary: '#220411',
          secondary: '#5F4550',
          tertiary: '#7A6870',
          inverted: '#FCFCF7',
        },
        border: {
          DEFAULT: '#DED4CE',
          strong: '#C9BBB3',
          subtle: '#ECE5E0',
        },
        success: {
          DEFAULT: '#327A00',
          light: '#C2FCA0',
        },
        warning: {
          DEFAULT: '#7A4500',
          light: '#FFF0C7',
        },
        error: {
          DEFAULT: '#B42318',
          light: '#FFE5E1',
        },
        info: {
          DEFAULT: '#006EA8',
          light: '#C7EEFF',
        },
      },
      fontFamily: {
        display: ['"Cal Sans"', '"Avenir Next"', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        sans: ['"IBM Plex Sans"', '"Helvetica Neue"', 'Arial', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', '"SFMono-Regular"', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      borderRadius: {
        card: '8px',
        button: '8px',
        chip: '999px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(34, 4, 17, 0.06)',
        'card-hover': '0 6px 18px rgba(34, 4, 17, 0.09)',
        'card-raised': '0 10px 28px rgba(34, 4, 17, 0.11)',
        dropdown: '0 10px 28px rgba(34, 4, 17, 0.14)',
        'focus-ring': '0 0 0 2px #FCFCF7, 0 0 0 5px #4D122C',
        glow: 'none',
        'glow-sm': 'none',
        'inner-glow': 'inset 0 1px 2px rgba(255, 255, 255, 0.1)',
      },
      backgroundImage: {
        'omni-gradient': 'linear-gradient(#FF5FA2, #FF5FA2)',
        'omni-gradient-dark': 'linear-gradient(#4D122C, #4D122C)',
        'omni-gradient-soft': 'linear-gradient(#FCFCF7, #FCFCF7)',
        'sidebar-gradient': 'linear-gradient(#FCFCF7, #FCFCF7)',
        'surface-gradient': 'linear-gradient(#FCFCF7, #FCFCF7)',
        'card-shine': 'linear-gradient(#FCFCF7, #FCFCF7)',
        'dot-pattern': 'linear-gradient(#EFE9E3, #EFE9E3)',
      },
      backgroundSize: {
        'dot-sm': '16px 16px',
        'dot-md': '24px 24px',
      },
      animation: {
        float: 'float 3.8s cubic-bezier(0.37, 0, 0.63, 1) infinite',
        slideIn: 'slideIn 0.3s ease-out',
        wiggle: 'wiggle 0.5s ease-in-out',
        confetti: 'confettiBurst 0.6s ease-out forwards',
        rocketTrail: 'rocketTrail 1s cubic-bezier(0.22, 1, 0.36, 1) infinite',
        stepPulse: 'stepPulse 2s ease-in-out infinite',
        fadeIn: 'fadeIn 0.4s ease-out',
        shimmer: 'shimmer 2s linear infinite',
        pulse_slow: 'pulse 3s ease-in-out infinite',
        'slide-up': 'slideUp 0.3s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        glow_pulse: 'none',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% center' },
          '100%': { backgroundPosition: '200% center' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 8px rgba(255, 95, 162, 0.22)' },
          '50%': { boxShadow: '0 0 20px rgba(255, 95, 162, 0.4)' },
        },
      },
    },
  },
  plugins: [],
};
