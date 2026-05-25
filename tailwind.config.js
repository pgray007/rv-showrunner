/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/client/**/*.{jsx,js,html}'],
  theme: {
    extend: {
      colors: {
        surface: '#1a1a2e',
        panel: '#16213e',
        border: '#0f3460',
        accent: '#e94560',
      },
    },
  },
  plugins: [],
};
