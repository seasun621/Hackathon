import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // GitHub Pages serves this repository from /Hackathon/.
  // Keep the local development server available at http://127.0.0.1:43127/.
  base: command === 'build' ? '/Hackathon/' : '/',
}));
