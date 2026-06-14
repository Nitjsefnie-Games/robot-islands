import type { FastifyReply } from 'fastify';

export const SESSION_COOKIE = 'ri_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface CookieOpts { readonly secure: boolean; }

export function setSessionCookie(reply: FastifyReply, token: string, opts: CookieOpts): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, opts: CookieOpts): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: opts.secure, sameSite: 'lax', path: '/' });
}
