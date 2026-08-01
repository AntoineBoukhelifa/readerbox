import { and, eq, isNull } from 'drizzle-orm';
import { members, sessions, type Member, type Session } from '../db/schema';
import { generateToken, hashToken } from './tokens';
import type { Db } from '../db';

/** Durée de vie d'une session : trente jours. Un groupe d'amis ne se reconnecte pas tous les jours. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'rb_session';

export type SessionState = 'valide' | 'révoquée' | 'expirée';

/** État d'une session à un instant donné. Fonction pure. */
export function sessionState(session: Session, now: number): SessionState {
	if (session.revokedAt !== null) return 'révoquée';
	if (session.expiresAt <= now) return 'expirée';
	return 'valide';
}

/** Ouvre une session pour un membre. Retourne le jeton en clair, une seule fois. */
export async function createSession(
	db: Db,
	memberId: string,
	options: { ttlMs?: number; now?: number } = {}
): Promise<string> {
	const now = options.now ?? Date.now();
	const token = generateToken();

	await db.insert(sessions).values({
		tokenHash: await hashToken(token),
		memberId,
		createdAt: now,
		expiresAt: now + (options.ttlMs ?? SESSION_TTL_MS)
	});

	return token;
}

/**
 * Résout un jeton de session en membre.
 *
 * Deux conditions, pas une : la session doit être valide, et le membre ne doit
 * pas avoir quitté le groupe. Un membre parti dont la session n'aurait pas été
 * coupée est refusé quand même — la double vérification évite qu'un oubli
 * ailleurs ouvre une porte.
 */
export async function resolveSession(
	db: Db,
	token: string | undefined,
	now = Date.now()
): Promise<Member | null> {
	if (!token) return null;

	const session = await db.query.sessions.findFirst({
		where: eq(sessions.tokenHash, await hashToken(token))
	});
	if (!session || sessionState(session, now) !== 'valide') return null;

	const member = await db.query.members.findFirst({ where: eq(members.id, session.memberId) });
	if (!member || member.leftAt !== null) return null;

	return member;
}

/** Ferme une session précise — la déconnexion ordinaire. */
export async function revokeSession(db: Db, token: string, now = Date.now()): Promise<void> {
	await db
		.update(sessions)
		.set({ revokedAt: now })
		.where(eq(sessions.tokenHash, await hashToken(token)));
}

/**
 * Coupe toutes les sessions actives d'un membre.
 *
 * C'est ce que R38 exige au départ d'un membre : l'accès s'arrête tout de
 * suite, pas à l'expiration naturelle du jeton.
 */
export async function revokeAllSessionsForMember(
	db: Db,
	memberId: string,
	now = Date.now()
): Promise<void> {
	await db
		.update(sessions)
		.set({ revokedAt: now })
		.where(and(eq(sessions.memberId, memberId), isNull(sessions.revokedAt)));
}

/**
 * Fait quitter le groupe à un membre (R38).
 *
 * Une seule écriture, et tout le reste en découle — c'est ce qui rend le départ
 * fiable plutôt que dépendant d'une liste de gestes qu'on pourrait raccourcir :
 *
 * - **l'accès s'arrête tout de suite.** Les sessions actives sont révoquées ici,
 *   et `resolveSession` refuse en plus tout membre marqué parti : deux verrous
 *   pour que l'oubli de l'un ne rouvre rien ;
 * - **il ne peut plus inviter.** `createInvitation` lit `leftAt` de son côté, au
 *   lieu de s'en remettre à l'absence de session ;
 * - **ses avis et ses notes restent** (R38) et sont anonymisés à l'affichage :
 *   la page d'œuvre, la page de profil, les ordres et le fil lisent tous `leftAt`
 *   et cessent de le nommer. Le fil va plus loin et ne charge même pas le nom ;
 * - **ses ordres restent en place**, marqués sans auteur et toujours suivables
 *   — `ordreModifiable` refuse seulement qu'on les modifie encore.
 *
 * **Ce que cette fonction ne fait pas, et pourquoi.** Elle n'efface ni le nom
 * d'affichage ni la ligne du membre. La ligne porte l'autorité de ses ordres et
 * la clé étrangère de ses consignations ; l'effacer ferait disparaître des ordres
 * que d'autres suivent, ce que R38 refuse explicitement. L'anonymat est donc une
 * propriété de la **lecture**, appliquée partout, et non une destruction. La
 * suppression complète de compte, l'export des données, la durée de conservation
 * et la base légale sont un travail à part, délibérément hors de U8.
 */
export async function markMemberAsLeft(db: Db, memberId: string, now = Date.now()): Promise<void> {
	await db.update(members).set({ leftAt: now }).where(eq(members.id, memberId));
	await revokeAllSessionsForMember(db, memberId, now);
}
