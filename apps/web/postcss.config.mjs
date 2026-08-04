/**
 * Tailwind v4 is a PostCSS plugin and nothing else — no `tailwind.config.js`, no `autoprefixer`.
 * The theme comes from `@theme` in `@nport/design-tokens`, imported by `src/app/globals.css`.
 */
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
}
