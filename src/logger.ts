import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Render's log stream is plain text; JSON stays greppable, which matters for
  // finding unknown-status warnings during a demo.
  base: { service: 'revenue-metrics' },
  redact: {
    paths: ['req.headers.authorization', 'DATABASE_URL', 'STRIPE_SECRET_KEY'],
    remove: true,
  },
});

export type Logger = typeof logger;
