import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: OutgoingMail): Promise<void>;
}

/**
 * Prints the message - including the action link - to the log instead of
 * sending real email. Selected whenever MAIL_TRANSPORT=console, including in
 * production if no SMTP provider is configured yet: verification and
 * password-reset links then only reach whoever can read the deploy's logs
 * (e.g. the Render dashboard), not the account holder's actual inbox - fine
 * for a single operator's own accounts, not for real end users signing
 * themselves up. Switch to MAIL_TRANSPORT=smtp before that matters.
 */
class ConsoleMailer implements Mailer {
  async send(message: OutgoingMail): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        '--------------------------------------------------------------',
        ' MineDesk mail (console transport - not actually delivered)',
        `  to:      ${message.to}`,
        `  subject: ${message.subject}`,
        '--------------------------------------------------------------',
        message.text,
        '--------------------------------------------------------------',
        '',
      ].join('\n'),
    );
  }
}

class SmtpMailer implements Mailer {
  private readonly transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
  }

  async send(message: OutgoingMail): Promise<void> {
    await this.transporter.sendMail({
      from: env.MAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

function createMailer(): Mailer {
  if (env.MAIL_TRANSPORT === 'smtp') {
    if (!env.SMTP_HOST) throw new Error('MAIL_TRANSPORT=smtp requires SMTP_HOST');
    return new SmtpMailer();
  }
  return new ConsoleMailer();
}

export const mailer: Mailer = createMailer();

// --------------------------------------------------------------------------
// Message templates. Links point at the web app, which forwards the token to
// the API - the token is never embedded in a page that a third party can read.
// --------------------------------------------------------------------------

const webBase = env.webOrigins[0] ?? 'http://localhost:5173';

export function verificationEmail(name: string, token: string): OutgoingMail {
  const link = `${webBase}/verify-email?token=${encodeURIComponent(token)}`;
  return {
    to: '',
    subject: 'Verify your MineDesk email address',
    text: [
      `Hi ${name},`,
      '',
      'Confirm this email address to finish setting up your MineDesk account:',
      link,
      '',
      'The link is valid for 24 hours and can be used once.',
      'If you did not create a MineDesk account, you can ignore this message.',
    ].join('\n'),
  };
}

export function passwordResetEmail(name: string, token: string): OutgoingMail {
  const link = `${webBase}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    to: '',
    subject: 'Reset your MineDesk password',
    text: [
      `Hi ${name},`,
      '',
      'Use this link to choose a new password:',
      link,
      '',
      'The link is valid for 60 minutes and can be used once.',
      'If you did not request a password reset, no action is needed - your',
      'current password still works, and signing in will invalidate this link.',
    ].join('\n'),
  };
}

export function newSignInEmail(name: string, ip: string, userAgent: string | null): OutgoingMail {
  return {
    to: '',
    subject: 'New sign-in to your MineDesk account',
    text: [
      `Hi ${name},`,
      '',
      'Your MineDesk account was just signed in to.',
      `  IP address: ${ip}`,
      `  Browser:    ${userAgent ?? 'unknown'}`,
      '',
      'If this was not you, change your password and revoke the session from',
      `${webBase}/security straight away.`,
    ].join('\n'),
  };
}
