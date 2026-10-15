import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { measurementRelay } from './server/relay'

export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl(), measurementRelay()],
  server: { host: process.env.VITE_LAN === 'true' },
})
