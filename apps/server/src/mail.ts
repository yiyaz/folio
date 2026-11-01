import nodemailer from 'nodemailer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(m: Mail): Promise<void>;
}

export function createMailer(cfg: Config, log: { info: (o: object, m?: string) => void }): Mailer {
  const t = cfg.MAIL_TRANSPORT;
  if (t === 'log') {
    return { send: async (m) => log.info({ mail: { to: m.to, subject: m.subject, text: m.text } }, 'mail (log transport)') };
  }
  if (t.startsWith('file:')) {
    const dir = t.slice(5);
    return {
      send: async (m) => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify(m));
      },
    };
  }
  const transport = nodemailer.createTransport(t);
  return {
    send: async (m) => {
      await transport.sendMail({ from: cfg.MAIL_FROM, ...m });
    },
  };
}
