import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../db/testing';
import { works } from '../db/schema';
import { ingererOeuvre } from './ingest';
import { lireOeuvre, corriger } from './corrections';
import {
	doublonsDouteux,
	fusionnerManuellement,
	rapprocher,
	verdictDeRapprochement,
	type SignatureOeuvre
} from './reconcile';
import { estEnAttente } from './rematerialisation';
import { T0, entite, membre, oeuvreDistante, reference } from './testing';

const numero = (champs: Partial<SignatureOeuvre> = {}): SignatureOeuvre => ({
	type: 'numero',
	serieEntityId: 's-1',
	numeroDansLaSerie: 142,
	dateDeParution: '1981-02-01',
	...champs
});

describe('verdict de rapprochement', () => {
	it('rapproche deux descriptions du même numéro dont les dates se recoupent', () => {
		// Metron date en couverture, Comic Vine en mise en vente : deux mois d'écart
		// sur le même numéro est la norme, pas l'exception.
		expect(verdictDeRapprochement(numero(), numero({ dateDeParution: '1980-12-01' }))).toBe(
			'identique'
		);
	});

	it('ne rapproche pas deux numéros de même rang à des dates éloignées', () => {
		expect(verdictDeRapprochement(numero(), numero({ dateDeParution: '1991-02-01' }))).toBe(
			'distinct'
		);
	});

	it('refuse de trancher quand une date manque, au lieu de supposer', () => {
		expect(verdictDeRapprochement(numero(), numero({ dateDeParution: null }))).toBe('douteux');
	});

	it('ne rapproche jamais deux séries différentes', () => {
		expect(verdictDeRapprochement(numero(), numero({ serieEntityId: 's-2' }))).toBe('distinct');
	});

	it('ne rapproche jamais deux rangs différents', () => {
		expect(verdictDeRapprochement(numero(), numero({ numeroDansLaSerie: 143 }))).toBe('distinct');
	});

	it('ne rapproche jamais deux types différents', () => {
		expect(verdictDeRapprochement(numero(), numero({ type: 'recueil' }))).toBe('distinct');
	});

	it('ne rapproche pas sur le triplet ce qui n a ni série ni rang — un film', () => {
		const film: SignatureOeuvre = {
			type: 'film',
			serieEntityId: null,
			numeroDansLaSerie: null,
			dateDeParution: '2008-05-02'
		};
		expect(verdictDeRapprochement(film, { ...film })).toBe('distinct');
	});

	it('ignore une date illisible comme une date absente', () => {
		expect(verdictDeRapprochement(numero(), numero({ dateDeParution: 'circa 1981' }))).toBe(
			'douteux'
		);
	});
});

describe('rapprochement en base', () => {
	it('deux sources décrivant le même numéro produisent une seule œuvre à deux identifiants', async () => {
		const db = createTestDb();
		const commun = {
			titre: 'Uncanny X-Men #142',
			numeroDansLaSerie: 142,
			dateDeParution: '1981-02-01'
		};

		const chezMetron = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', {
				...commun,
				serie: entite('metron', 's-12', 'Uncanny X-Men')
			}),
			{ now: T0 }
		);

		// Comic Vine nomme la même série sous un autre identifiant : le
		// rapprochement passe donc par le triplet, pas par l'identifiant.
		const chezComicVine = await ingererOeuvre(
			db,
			oeuvreDistante('comicvine', '77771', {
				...commun,
				dateDeParution: '1980-12-10',
				serie: entite('metron', 's-12', 'Uncanny X-Men')
			}),
			{ now: T0 + 1000 }
		);

		expect(chezComicVine.oeuvreId).toBe(chezMetron.oeuvreId);
		expect(chezComicVine.creee).toBe(false);
		expect((await db.select().from(works)).length).toBe(1);
		expect((await lireOeuvre(db, chezMetron.oeuvreId))?.identifiants).toEqual([
			reference('metron', '4021'),
			reference('comicvine', '77771')
		]);
	});

	it('deux numéros de même série et même rang mais de dates éloignées ne sont pas fusionnés', async () => {
		const db = createTestDb();
		const serie = entite('metron', 's-99', 'Fantastic Four');

		const original = await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'a', {
				titre: 'Fantastic Four #1',
				numeroDansLaSerie: 1,
				dateDeParution: '1961-11-01',
				serie
			}),
			{ now: T0 }
		);
		const relance = await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'b', {
				titre: 'Fantastic Four #1 (relance)',
				numeroDansLaSerie: 1,
				dateDeParution: '1998-01-01',
				serie
			}),
			{ now: T0 + 1000 }
		);

		expect(relance.oeuvreId).not.toBe(original.oeuvreId);
		expect((await db.select().from(works)).length).toBe(2);
	});

	it('rapproche par identifiant de source sans consulter le triplet', async () => {
		const db = createTestDb();
		const premiere = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', { titre: 'Titre initial' }),
			{ now: T0 }
		);

		const trouvee = await rapprocher(db, {
			reference: reference('metron', '4021'),
			type: 'numero',
			serieEntityId: null,
			numeroDansLaSerie: null,
			dateDeParution: null
		});

		expect(trouvee).toEqual({ oeuvreId: premiere.oeuvreId, par: 'identifiant de source' });
	});

	it('traite l ambiguïté comme une absence : deux candidates n en font choisir aucune', async () => {
		const db = createTestDb();
		const serie = entite('metron', 's-99', 'Fantastic Four');
		const commun = { numeroDansLaSerie: 1, dateDeParution: '1961-11-01', serie };

		const premiere = await ingererOeuvre(db, oeuvreDistante('metron', 'a', commun), { now: T0 });
		const locale = await db.query.works.findFirst({ where: eq(works.id, premiere.oeuvreId) });

		// Un doublon local préexistant, tel qu'une fusion manuelle reste à faire :
		// en choisir un au hasard écraserait la donnée de l'autre.
		await db.insert(works).values({
			type: 'numero',
			title: 'Fantastic Four #1',
			releaseDate: '1961-11-01',
			seriesEntityId: locale!.seriesEntityId,
			numberInSeries: 1,
			ingestionState: 'complete',
			createdAt: T0,
			updatedAt: T0
		});

		const troisieme = await ingererOeuvre(db, oeuvreDistante('comicvine', 'c', commun), {
			now: T0 + 2
		});

		expect(troisieme.creee).toBe(true);
		expect((await db.select().from(works)).length).toBe(3);
	});

	it('signale les doublons douteux plutôt que de les laisser invisibles', async () => {
		const db = createTestDb();
		const serie = entite('metron', 's-99', 'Fantastic Four');

		const datee = await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'a', { numeroDansLaSerie: 1, dateDeParution: '1961-11-01', serie }),
			{ now: T0 }
		);
		await ingererOeuvre(db, oeuvreDistante('comicvine', 'b', { numeroDansLaSerie: 1, serie }), {
			now: T0 + 1
		});

		const douteux = await doublonsDouteux(db, datee.oeuvreId);
		expect(douteux.map((d) => d.verdict)).toEqual(['douteux']);
	});
});

describe('fusion manuelle', () => {
	it('réunit les identifiants, les rattachements et les corrections', async () => {
		const db = createTestDb();
		const auteur = await membre(db);

		const gardee = await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'a', {
				titre: 'Fantastic Four #1',
				personnages: [entite('metron', 'p-1', 'La Chose')]
			}),
			{ now: T0 }
		);
		const doublon = await ingererOeuvre(
			db,
			oeuvreDistante('comicvine', 'b', {
				titre: 'Fantastic Four #1',
				dateDeParution: '1961-11-01',
				personnages: [entite('comicvine', 'p-9', 'Mister Fantastic')]
			}),
			{ now: T0 + 1 }
		);
		await corriger(db, {
			oeuvreId: doublon.oeuvreId,
			membreId: auteur,
			correction: { champ: 'titre', valeur: 'Fantastic Four #1 — édition originale' },
			now: T0 + 2
		});

		const fusion = await fusionnerManuellement(db, {
			conservee: gardee.oeuvreId,
			absorbee: doublon.oeuvreId,
			now: T0 + 3
		});

		expect(fusion).toEqual({ ok: true, oeuvreId: gardee.oeuvreId });
		expect((await db.select().from(works)).length).toBe(1);

		const oeuvre = await lireOeuvre(db, gardee.oeuvreId);
		expect(oeuvre?.identifiants).toEqual([reference('metron', 'a'), reference('comicvine', 'b')]);
		expect(oeuvre?.personnages.map((p) => p.nom).sort()).toEqual(['La Chose', 'Mister Fantastic']);
		// La correction a suivi l'œuvre : R39 vaut aussi à travers une fusion.
		expect(oeuvre?.titre).toBe('Fantastic Four #1 — édition originale');
		// Le champ que seule l'absorbée portait comble le trou de la conservée.
		expect(oeuvre?.dateDeParution).toBe('1961-11-01');
	});

	it('notifie la re-matérialisation du graphe', async () => {
		const db = createTestDb();
		const gardee = await ingererOeuvre(db, oeuvreDistante('metron', 'a'), { now: T0 });
		const doublon = await ingererOeuvre(db, oeuvreDistante('comicvine', 'b'), { now: T0 + 1 });

		await fusionnerManuellement(db, {
			conservee: gardee.oeuvreId,
			absorbee: doublon.oeuvreId,
			now: T0 + 2
		});

		expect(await estEnAttente(db, gardee.oeuvreId)).toBe(true);
	});

	it('refuse de fusionner une œuvre avec elle-même', async () => {
		const db = createTestDb();
		const oeuvre = await ingererOeuvre(db, oeuvreDistante('metron', 'a'), { now: T0 });

		expect(
			await fusionnerManuellement(db, { conservee: oeuvre.oeuvreId, absorbee: oeuvre.oeuvreId })
		).toEqual({ ok: false, motif: 'même œuvre' });
	});

	it('refuse de fusionner deux types différents', async () => {
		const db = createTestDb();
		const numeroLocal = await ingererOeuvre(db, oeuvreDistante('metron', 'a'), { now: T0 });
		const recueil = await ingererOeuvre(db, oeuvreDistante('metron', 'b', { type: 'recueil' }), {
			now: T0 + 1
		});

		expect(
			await fusionnerManuellement(db, {
				conservee: numeroLocal.oeuvreId,
				absorbee: recueil.oeuvreId
			})
		).toEqual({ ok: false, motif: 'types incompatibles' });
	});

	it('refuse une œuvre introuvable', async () => {
		const db = createTestDb();
		const oeuvre = await ingererOeuvre(db, oeuvreDistante('metron', 'a'), { now: T0 });

		expect(
			await fusionnerManuellement(db, { conservee: oeuvre.oeuvreId, absorbee: 'inexistante' })
		).toEqual({ ok: false, motif: 'œuvre introuvable' });
	});
});
