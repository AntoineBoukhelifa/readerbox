import { describe, expect, it } from 'vitest';
import { createTestDb } from '../db/testing';
import { createInvitation, redeemInvitation } from './invitations';
import {
	RECONNEXION_TTL_MS,
	consommerUneReconnexion,
	emettreUneReconnexion,
	etatDeReconnexion
} from './reconnexion';
import { markMemberAsLeft, createSession, resolveSession } from './sessions';
import { generateToken } from './tokens';

const T0 = 1_700_000_000_000;

async function membre(db: ReturnType<typeof createTestDb>, nom = 'Antoine') {
	const emise = await createInvitation(db, { createdBy: null, now: T0 });
	if (!emise.ok) throw new Error('la porte fondatrice devrait toujours s ouvrir');
	const entre = await redeemInvitation(db, emise.token, nom, T0);
	if (!entre.ok) throw new Error('invitation refusée à tort');
	return entre.memberId;
}

describe("état d'un lien de reconnexion", () => {
	const base = {
		id: 'r1',
		tokenHash: 'h',
		memberId: 'm1',
		createdAt: T0,
		expiresAt: T0 + 1000,
		consumedAt: null,
		revokedAt: null
	};

	it('est valide avant son échéance', () => {
		expect(etatDeReconnexion(base, T0)).toBe('valide');
	});

	it('expire à l échéance exacte', () => {
		expect(etatDeReconnexion(base, T0 + 1000)).toBe('expiré');
	});

	it('rapporte la consommation même si une révocation a suivi', () => {
		expect(etatDeReconnexion({ ...base, consumedAt: T0 + 1, revokedAt: T0 + 2 }, T0 + 3)).toBe(
			'consommé'
		);
	});
});

describe('reconnexion sur un autre appareil', () => {
	it('rend une session au MÊME membre, sans en créer un second', async () => {
		const db = createTestDb();
		const moi = await membre(db);

		const emis = await emettreUneReconnexion(db, moi, { now: T0 });
		if (!emis.ok) throw new Error('émission refusée à tort');
		const repris = await consommerUneReconnexion(db, emis.token, T0 + 1);

		expect(repris).toEqual({ ok: true, membreId: moi });

		// Le point de tout l'exercice : aucun jumeau au journal vide.
		const tous = await db.query.members.findMany();
		expect(tous).toHaveLength(1);
	});

	it('la session obtenue est bien celle du membre', async () => {
		const db = createTestDb();
		const moi = await membre(db, 'Antoine');
		const emis = await emettreUneReconnexion(db, moi, { now: T0 });
		if (!emis.ok) throw new Error('émission refusée à tort');
		const repris = await consommerUneReconnexion(db, emis.token, T0 + 1);
		if (!repris.ok) throw new Error('reconnexion refusée à tort');

		const jeton = await createSession(db, repris.membreId, { now: T0 + 1 });
		const vu = await resolveSession(db, jeton, T0 + 2);

		expect(vu?.id).toBe(moi);
		expect(vu?.displayName).toBe('Antoine');
	});

	it('ne sert qu une fois', async () => {
		const db = createTestDb();
		const moi = await membre(db);
		const emis = await emettreUneReconnexion(db, moi, { now: T0 });
		if (!emis.ok) throw new Error('émission refusée à tort');

		await consommerUneReconnexion(db, emis.token, T0 + 1);
		const second = await consommerUneReconnexion(db, emis.token, T0 + 2);

		expect(second).toEqual({ ok: false, motif: 'consommé' });
	});

	it('expire au bout d une heure, bien plus vite qu une invitation', async () => {
		const db = createTestDb();
		const moi = await membre(db);
		const emis = await emettreUneReconnexion(db, moi, { now: T0 });
		if (!emis.ok) throw new Error('émission refusée à tort');

		const tard = await consommerUneReconnexion(db, emis.token, T0 + RECONNEXION_TTL_MS + 1);

		expect(tard).toEqual({ ok: false, motif: 'expiré' });
	});

	it('émettre un lien neuf révoque le précédent, resté en vol', async () => {
		const db = createTestDb();
		const moi = await membre(db);
		const premier = await emettreUneReconnexion(db, moi, { now: T0 });
		if (!premier.ok) throw new Error('émission refusée à tort');

		const second = await emettreUneReconnexion(db, moi, { now: T0 + 10 });
		if (!second.ok) throw new Error('émission refusée à tort');

		expect(await consommerUneReconnexion(db, premier.token, T0 + 20)).toEqual({
			ok: false,
			motif: 'révoqué'
		});
		expect((await consommerUneReconnexion(db, second.token, T0 + 20)).ok).toBe(true);
	});

	it('un jeton inconnu est refusé', async () => {
		const db = createTestDb();
		await membre(db);

		expect(await consommerUneReconnexion(db, generateToken(), T0)).toEqual({
			ok: false,
			motif: 'introuvable'
		});
	});

	it('R38 — un membre parti ne peut plus émettre', async () => {
		const db = createTestDb();
		const moi = await membre(db);
		await markMemberAsLeft(db, moi, T0 + 1);

		expect(await emettreUneReconnexion(db, moi, { now: T0 + 2 })).toEqual({
			ok: false,
			motif: 'membre parti'
		});
	});

	it('R38 — un lien émis avant le départ ne rouvre pas la porte', async () => {
		const db = createTestDb();
		const moi = await membre(db);
		const emis = await emettreUneReconnexion(db, moi, { now: T0 });
		if (!emis.ok) throw new Error('émission refusée à tort');

		// Le départ survient entre l'émission et l'usage : c'est le cas que la
		// double vérification existe pour attraper.
		await markMemberAsLeft(db, moi, T0 + 1);

		expect(await consommerUneReconnexion(db, emis.token, T0 + 2)).toEqual({
			ok: false,
			motif: 'membre parti'
		});
	});

	it('ne touche pas aux liens des autres membres', async () => {
		const db = createTestDb();
		const moi = await membre(db, 'Antoine');
		const emise = await createInvitation(db, { createdBy: moi, now: T0 });
		if (!emise.ok) throw new Error('émission refusée à tort');
		const autre = await redeemInvitation(db, emise.token, 'Camille', T0 + 1);
		if (!autre.ok) throw new Error('invitation refusée à tort');

		const sien = await emettreUneReconnexion(db, autre.memberId, { now: T0 + 2 });
		if (!sien.ok) throw new Error('émission refusée à tort');
		await emettreUneReconnexion(db, moi, { now: T0 + 3 });

		// Émettre pour soi ne révoque que ses propres liens.
		expect((await consommerUneReconnexion(db, sien.token, T0 + 4)).ok).toBe(true);
	});
});
