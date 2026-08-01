import { describe, expect, it } from 'vitest';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import { ingererOeuvre } from '../catalog/ingest';
import { T0, membre, oeuvreDistante } from '../catalog/testing';
import { abandonner, consigner, reprendre, retirer } from './entries';
import {
	franchissementEnAttente,
	franchissementsEnAttente,
	marquerFranchissementsTraites,
	signalerFranchissement
} from './frontiere';

async function oeuvre(db: Db, idExterne: string): Promise<string> {
	const { oeuvreId } = await ingererOeuvre(db, oeuvreDistante('metron', idExterne), { now: T0 });
	return oeuvreId;
}

describe('point d appel unique', () => {
	it('enfile un franchissement lisible par U9', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');

		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });

		expect(await franchissementsEnAttente(db)).toEqual([
			expect.objectContaining({
				memberId: membreId,
				workId: oeuvreId,
				direction: 'atteinte',
				processedAt: null
			})
		]);
	});

	it('n enfile rien tant que la frontière n est pas franchie', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');

		await consigner(db, { membreId, oeuvreId, etagere: 'a_decouvrir', now: T0 });
		await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 + 1 });

		expect(await franchissementsEnAttente(db)).toEqual([]);
	});

	it('ne garde qu une demande par couple, portant le dernier sens franchi', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');

		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });
		await reprendre(db, { membreId, oeuvreId, now: T0 + 1 });

		const enAttente = await franchissementsEnAttente(db);
		expect(enAttente).toHaveLength(1);
		expect(enAttente[0].direction).toBe('perte');
	});

	it('sépare les membres : atteindre une œuvre ne concerne que celui qui l atteint', async () => {
		const db = createTestDb();
		const antoine = await membre(db, 'Antoine');
		const camille = await membre(db, 'Camille');
		const oeuvreId = await oeuvre(db, '1');

		await consigner(db, { membreId: antoine, oeuvreId, etagere: 'termine', now: T0 });

		expect(await franchissementEnAttente(db, antoine, oeuvreId)).toMatchObject({
			direction: 'atteinte'
		});
		expect(await franchissementEnAttente(db, camille, oeuvreId)).toBe(null);
	});

	it('deux membres qui atteignent la même œuvre produisent deux demandes', async () => {
		const db = createTestDb();
		const antoine = await membre(db, 'Antoine');
		const camille = await membre(db, 'Camille');
		const oeuvreId = await oeuvre(db, '1');

		await consigner(db, { membreId: antoine, oeuvreId, etagere: 'termine', now: T0 });
		await consigner(db, { membreId: camille, oeuvreId, etagere: 'termine', now: T0 + 1 });

		expect(await franchissementsEnAttente(db)).toHaveLength(2);
	});

	it('une demande traitée sort de la file, et une nouvelle peut être enfilée', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });

		const [demande] = await franchissementsEnAttente(db);
		await marquerFranchissementsTraites(db, [demande.id], T0 + 1);

		expect(await franchissementsEnAttente(db)).toEqual([]);
		expect(await franchissementEnAttente(db, membreId, oeuvreId)).toBe(null);

		await retirer(db, { membreId, oeuvreId, now: T0 + 2 });
		expect(await franchissementsEnAttente(db)).toEqual([
			expect.objectContaining({ direction: 'perte' })
		]);
	});

	it('l abandon et la reprise passent par le même point d appel', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 });

		await abandonner(db, { membreId, oeuvreId, now: T0 + 1 });
		expect(await franchissementEnAttente(db, membreId, oeuvreId)).toMatchObject({
			direction: 'atteinte'
		});

		const [demande] = await franchissementsEnAttente(db);
		await marquerFranchissementsTraites(db, [demande.id], T0 + 2);

		await reprendre(db, { membreId, oeuvreId, now: T0 + 3 });
		expect(await franchissementEnAttente(db, membreId, oeuvreId)).toMatchObject({
			direction: 'perte'
		});
	});

	it('rend les demandes les plus anciennes d abord', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await oeuvre(db, '1');
		const deux = await oeuvre(db, '2');

		await signalerFranchissement(db, { membreId, oeuvreId: deux, sens: 'atteinte' }, T0 + 10);
		await signalerFranchissement(db, { membreId, oeuvreId: un, sens: 'atteinte' }, T0 + 1);

		expect((await franchissementsEnAttente(db)).map((d) => d.workId)).toEqual([un, deux]);
	});

	it('marquer une liste vide ne fait rien', async () => {
		const db = createTestDb();
		await marquerFranchissementsTraites(db, []);
		expect(await franchissementsEnAttente(db)).toEqual([]);
	});
});
