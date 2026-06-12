import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    basicSsl(),
  ],

  // Allow LAN access (e.g., smartphones) only when explicitly enabled.
  server: {
    host: process.env.VITE_LAN === 'true',
  },
})
