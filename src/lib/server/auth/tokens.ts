/**
 * Jetons opaques pour les invitations et les sessions.
 *
 * Le principe tient en une phrase : le jeton brut ne quitte jamais la mémoire
 * autrement que vers son porteur, et la base ne conserve que son empreinte.
 * Quiconque lit la base ne peut donc forger aucun lien ni aucune session.
 */

const TOKEN_BYTES = 32;

/** Alphabet base64url — sûr en URL et en cookie, sans caractère à échapper. */
function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Génère un jeton de 32 octets d'entropie. C'est ce qui part dans le lien
 * d'invitation ou dans le cookie de session, et rien d'autre.
 */
export function generateToken(): string {
	const bytes = new Uint8Array(TOKEN_BYTES);
	crypto.getRandomValues(bytes);
	return toBase64Url(bytes);
}

/**
 * Empreinte SHA-256 d'un jeton, en hexadécimal.
 *
 * Pas de sel et pas de dérivation lente ici, contrairement à un mot de passe :
 * un jeton de 32 octets aléatoires n'est pas devinable par force brute, donc
 * ralentir le calcul ne protégerait de rien et coûterait à chaque requête.
 */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Comparaison à temps constant, pour ne pas laisser fuir d'information par la
 * durée du test. Utile partout où l'on compare une empreinte fournie par un
 * appelant à une empreinte connue.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
