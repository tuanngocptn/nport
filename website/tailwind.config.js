/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./*.html'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        accent: {
          DEFAULT: '#22C55E',
          hover: '#16A34A',
        },
        surface: {
          DEFAULT: '#0F172A',
          card: '#1E293B',
        },
        border: '#334155',
        'text-primary': '#F8FAFC',
        'text-muted': '#94A3B8',
        'light-bg': '#F8FAFC',
        'light-card': '#FFFFFF',
        'light-border': '#E2E8F0',
        'light-text': '#0F172A',
        'light-muted': '#64748B',
      },
    },
  },
  plugins: [],
};
