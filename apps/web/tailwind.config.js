/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          100: '#dbe7fe',
          200: '#bfd6fe',
          300: '#93bbfd',
          400: '#6098fa',
          500: '#3b78f6',
          600: '#255aeb',
          700: '#1d47d8',
          800: '#1e3caf',
          900: '#1e368a',
          950: '#172554',
        },
      },
    },
  },
  plugins: [],
};
