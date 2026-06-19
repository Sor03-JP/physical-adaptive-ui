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

    {
      name: 'ws-gateway',
      configureServer(server) {
        server.ws.on('custom:mode-change', (data, client) => {
          server.ws.clients.forEach((c) => {
            if (c !== client) {
              c.send('custom:mode-change', data);
            }
          });
        });
      }
    }
  ],

  // Allow LAN access (e.g., smartphones) only when explicitly enabled.
  server: {
    host: process.env.VITE_LAN === 'true',
  },
})
