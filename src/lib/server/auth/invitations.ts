import { eq } from 'drizzle-orm';
import { invitations, members, type Invitation } from '../db/schema';
import { generateToken, hashToken } from './tokens';
import type { Db } from '../db';

/** Durée de vie par défaut d'une invitation : sept jours. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationState = 'valide' | 'consommée' | 'révoquée' | 'expirée';

/**
 * État d'une invitation à un instant donné. Fonction pure — c'est elle qui
 * porte la règle, et c'est elle qu'on teste.
 *
 * L'ordre compte : une invitation révoquée après avoir été consommée est
 * rapportée comme consommée, parce que c'est le fait qui s'est produit en
 * premier et qui a réellement produit un membre.
 */
export function invitationState(invitation: Invitation, now: number): InvitationState {
	if (invitation.consumedAt !== null) return 'consommée';
	if (invitation.revokedAt !== null) return 'révoquée';
	if (invitation.expiresAt <= now) return 'expirée';
	return 'valide';
}

export type ResultatEmission =
	| { ok: true; token: string; invitationId: string }
	/** R38 — un membre qui a quitté le groupe ne fait plus entrer personne. */
	| { ok: false; motif: 'membre parti' };

/**
 * Émet une invitation. Tout membre présent peut le faire — il n'y a pas de rôle
 * d'administration dans ce produit.
 *
 * `createdBy` vaut null pour l'invitation fondatrice, celle qui fait entrer le
 * premier membre.
 *
 * **R38 est vérifié ici, et pas seulement par la session.** Un membre parti n'a
 * plus de session valide — `resolveSession` le refuse deux fois — donc en
 * pratique il n'atteint jamais cette fonction. Mais faire dépendre une règle du
 * produit de l'expiration d'un jeton, c'est la faire dépendre d'autre chose
 * qu'elle-même : le jour où une invitation s'émet depuis un autre chemin — une
 * tâche planifiée, un endpoint d'API — la règle tiendrait toujours. C'est le
 * même parti pris que `ordreModifiable` dans les ordres.
 *
 * Retourne le jeton en clair : c'est la seule et unique fois où il est
 * disponible. Il n'est plus jamais récupérable ensuite.
 */
export async function createInvitation(
	db: Db,
	options: { createdBy?: string | null; ttlMs?: number; now?: number } = {}
): Promise<ResultatEmission> {
	const now = options.now ?? Date.now();

	if (options.createdBy) {
		const emetteur = await db.query.members.findFirst({
			where: eq(members.id, options.createdBy)
		});
		if (!emetteur || emetteur.leftAt !== null) return { ok: false, motif: 'membre parti' };
	}

	const token = generateToken();

	const [row] = await db
		.insert(invitations)
		.values({
			tokenHash: await hashToken(token),
			createdBy: options.createdBy ?? null,
			createdAt: now,
			expiresAt: now + (options.ttlMs ?? INVITATION_TTL_MS)
		})
		.returning({ id: invitations.id });

	return { ok: true, token, invitationId: row.id };
}

/**
 * Révoque une invitation non encore consommée.
 *
 * C'est le seul rattrapage possible quand un lien fuite avant usage, et
 * l'invitation est la seule frontière d'accès du produit. Une invitation déjà
 * consommée ne se révoque pas : le membre existe, c'est sa session qu'il faut
 * couper.
 */
export async function revokeInvitation(
	db: Db,
	invitationId: string,
	now = Date.now()
): Promise<'révoquée' | 'introuvable' | 'déjà consommée'> {
	const invitation = await db.query.invitations.findFirst({
		where: eq(invitations.id, invitationId)
	});
	if (!invitation) return 'introuvable';
	if (invitation.consumedAt !== null) return 'déjà consommée';

	await db.update(invitations).set({ revokedAt: now }).where(eq(invitations.id, invitationId));
	return 'révoquée';
}

export type RedeemResult =
	{ ok: true; memberId: string } | { ok: false; reason: 'introuvable' | InvitationState };

/**
 * Consomme une invitation et crée le membre correspondant.
 *
 * L'invitation est marquée consommée dans le même mouvement, ce qui garantit
 * l'usage unique : une seconde tentative avec le même lien trouvera un
 * `consumedAt` non nul et sera refusée.
 */
export async function redeemInvitation(
	db: Db,
	token: string,
	displayName: string,
	now = Date.now()
): Promise<RedeemResult> {
	const invitation = await db.query.invitations.findFirst({
		where: eq(invitations.tokenHash, await hashToken(token))
	});
	if (!invitation) return { ok: false, reason: 'introuvable' };

	const state = invitationState(invitation, now);
	if (state !== 'valide') return { ok: false, reason: state };

	const [member] = await db
		.insert(members)
		.values({ displayName, createdAt: now })
		.returning({ id: members.id });

	await db
		.update(invitations)
		.set({ consumedAt: now, consumedBy: member.id })
		.where(eq(invitations.id, invitation.id));

	return { ok: true, memberId: member.id };
}
