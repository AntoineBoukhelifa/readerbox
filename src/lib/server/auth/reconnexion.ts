import { and, eq, isNull } from 'drizzle-orm';
import { members, reconnections, type Reconnection } from '../db/schema';
import { generateToken, hashToken } from './tokens';
import type { Db } from '../db';

/**
 * Ouvrir une session sur un autre appareil, sans se dédoubler dans le groupe.
 *
 * L'invitation est la seule porte d'entrée du produit et elle ne sert qu'une
 * fois : elle crée un membre puis se consomme. Un membre qui change de
 * navigateur ou prend un second appareil n'avait donc aucun recours — une
 * nouvelle invitation lui aurait fabriqué un jumeau au journal vide.
 *
 * Ce jeton-ci porte l'identité d'un membre **existant** et n'en crée jamais.
 */

/**
 * Une heure, contre une semaine pour une invitation.
 *
 * Le risque n'est pas le même : une invitation donne accès à un compte qui
 * n'existe pas encore, celui-ci donne accès à un compte vivant, avec son
 * journal, ses avis et sa capacité à inviter. On ne le laisse pas traîner.
 */
export const RECONNEXION_TTL_MS = 60 * 60 * 1000;

export type EtatReconnexion = 'valide' | 'consommé' | 'révoqué' | 'expiré';

/** L'état d'un lien à un instant donné. Fonction pure — c'est elle qui porte la règle. */
export function etatDeReconnexion(lien: Reconnection, maintenant: number): EtatReconnexion {
	if (lien.consumedAt !== null) return 'consommé';
	if (lien.revokedAt !== null) return 'révoqué';
	if (lien.expiresAt <= maintenant) return 'expiré';
	return 'valide';
}

/**
 * Émet un lien pour soi-même, et pour soi seulement.
 *
 * L'appelant passe l'identité tirée de sa propre session : il n'y a aucun
 * paramètre par lequel demander un lien pour quelqu'un d'autre. C'est le même
 * parti pris que le reste du journal — ce qui n'est pas exprimable ne se forge
 * pas.
 *
 * Les liens encore en vol du même membre sont révoqués au passage : en émettre
 * un neuf est le geste de quelqu'un qui a perdu le précédent, et laisser
 * s'accumuler des porteurs de créance valides serait gratuit.
 */
export async function emettreUneReconnexion(
	db: Db,
	membreId: string,
	options: { ttlMs?: number; now?: number } = {}
): Promise<{ ok: true; token: string; lienId: string } | { ok: false; motif: 'membre parti' }> {
	const maintenant = options.now ?? Date.now();

	const membre = await db.query.members.findFirst({ where: eq(members.id, membreId) });
	if (!membre || membre.leftAt !== null) return { ok: false, motif: 'membre parti' };

	await db
		.update(reconnections)
		.set({ revokedAt: maintenant })
		.where(
			and(
				eq(reconnections.memberId, membreId),
				isNull(reconnections.consumedAt),
				isNull(reconnections.revokedAt)
			)
		);

	const token = generateToken();
	const [ligne] = await db
		.insert(reconnections)
		.values({
			tokenHash: await hashToken(token),
			memberId: membreId,
			createdAt: maintenant,
			expiresAt: maintenant + (options.ttlMs ?? RECONNEXION_TTL_MS)
		})
		.returning({ id: reconnections.id });

	return { ok: true, token, lienId: ligne.id };
}

export type ResultatReconnexion =
	| { ok: true; membreId: string }
	| { ok: false; motif: 'introuvable' | 'membre parti' | EtatReconnexion };

/**
 * Consomme un lien et rend l'identité du membre à reconnecter.
 *
 * Le membre est revérifié au moment de la consommation et pas seulement à
 * l'émission : un départ du groupe survenu entre les deux doit fermer la porte,
 * conformément à R38. C'est la même double vérification que `resolveSession`,
 * pour la même raison — une règle du produit ne doit pas dépendre de
 * l'expiration d'un jeton.
 */
export async function consommerUneReconnexion(
	db: Db,
	token: string,
	maintenant = Date.now()
): Promise<ResultatReconnexion> {
	const lien = await db.query.reconnections.findFirst({
		where: eq(reconnections.tokenHash, await hashToken(token))
	});
	if (!lien) return { ok: false, motif: 'introuvable' };

	const etat = etatDeReconnexion(lien, maintenant);
	if (etat !== 'valide') return { ok: false, motif: etat };

	const membre = await db.query.members.findFirst({ where: eq(members.id, lien.memberId) });
	if (!membre || membre.leftAt !== null) return { ok: false, motif: 'membre parti' };

	await db
		.update(reconnections)
		.set({ consumedAt: maintenant })
		.where(eq(reconnections.id, lien.id));

	return { ok: true, membreId: membre.id };
}
