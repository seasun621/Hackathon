import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

function localPerformanceLogger(): Plugin {
  return {
    name: 'local-performance-logger',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__perf-log', (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 1_000_000) request.destroy();
        });
        request.on('end', () => {
          void (async () => {
            try {
              const record = JSON.parse(body) as { sessionId?: unknown };
              if (typeof record.sessionId !== 'string' || record.sessionId.length < 8) {
                throw new Error('Invalid performance log session.');
              }
              const safeSessionId = record.sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
              const logDirectory = resolve(process.cwd(), 'performance-logs');
              const logPath = resolve(logDirectory, `performance-${safeSessionId}.jsonl`);
              await mkdir(logDirectory, { recursive: true });
              await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
              response.statusCode = 204;
              response.end();
            } catch (error) {
              response.statusCode = 400;
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid log record.' }));
            }
          })();
        });
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  // GitHub Pages serves this repository from /Hackathon/.
  // Keep the local development server available at http://127.0.0.1:43127/.
  base: command === 'build' ? '/Hackathon/' : '/',
  plugins: [localPerformanceLogger()],
}));
