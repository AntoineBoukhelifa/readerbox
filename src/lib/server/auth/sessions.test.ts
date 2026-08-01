import { describe, expect, it } from 'vitest';
import { createTestDb } from '../db/testing';
import { createInvitation, redeemInvitation } from './invitations';
import {
	SESSION_TTL_MS,
	createSession,
	markMemberAsLeft,
	resolveSession,
	revokeAllSessionsForMember,
	revokeSession,
	sessionState
} from './sessions';
import { generateToken } from './tokens';

const T0 = 1_700_000_000_000;

/** Émet une invitation dont on attend qu'elle aboutisse (R38 rend l'émission refusable). */
async function emettre(
	db: ReturnType<typeof createTestDb>,
	options: { createdBy?: string | null; now?: number } = {}
) {
	const resultat = await createInvitation(db, options);
	if (!resultat.ok) throw new Error(`émission refusée : ${resultat.motif}`);
	return resultat;
}

async function memberWithSession(db: ReturnType<typeof createTestDb>, name = 'Antoine') {
	const { token: invite } = await emettre(db, { createdBy: null, now: T0 });
	const redeemed = await redeemInvitation(db, invite, name, T0);
	if (!redeemed.ok) throw new Error('la porte fondatrice devrait toujours s ouvrir');
	const session = await createSession(db, redeemed.memberId, { now: T0 });
	return { memberId: redeemed.memberId, session };
}

describe("état d'une session", () => {
	const base = {
		id: 's1',
		tokenHash: 'h',
		memberId: 'm1',
		createdAt: T0,
		expiresAt: T0 + 1000,
		revokedAt: null
	};

	it('est valide avant son échéance', () => {
		expect(sessionState(base, T0)).toBe('valide');
	});

	it('expire à l échéance exacte', () => {
		expect(sessionState(base, T0 + 1000)).toBe('expirée');
	});

	it('la révocation prime sur tout le reste', () => {
		expect(sessionState({ ...base, revokedAt: T0 + 1 }, T0 + 2)).toBe('révoquée');
	});
});

describe('résolution de session', () => {
	it('un jeton valide rend le membre', async () => {
		const db = createTestDb();
		const { memberId, session } = await memberWithSession(db);

		const member = await resolveSession(db, session, T0 + 1);

		expect(member?.id).toBe(memberId);
	});

	it('aucun jeton ne rend personne', async () => {
		const db = createTestDb();
		await memberWithSession(db);

		expect(await resolveSession(db, undefined, T0 + 1)).toBeNull();
	});

	it('un jeton inconnu ne rend personne', async () => {
		const db = createTestDb();
		await memberWithSession(db);

		expect(await resolveSession(db, generateToken(), T0 + 1)).toBeNull();
	});

	it('un jeton expiré ne rend personne', async () => {
		const db = createTestDb();
		const { session } = await memberWithSession(db);

		expect(await resolveSession(db, session, T0 + SESSION_TTL_MS + 1)).toBeNull();
	});

	it('une session fermée ne rend plus personne', async () => {
		const db = createTestDb();
		const { session } = await memberWithSession(db);

		await revokeSession(db, session, T0 + 1);

		expect(await resolveSession(db, session, T0 + 2)).toBeNull();
	});
});

describe('départ du groupe', () => {
	it('coupe immédiatement toutes les sessions actives, sans attendre leur expiration', async () => {
		const db = createTestDb();
		const { memberId, session } = await memberWithSession(db);
		const secondAppareil = await createSession(db, memberId, { now: T0 });

		await markMemberAsLeft(db, memberId, T0 + 1);

		expect(await resolveSession(db, session, T0 + 2)).toBeNull();
		expect(await resolveSession(db, secondAppareil, T0 + 2)).toBeNull();
	});

	it('refuse un membre parti même si une session lui avait échappé', async () => {
		const db = createTestDb();
		const { memberId } = await memberWithSession(db);

		// Le départ est enregistré, mais une session est ouverte après coup —
		// le cas d'un oubli ailleurs dans le code. La double vérification tient.
		await markMemberAsLeft(db, memberId, T0 + 1);
		const rescapee = await createSession(db, memberId, { now: T0 + 2 });

		expect(await resolveSession(db, rescapee, T0 + 3)).toBeNull();
	});

	it('ne touche pas aux sessions des autres membres', async () => {
		const db = createTestDb();
		const partant = await memberWithSession(db, 'Antoine');
		const { token: invite } = await emettre(db, {
			createdBy: partant.memberId,
			now: T0
		});
		const redeemed = await redeemInvitation(db, invite, 'Camille', T0 + 1);
		if (!redeemed.ok) throw new Error('invitation refusée à tort');
		const restante = await createSession(db, redeemed.memberId, { now: T0 + 1 });

		await revokeAllSessionsForMember(db, partant.memberId, T0 + 2);

		expect(await resolveSession(db, partant.session, T0 + 3)).toBeNull();
		expect((await resolveSession(db, restante, T0 + 3))?.id).toBe(redeemed.memberId);
	});
});
