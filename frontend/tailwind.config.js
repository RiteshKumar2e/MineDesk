/** @type {import('tailwindcss').Config} */
export default {
  // 'class' rather than the 'media' default: nothing in this app ever adds a
  // `dark` class, so every `dark:` utility (if any remain) simply never
  // activates - the product is light-only by design, not "light unless your
  // OS prefers dark".
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm amber, not the violet this started with - every component
        // uses these semantic brand-* classes rather than a hardcoded
        // color, so this one swap is what actually reskins the whole app.
        brand: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f',
          950: '#451a03',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Manrope', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(120 53 15 / 0.04), 0 1px 3px 0 rgb(120 53 15 / 0.06)',
        popover: '0 8px 24px -4px rgb(120 53 15 / 0.12), 0 2px 8px -2px rgb(120 53 15 / 0.08)',
      },
    },
  },
  plugins: [],
};
