/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"Geist Mono"', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Argus palette: a green-black ink, maker green, taker rose, and amber for "your order".
        ink: { DEFAULT: '#07090a', 900: '#0b0f0e', 800: '#111816', 700: '#1a2420', 600: '#26332e' },
        maker: { DEFAULT: '#2fd39a', dim: '#1f8f69' },
        taker: { DEFAULT: '#f0627e' },
        queue: { DEFAULT: '#f5b94a' },
      },
      keyframes: {
        pulseDot: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
        rise: { from: { opacity: '0.001', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: {
        pulseDot: 'pulseDot 1.6s ease-in-out infinite',
        rise: 'rise .5s ease-out both',
      },
    },
  },
  plugins: [],
};
