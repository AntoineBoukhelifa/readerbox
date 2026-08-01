import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../db/testing';
import { workContents } from '../db/schema';
import { etatDIngestion, ingererOeuvre, oeuvresARejouer } from './ingest';
import { lireCoucheSource, lireOeuvre } from './corrections';
import { estEnAttente } from './rematerialisation';
import { T0, entite, oeuvreDistante, reference } from './testing';

describe("état d'ingestion", () => {
	it('est complet quand tout a été fourni', () => {
		expect(
			etatDIngestion([{ personnages: 'fournis', createurs: 'fournis', contenu: 'sans objet' }])
		).toBe('complete');
	});

	it("est complet quand la source affirme qu'il n'y a rien à fournir", () => {
		expect(
			etatDIngestion([{ personnages: 'absents', createurs: 'absents', contenu: 'sans objet' }])
		).toBe('complete');
	});

	it('est partiel dès qu une sous-ressource est indisponible', () => {
		expect(
			etatDIngestion([
				{ personnages: 'indisponibles', createurs: 'fournis', contenu: 'sans objet' }
			])
		).toBe('partielle');
	});

	it('est échoué quand aucune sous-ressource applicable n a répondu', () => {
		expect(
			etatDIngestion([
				{ personnages: 'indisponibles', createurs: 'indisponibles', contenu: 'indisponible' }
			])
		).toBe('echouee');
	});

	it('ne compte pas « sans objet » comme un succès : un film dont tout a échoué est échoué', () => {
		expect(
			etatDIngestion([
				{ personnages: 'indisponibles', createurs: 'indisponibles', contenu: 'sans objet' }
			])
		).toBe('echouee');
	});

	it("une seconde source comble ce que la première n'avait pas fourni", () => {
		expect(
			etatDIngestion([
				{ personnages: 'indisponibles', createurs: 'fournis', contenu: 'sans objet' },
				{ personnages: 'fournis', createurs: 'indisponibles', contenu: 'sans objet' }
			])
		).toBe('complete');
	});

	it("sans aucune source, rien n'a été ingéré", () => {
		expect(etatDIngestion([])).toBe('echouee');
	});
});

describe('ingestion d une œuvre', () => {
	it('persiste l œuvre avec ses personnages, sa série et son event, en état complet', async () => {
		const db = createTestDb();

		const { oeuvreId, creee, etat } = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', {
				titre: 'Uncanny X-Men #142',
				dateDeParution: '1981-02-01',
				numeroDansLaSerie: 142,
				serie: entite('metron', 's-12', 'Uncanny X-Men'),
				event: entite('metron', 'e-3', 'Days of Future Past'),
				personnages: [entite('metron', 'p-1', 'Kitty Pryde'), entite('metron', 'p-2', 'Wolverine')],
				createurs: [{ ...entite('metron', 'c-1', 'Chris Claremont'), role: 'scénario' }]
			}),
			{ now: T0 }
		);

		expect({ creee, etat }).toEqual({ creee: true, etat: 'complete' });

		const oeuvre = await lireOeuvre(db, oeuvreId);
		expect(oeuvre).toMatchObject({
			type: 'numero',
			titre: 'Uncanny X-Men #142',
			dateDeParution: '1981-02-01',
			numeroDansLaSerie: 142,
			serie: { nom: 'Uncanny X-Men' },
			event: { nom: 'Days of Future Past' },
			etatIngestion: 'complete'
		});
		expect(oeuvre?.personnages.map((p) => p.nom)).toEqual(['Kitty Pryde', 'Wolverine']);
		expect(oeuvre?.createurs).toEqual([
			expect.objectContaining({ nom: 'Chris Claremont', role: 'scénario' })
		]);
		expect(oeuvre?.identifiants).toEqual([{ source: 'metron', idExterne: '4021' }]);
	});

	it('distingue une source qui échoue sur les personnages d une œuvre réellement sans crédits', async () => {
		const db = createTestDb();

		const echouee = await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'ko', {
				titre: 'Numéro dont la liste a échoué',
				completude: { personnages: 'indisponibles' }
			}),
			{ now: T0 }
		);
		const sansCredits = await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'vide', { titre: 'Numéro de 1963 sans crédits' }),
			{ now: T0 }
		);

		expect(echouee.etat).toBe('partielle');
		expect(sansCredits.etat).toBe('complete');

		// Les deux affichent zéro personnage : c'est l'état d'ingestion, et lui
		// seul, qui empêche de les confondre.
		expect((await lireOeuvre(db, echouee.oeuvreId))?.personnages).toEqual([]);
		expect((await lireOeuvre(db, sansCredits.oeuvreId))?.personnages).toEqual([]);
	});

	it('nomme la source et la sous-ressource précises à rejouer', async () => {
		const db = createTestDb();
		const { oeuvreId } = await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'ko', { completude: { personnages: 'indisponibles' } }),
			{ now: T0 }
		);

		expect(await oeuvresARejouer(db)).toEqual([
			{
				oeuvreId,
				etat: 'partielle',
				aRejouer: [{ reference: reference('metron', 'ko'), sousRessources: ['personnages'] }]
			}
		]);
	});

	it('rejoue une ingestion partielle, qui passe en état complet', async () => {
		const db = createTestDb();
		const premiere = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', {
				titre: 'Uncanny X-Men #142',
				completude: { personnages: 'indisponibles' }
			}),
			{ now: T0 }
		);
		expect(premiere.etat).toBe('partielle');

		const rejeu = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', {
				titre: 'Uncanny X-Men #142',
				personnages: [entite('metron', 'p-2', 'Wolverine')]
			}),
			{ now: T0 + 1000 }
		);

		expect(rejeu).toMatchObject({ oeuvreId: premiere.oeuvreId, creee: false, etat: 'complete' });
		expect((await lireOeuvre(db, premiere.oeuvreId))?.personnages.map((p) => p.nom)).toEqual([
			'Wolverine'
		]);
		expect(await oeuvresARejouer(db)).toEqual([]);
	});

	it('une source indisponible sur les personnages n efface pas ceux qu une autre a fournis', async () => {
		const db = createTestDb();
		const serie = entite('metron', 's-12', 'Uncanny X-Men');

		const premiere = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', {
				titre: 'Uncanny X-Men #142',
				dateDeParution: '1981-02-01',
				numeroDansLaSerie: 142,
				serie,
				personnages: [entite('metron', 'p-2', 'Wolverine')]
			}),
			{ now: T0 }
		);

		await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', {
				titre: 'Uncanny X-Men #142',
				completude: { personnages: 'indisponibles' }
			}),
			{ now: T0 + 1000 }
		);

		expect((await lireOeuvre(db, premiere.oeuvreId))?.personnages.map((p) => p.nom)).toEqual([
			'Wolverine'
		]);
	});

	it("une source qui affirme l'absence de crédits efface bien sa propre couche", async () => {
		const db = createTestDb();
		const premiere = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', { personnages: [entite('metron', 'p-2', 'Wolverine')] }),
			{ now: T0 }
		);

		await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', { completude: { personnages: 'absents' } }),
			{ now: T0 + 1000 }
		);

		expect((await lireOeuvre(db, premiere.oeuvreId))?.personnages).toEqual([]);
	});

	it('persiste une œuvre sans série ni event — un film', async () => {
		const db = createTestDb();
		const { oeuvreId, etat } = await ingererOeuvre(
			db,
			oeuvreDistante('tmdb', '1726', {
				type: 'film',
				titre: 'Iron Man',
				dateDeParution: '2008-05-02'
			}),
			{ now: T0 }
		);

		expect(etat).toBe('complete');
		expect(await lireOeuvre(db, oeuvreId)).toMatchObject({
			type: 'film',
			serie: null,
			event: null,
			numeroDansLaSerie: null
		});
	});

	it('un recueil dont la source ignore le contenu reste rejouable, pas vide par erreur', async () => {
		const db = createTestDb();

		const inconnu = await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'omni-ko', {
				type: 'recueil',
				titre: 'Omnibus au sommaire indisponible',
				completude: { contenu: 'indisponible' }
			}),
			{ now: T0 }
		);
		const sansContenu = await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'omni-vide', {
				type: 'recueil',
				titre: 'Recueil dont la source dit le sommaire vide'
			}),
			{ now: T0 }
		);

		expect(inconnu.etat).toBe('partielle');
		expect(sansContenu.etat).toBe('complete');
		expect((await lireOeuvre(db, inconnu.oeuvreId))?.contenu).toEqual([]);
	});

	it('conserve le contenu d un recueil avant que ses numéros soient ingérés, puis le résout', async () => {
		const db = createTestDb();

		const recueil = await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'omni-1', {
				type: 'recueil',
				titre: 'X-Men Omnibus',
				contenu: [reference('metron', '4021'), reference('metron', '4022')]
			}),
			{ now: T0 }
		);

		// KTD1 interdit d'ingérer les quarante numéros d'un omnibus au moment où
		// l'on ingère l'omnibus : la référence attend, elle n'est pas perdue.
		const avant = await lireOeuvre(db, recueil.oeuvreId);
		expect(avant?.contenu).toEqual([
			{ oeuvreId: null, reference: reference('metron', '4021'), rang: 0 },
			{ oeuvreId: null, reference: reference('metron', '4022'), rang: 1 }
		]);

		const numero = await ingererOeuvre(db, oeuvreDistante('metron', '4021'), { now: T0 + 1000 });

		const lignes = await db.query.workContents.findMany({
			where: eq(workContents.containerWorkId, recueil.oeuvreId)
		});
		expect(lignes.find((l) => l.externalId === '4021')?.contentWorkId).toBe(numero.oeuvreId);
		expect(lignes.find((l) => l.externalId === '4022')?.contentWorkId).toBeNull();
	});

	it('ne notifie pas la re-matérialisation à la création : personne n a encore atteint l œuvre', async () => {
		const db = createTestDb();
		const { oeuvreId, rattachementsModifies } = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', { personnages: [entite('metron', 'p-2', 'Wolverine')] }),
			{ now: T0 }
		);

		expect(rattachementsModifies).toBe(false);
		expect(await estEnAttente(db, oeuvreId)).toBe(false);
	});

	it('notifie la re-matérialisation quand une ré-ingestion ajoute un personnage', async () => {
		const db = createTestDb();
		const premiere = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', { personnages: [entite('metron', 'p-2', 'Wolverine')] }),
			{ now: T0 }
		);

		const rejeu = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', {
				personnages: [entite('metron', 'p-2', 'Wolverine'), entite('metron', 'p-1', 'Kitty Pryde')]
			}),
			{ now: T0 + 1000 }
		);

		expect(rejeu.rattachementsModifies).toBe(true);
		expect(await estEnAttente(db, premiere.oeuvreId)).toBe(true);
	});

	it('ne notifie rien quand une ré-ingestion ne change aucun rattachement', async () => {
		const db = createTestDb();
		const oeuvre = oeuvreDistante('metron', '4021', {
			personnages: [entite('metron', 'p-2', 'Wolverine')]
		});
		const premiere = await ingererOeuvre(db, oeuvre, { now: T0 });

		const rejeu = await ingererOeuvre(
			db,
			{ ...oeuvre, titre: 'Titre corrigé en amont' },
			{
				now: T0 + 1000
			}
		);

		expect(rejeu.rattachementsModifies).toBe(false);
		expect(await estEnAttente(db, premiere.oeuvreId)).toBe(false);
	});

	it('ne réécrit pas une date connue quand une seconde source se tait', async () => {
		const db = createTestDb();
		const premiere = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', { dateDeParution: '1981-02-01' }),
			{ now: T0 }
		);

		await ingererOeuvre(db, oeuvreDistante('metron', '4021', { titre: 'Autre titre' }), {
			now: T0 + 1000
		});

		expect((await lireCoucheSource(db, premiere.oeuvreId))?.dateDeParution).toBe('1981-02-01');
	});
});
