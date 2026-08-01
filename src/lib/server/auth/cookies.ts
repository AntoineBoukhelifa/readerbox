import type { Cookies } from '@sveltejs/kit';
import { SESSION_COOKIE, SESSION_TTL_MS } from './sessions';

/**
 * Options du cookie de session.
 *
 * `httpOnly` est ce qui compte le plus : le jeton n'est jamais lisible par du
 * JavaScript, donc une faille d'injection dans une page ne le donne pas.
 * `sameSite: lax` laisse passer la navigation depuis un lien d'invitation
 * envoyé par message, ce que `strict` bloquerait.
 */
const BASE = {
	path: '/',
	httpOnly: true,
	sameSite: 'lax',
	secure: true
} as const;

export function poserCookieDeSession(cookies: Cookies, token: string): void {
	cookies.set(SESSION_COOKIE, token, { ...BASE, maxAge: Math.floor(SESSION_TTL_MS / 1000) });
}

export function retirerCookieDeSession(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, BASE);
}
