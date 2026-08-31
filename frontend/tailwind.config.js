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
        // A deliberately-picked violet, not the default Tailwind/shadcn blue
        // every generated admin dashboard reaches for.
        brand: {
          50: '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          800: '#5b21b6',
          900: '#4c1d95',
          950: '#2e1065',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Manrope', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(76 29 149 / 0.04), 0 1px 3px 0 rgb(76 29 149 / 0.06)',
        popover: '0 8px 24px -4px rgb(76 29 149 / 0.12), 0 2px 8px -2px rgb(76 29 149 / 0.08)',
      },
    },
  },
  plugins: [],
};
