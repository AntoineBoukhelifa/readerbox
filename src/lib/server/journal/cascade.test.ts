import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import { ingererOeuvre } from '../catalog/ingest';
import { T0, membre, oeuvreDistante, reference } from '../catalog/testing';
import { cascades, entryOrigins, journalEntries } from '../db/schema';
import type { TypeOeuvre } from '../catalog/sources/types';
import {
	abandonner,
	consigner,
	lireConsignation,
	lireJournal,
	noter,
	reprendre,
	retirer
} from './entries';
import { franchissementEnAttente } from './frontiere';
import {
	deroulerCascades,
	executerCascades,
	progressionCascade,
	rattraperCascades
} from './cascade';
import { cascadeEnAttente } from './travaux';
import { cascadeDescendante, etatLePlusAvance } from './contenance';

/**
 * Les recueils, la cascade et l'origine des consignations (U5).
 *
 * Deux choses se testent ici et il ne faut pas les confondre — le document
 * d'exigences en fait son avertissement principal. **Consigner**, c'est poser
 * une œuvre sur une étagère ; **atteindre**, c'est l'avoir terminée ou
 * abandonnée. Une cascade qui ne propagerait que l'existence des entrées et pas
 * leur état laisserait un omnibus terminé sans faire avancer aucun ordre, sans
 * démasquer aucun avis et sans étendre le graphe — sur le geste le plus fréquent
 * du lecteur de comics.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Un numéro du catalogue, ingéré comme un adaptateur le ferait. */
async function numero(db: Db, idExterne: string): Promise<string> {
	const { oeuvreId } = await ingererOeuvre(
		db,
		oeuvreDistante('metron', idExterne, { titre: `Numéro ${idExterne}` }),
		{ now: T0 }
	);
	return oeuvreId;
}

/**
 * Un contenant et son contenu, désigné par les identifiants amont de ce dernier.
 *
 * Les références sont volontairement données telles que la source les donne, y
 * compris quand le numéro correspondant n'a pas encore été ingéré : c'est le cas
 * normal sous KTD1, et `content_work_id` reste nul jusqu'à ce qu'il le soit.
 */
async function contenant(
	db: Db,
	idExterne: string,
	contenu: string[],
	type: TypeOeuvre = 'recueil'
): Promise<string> {
	const { oeuvreId } = await ingererOeuvre(
		db,
		oeuvreDistante('metron', idExterne, {
			type,
			titre: `Contenant ${idExterne}`,
			contenu: contenu.map((id) => reference('metron', id))
		}),
		{ now: T0 }
	);
	return oeuvreId;
}

/** Les recueils qui soutiennent l'entrée d'un membre sur une œuvre. */
async function appuis(db: Db, membreId: string, oeuvreId: string): Promise<string[]> {
	const entree = await lireConsignation(db, membreId, oeuvreId);
	return (entree?.recueils ?? []).sort();
}

/** Le nombre de lignes d'appui en base, pour constater l'absence de doublon. */
async function nombreDAppuis(db: Db): Promise<number> {
	return (await db.select().from(entryOrigins)).length;
}

// ---------------------------------------------------------------------------
// R11 — les règles pures
// ---------------------------------------------------------------------------

describe('R11 — quels types cascadent', () => {
	it('le recueil et la saison cascadent, rien d autre', () => {
		expect(cascadeDescendante('recueil')).toBe(true);
		expect(cascadeDescendante('saison')).toBe(true);
		expect(cascadeDescendante('serie')).toBe(false);
		expect(cascadeDescendante('numero')).toBe(false);
		expect(cascadeDescendante('film')).toBe(false);
		expect(cascadeDescendante('episode')).toBe(false);
		expect(cascadeDescendante('roman')).toBe(false);
	});
});

describe('l état le plus avancé départage plusieurs recueils', () => {
	it('l atteinte prime sur l étagère, et terminé prime sur abandonné en cours', () => {
		expect(etatLePlusAvance([])).toBe(null);
		expect(
			etatLePlusAvance([
				{ etagere: 'en_cours', abandonnee: false },
				{ etagere: 'termine', abandonnee: false }
			])
		).toEqual({ etagere: 'termine', abandonnee: false });
		expect(
			etatLePlusAvance([
				{ etagere: 'termine', abandonnee: false },
				{ etagere: 'en_cours', abandonnee: true }
			])
		).toEqual({ etagere: 'termine', abandonnee: false });
		expect(
			etatLePlusAvance([
				{ etagere: 'a_decouvrir', abandonnee: false },
				{ etagere: 'en_cours', abandonnee: false }
			])
		).toEqual({ etagere: 'en_cours', abandonnee: false });
	});
});

// ---------------------------------------------------------------------------
// R9, R10 — la cascade descendante
// ---------------------------------------------------------------------------

describe('cascade descendante (R9, R10)', () => {
	it('consigner un recueil consigne ses numéros, marqués comme dérivés', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		const deux = await numero(db, '2');
		const recueil = await contenant(db, 'omnibus', ['1', '2']);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'a_decouvrir', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });

		for (const oeuvreId of [un, deux]) {
			const entree = await lireConsignation(db, membreId, oeuvreId);
			expect(entree).toMatchObject({ etagere: 'a_decouvrir', origine: 'derivee', atteinte: false });
			expect(entree?.recueils).toEqual([recueil]);
		}
	});

	it('terminer un recueil rend atteints ses numéros dérivés, et le notifie', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		const deux = await numero(db, '2');
		const recueil = await contenant(db, 'omnibus', ['1', '2']);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'en_cours', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });
		expect((await lireConsignation(db, membreId, un))?.atteinte).toBe(false);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 + 2 });
		await deroulerCascades(db, { now: T0 + 3 });

		for (const oeuvreId of [un, deux]) {
			expect(await lireConsignation(db, membreId, oeuvreId)).toMatchObject({
				etagere: 'termine',
				atteinte: true,
				origine: 'derivee'
			});
			// Le franchissement de frontière est ce qui fait avancer les ordres (U7)
			// et étendre le graphe (U9). Sans lui, la cascade ne propagerait que
			// l'existence des entrées.
			expect(await franchissementEnAttente(db, membreId, oeuvreId)).toMatchObject({
				direction: 'atteinte'
			});
		}
	});

	it('abandonner un recueil propage l abandon, et le reprendre le retire', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		const recueil = await contenant(db, 'omnibus', ['1']);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'en_cours', now: T0 });
		await abandonner(db, { membreId, oeuvreId: recueil, now: T0 + 1 });
		await deroulerCascades(db, { now: T0 + 2 });

		expect(await lireConsignation(db, membreId, un)).toMatchObject({
			abandonnee: true,
			atteinte: true
		});

		await reprendre(db, { membreId, oeuvreId: recueil, now: T0 + 3 });
		await deroulerCascades(db, { now: T0 + 4 });

		expect(await lireConsignation(db, membreId, un)).toMatchObject({
			abandonnee: false,
			atteinte: false
		});
		expect(await franchissementEnAttente(db, membreId, un)).toMatchObject({ direction: 'perte' });
	});

	it('une saison de série télévisée consigne ses épisodes (R11)', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const { oeuvreId: episode } = await ingererOeuvre(
			db,
			oeuvreDistante('tmdb', 'ep1', { type: 'episode', titre: 'Pilote' }),
			{ now: T0 }
		);
		const { oeuvreId: saison } = await ingererOeuvre(
			db,
			oeuvreDistante('tmdb', 's1', {
				type: 'saison',
				titre: 'Saison 1',
				contenu: [reference('tmdb', 'ep1')]
			}),
			{ now: T0 }
		);

		await consigner(db, { membreId, oeuvreId: saison, etagere: 'termine', now: T0 + 1 });
		await deroulerCascades(db, { now: T0 + 2 });

		expect(await lireConsignation(db, membreId, episode)).toMatchObject({
			atteinte: true,
			origine: 'derivee'
		});
	});

	it('consigner une série de comics ne consigne aucun de ses numéros (R11)', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		// Même si la source expose une liste de numéros pour la série, R11
		// l'exclut : une série est ouverte, et cascader dessus consignerait aussi
		// les numéros qui n'existent pas encore.
		const serie = await contenant(db, 'uncanny', ['1'], 'serie');

		await consigner(db, { membreId, oeuvreId: serie, etagere: 'termine', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });

		expect(await cascadeEnAttente(db, membreId, serie)).toBe(null);
		expect(await progressionCascade(db, membreId, serie)).toBe(null);
		expect(await lireConsignation(db, membreId, un)).toBe(null);
		expect(await lireJournal(db, membreId)).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// R9 — la remontée
// ---------------------------------------------------------------------------

describe('remontée (R9)', () => {
	it('atteindre tous les numéros d un recueil l atteint', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		const deux = await numero(db, '2');
		const recueil = await contenant(db, 'omnibus', ['1', '2']);

		await consigner(db, { membreId, oeuvreId: un, etagere: 'termine', now: T0 });
		expect(await lireConsignation(db, membreId, recueil)).toBe(null);

		await consigner(db, { membreId, oeuvreId: deux, etagere: 'termine', now: T0 + 1 });

		expect(await lireConsignation(db, membreId, recueil)).toMatchObject({
			etagere: 'termine',
			atteinte: true,
			// Aucun recueil ne soutient cette entrée : c'est le membre qui l'a
			// atteinte, en lisant tout ce qu'elle contient.
			origine: 'directe',
			recueils: []
		});
		expect(await franchissementEnAttente(db, membreId, recueil)).toMatchObject({
			direction: 'atteinte'
		});
	});

	it('un recueil dont un numéro n est pas encore résolu ne remonte pas', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		const recueil = await contenant(db, 'omnibus', ['1', '2']);

		await consigner(db, { membreId, oeuvreId: un, etagere: 'termine', now: T0 });

		// Le numéro 2 existe chez la source mais pas encore en local : rien ne dit
		// que le membre l'a lu, donc le recueil n'est pas atteint.
		expect(await lireConsignation(db, membreId, recueil)).toBe(null);
	});

	it('atteindre un numéro par cascade peut compléter un autre recueil', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		const deux = await numero(db, '2');
		const omnibus = await contenant(db, 'omnibus', ['1', '2']);
		const integrale = await contenant(db, 'integrale', ['1', '2']);

		await consigner(db, { membreId, oeuvreId: omnibus, etagere: 'termine', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });

		expect(await lireConsignation(db, membreId, un)).toMatchObject({ atteinte: true });
		expect(await lireConsignation(db, membreId, deux)).toMatchObject({ atteinte: true });
		expect(await lireConsignation(db, membreId, integrale)).toMatchObject({ atteinte: true });
	});
});

// ---------------------------------------------------------------------------
// R34 — les appuis multiples
// ---------------------------------------------------------------------------

describe('appuis multiples (R34)', () => {
	it('un numéro dérivé de deux recueils survit au retrait de l un des deux', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		await numero(db, '2');
		const omnibus = await contenant(db, 'omnibus', ['1']);
		// L'intégrale contient un numéro de plus, que le membre n'atteindra pas :
		// sans quoi la remontée de R9 la terminerait aussi, et le test ne
		// mesurerait plus ce qu'il prétend mesurer.
		const integrale = await contenant(db, 'integrale', ['1', '2']);

		await consigner(db, { membreId, oeuvreId: omnibus, etagere: 'termine', now: T0 });
		await consigner(db, { membreId, oeuvreId: integrale, etagere: 'en_cours', now: T0 + 1 });
		await deroulerCascades(db, { now: T0 + 2 });

		// Deux appuis, et l'état le plus avancé l'emporte : le numéro est atteint.
		expect(await appuis(db, membreId, un)).toEqual([omnibus, integrale].sort());
		expect(await lireConsignation(db, membreId, un)).toMatchObject({ atteinte: true });

		await retirer(db, { membreId, oeuvreId: omnibus, now: T0 + 3 });
		await deroulerCascades(db, { now: T0 + 4 });

		const entree = await lireConsignation(db, membreId, un);
		expect(entree).not.toBe(null);
		expect(entree?.recueils).toEqual([integrale]);
		// L'appui restant est « en cours » : le numéro reste consigné mais cesse
		// d'être atteint, et la frontière est notifiée dans ce sens.
		expect(entree).toMatchObject({ etagere: 'en_cours', atteinte: false });
		expect(await franchissementEnAttente(db, membreId, un)).toMatchObject({ direction: 'perte' });
	});

	it('deux recueils qui se chevauchent produisent une seule entrée par numéro', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const identifiants = ['4', '5', '6', '7'];
		const oeuvres = new Map<string, string>();
		for (const id of identifiants) oeuvres.set(id, await numero(db, id));

		const premier = await contenant(db, 'a', ['4', '5', '6']);
		const second = await contenant(db, 'b', ['5', '6', '7']);

		await consigner(db, { membreId, oeuvreId: premier, etagere: 'termine', now: T0 });
		await consigner(db, { membreId, oeuvreId: second, etagere: 'termine', now: T0 + 1 });
		await deroulerCascades(db, { now: T0 + 2 });

		// Quatre numéros, deux recueils : six entrées, pas sept.
		expect(await lireJournal(db, membreId)).toHaveLength(6);

		expect(await appuis(db, membreId, oeuvres.get('4')!)).toEqual([premier]);
		expect(await appuis(db, membreId, oeuvres.get('5')!)).toEqual([premier, second].sort());
		expect(await appuis(db, membreId, oeuvres.get('6')!)).toEqual([premier, second].sort());
		expect(await appuis(db, membreId, oeuvres.get('7')!)).toEqual([second]);
	});

	it('retirer la dernière origine d une entrée dérivée la supprime et notifie U4', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		const recueil = await contenant(db, 'omnibus', ['1']);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });
		expect(await lireConsignation(db, membreId, un)).toMatchObject({ atteinte: true });

		await retirer(db, { membreId, oeuvreId: recueil, now: T0 + 2 });
		await deroulerCascades(db, { now: T0 + 3 });

		expect(await lireConsignation(db, membreId, un)).toBe(null);
		expect(await lireJournal(db, membreId)).toHaveLength(0);
		expect(await nombreDAppuis(db)).toBe(0);
		expect(await franchissementEnAttente(db, membreId, un)).toMatchObject({ direction: 'perte' });
	});

	it('un numéro consigné directement puis couvert par un recueil garde son origine directe', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		const recueil = await contenant(db, 'omnibus', ['1']);

		await consigner(db, { membreId, oeuvreId: un, etagere: 'termine', now: T0 });
		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'en_cours', now: T0 + 1 });
		await deroulerCascades(db, { now: T0 + 2 });

		expect(await lireConsignation(db, membreId, un)).toMatchObject({
			origine: 'directe',
			recueils: [recueil]
		});

		// Et le retrait du recueil ne l'emporte pas : le membre l'avait consigné.
		await retirer(db, { membreId, oeuvreId: recueil, now: T0 + 3 });
		await deroulerCascades(db, { now: T0 + 4 });

		expect(await lireConsignation(db, membreId, un)).toMatchObject({
			origine: 'directe',
			etagere: 'termine',
			recueils: []
		});
	});

	it('un numéro portant un état propre n est pas écrasé par la propagation', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		const deux = await numero(db, '2');
		const recueil = await contenant(db, 'omnibus', ['1', '2']);

		await consigner(db, { membreId, oeuvreId: un, etagere: 'termine', now: T0 });
		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'a_decouvrir', now: T0 + 1 });
		await deroulerCascades(db, { now: T0 + 2 });

		// Le numéro déjà terminé le reste : la propagation n'écrase que ce qui n'a
		// pas d'état propre.
		expect(await lireConsignation(db, membreId, un)).toMatchObject({
			etagere: 'termine',
			atteinte: true
		});
		expect(await lireConsignation(db, membreId, deux)).toMatchObject({
			etagere: 'a_decouvrir',
			atteinte: false
		});
	});

	it('toucher une entrée dérivée lui donne un état propre, définitivement', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		const recueil = await contenant(db, 'omnibus', ['1']);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'a_decouvrir', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });
		expect(await lireConsignation(db, membreId, un)).toMatchObject({ origine: 'derivee' });

		await consigner(db, { membreId, oeuvreId: un, etagere: 'termine', now: T0 + 2 });
		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'en_cours', now: T0 + 3 });
		await deroulerCascades(db, { now: T0 + 4 });

		expect(await lireConsignation(db, membreId, un)).toMatchObject({
			origine: 'directe',
			etagere: 'termine'
		});
	});

	it('R33 et R34 — retirer une consignation directe encore soutenue la conserve, sans sa note', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		const recueil = await contenant(db, 'omnibus', ['1']);

		await consigner(db, { membreId, oeuvreId: un, etagere: 'termine', now: T0 });
		await noter(db, { membreId, oeuvreId: un, note: 4, now: T0 + 1 });
		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'en_cours', now: T0 + 2 });
		await deroulerCascades(db, { now: T0 + 3 });

		const resultat = await retirer(db, { membreId, oeuvreId: un, now: T0 + 4 });

		expect(resultat).toEqual({
			ok: true,
			franchissement: 'perte',
			noteSupprimee: true,
			avisSupprime: false,
			entreeConservee: true
		});
		expect(await lireConsignation(db, membreId, un)).toMatchObject({
			origine: 'derivee',
			etagere: 'en_cours',
			note: null,
			recueils: [recueil]
		});
	});
});

// ---------------------------------------------------------------------------
// KTD2 — le fractionnement
// ---------------------------------------------------------------------------

describe('fractionnement (KTD2)', () => {
	it('une cascade interrompue à mi-parcours reprend là où elle s est arrêtée, sans double effet', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const identifiants = ['1', '2', '3', '4', '5'];
		for (const id of identifiants) await numero(db, id);
		const recueil = await contenant(db, 'omnibus', identifiants);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 });

		const premier = await executerCascades(db, { budget: 2, now: T0 + 1 });
		expect(premier).toMatchObject({ elements: 2, restantes: 1 });
		expect(await progressionCascade(db, membreId, recueil)).toEqual({
			action: 'propager',
			total: 5,
			traites: 2,
			terminee: false
		});

		const second = await executerCascades(db, { budget: 2, now: T0 + 2 });
		expect(second).toMatchObject({ elements: 2, restantes: 1 });

		const troisieme = await executerCascades(db, { budget: 2, now: T0 + 3 });
		expect(troisieme).toMatchObject({ elements: 1, restantes: 0 });

		// Rien ne reste, et rejouer ne produit rien de plus.
		const quatrieme = await executerCascades(db, { budget: 2, now: T0 + 4 });
		expect(quatrieme).toEqual({ elements: 0, cascadesTerminees: 0, restantes: 0 });

		// Sans double effet : cinq numéros, cinq entrées dérivées, cinq appuis.
		expect(await lireJournal(db, membreId)).toHaveLength(6);
		expect(await nombreDAppuis(db)).toBe(5);
		expect(await progressionCascade(db, membreId, recueil)).toEqual({
			action: 'propager',
			total: 5,
			traites: 5,
			terminee: true
		});
	});

	it('une cascade de quarante numéros aboutit par lots bornés', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const identifiants = Array.from({ length: 40 }, (_, i) => `${i + 1}`);
		for (const id of identifiants) await numero(db, id);
		const recueil = await contenant(db, 'omnibus', identifiants);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 });

		// Chaque passe est bornée : c'est ce qui la fait tenir sous les plafonds de
		// temps processeur et de sous-requêtes d'une invocation Worker.
		let passes = 0;
		let total = 0;
		for (;;) {
			const resume = await executerCascades(db, { budget: 10, now: T0 + passes + 1 });
			expect(resume.elements).toBeLessThanOrEqual(10);
			total += resume.elements;
			passes += 1;
			if (resume.elements === 0) break;
			expect(passes).toBeLessThan(10);
		}

		expect(total).toBe(40);
		expect(await lireJournal(db, membreId)).toHaveLength(41);
		expect(await nombreDAppuis(db)).toBe(40);

		const journal = await lireJournal(db, membreId);
		expect(journal.every((entree) => entree.atteinte)).toBe(true);
	});

	it('reconsigner un recueil pendant sa cascade en reprend la propagation avec le nouvel état', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const identifiants = ['1', '2', '3', '4'];
		for (const id of identifiants) await numero(db, id);
		const recueil = await contenant(db, 'omnibus', identifiants);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'en_cours', now: T0 });
		await executerCascades(db, { budget: 2, now: T0 + 1 });

		// Le membre termine l'omnibus avant que le Cron n'ait fini : la cascade en
		// attente doit repartir du début, sans quoi la moitié des numéros
		// resterait figée en « en cours ».
		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 + 2 });
		await deroulerCascades(db, { now: T0 + 3 });

		const journal = await lireJournal(db, membreId);
		expect(journal).toHaveLength(5);
		expect(journal.every((entree) => entree.atteinte)).toBe(true);
		expect(await nombreDAppuis(db)).toBe(4);
	});

	it('dérouler une cascade déjà entièrement propagée ne change rien', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		const recueil = await contenant(db, 'omnibus', ['1']);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });
		const avant = await lireConsignation(db, membreId, un);

		// Une seconde consignation sur la même étagère ne planifie rien : l'état du
		// contenant n'a pas bougé.
		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 + 2 });
		expect(await cascadeEnAttente(db, membreId, recueil)).toBe(null);

		const resume = await deroulerCascades(db, { now: T0 + 3 });
		expect(resume).toEqual({ elements: 0, cascadesTerminees: 0, restantes: 0 });
		expect(await lireConsignation(db, membreId, un)).toEqual(avant);
		expect(await nombreDAppuis(db)).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Cas limites
// ---------------------------------------------------------------------------

describe('cas limites', () => {
	it('un contenu non encore résolu est repris quand l ingestion le résout', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		// Le recueil est ingéré avant ses numéros : c'est le cas normal sous KTD1.
		const recueil = await contenant(db, 'omnibus', ['1']);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });

		expect(await lireJournal(db, membreId)).toHaveLength(1);
		expect(await progressionCascade(db, membreId, recueil)).toMatchObject({
			total: 0,
			terminee: true
		});

		// L'ingestion du numéro résout rétroactivement la ligne de contenu.
		const un = await numero(db, '1');
		expect(await rattraperCascades(db, { now: T0 + 2 })).toEqual({ replanifiees: 1 });
		await deroulerCascades(db, { now: T0 + 3 });

		expect(await lireConsignation(db, membreId, un)).toMatchObject({
			atteinte: true,
			origine: 'derivee',
			recueils: [recueil]
		});
	});

	it('le rattrapage ne replanifie pas une cascade déjà en attente', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		await numero(db, '1');
		const recueil = await contenant(db, 'omnibus', ['1']);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 });

		// Replanifier remettrait le curseur à zéro à chaque passage du Cron : une
		// cascade assez longue ne s'achèverait jamais.
		expect(await rattraperCascades(db, { now: T0 + 1 })).toEqual({ replanifiees: 0 });
	});

	it('le rattrapage laisse tranquille un recueil entièrement propagé', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		await numero(db, '1');
		const recueil = await contenant(db, 'omnibus', ['1']);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });

		expect(await rattraperCascades(db, { now: T0 + 2 })).toEqual({ replanifiees: 0 });
	});

	it('un recueil vide se consigne et sa cascade s achève aussitôt', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const recueil = await contenant(db, 'omnibus', []);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 });
		const resume = await deroulerCascades(db, { now: T0 + 1 });

		expect(resume).toEqual({ elements: 0, cascadesTerminees: 1, restantes: 0 });
		expect(await progressionCascade(db, membreId, recueil)).toEqual({
			action: 'propager',
			total: 0,
			traites: 0,
			terminee: true
		});
		expect(await lireJournal(db, membreId)).toHaveLength(1);
	});

	it('un recueil qui se contient lui-même ne devient pas son propre appui', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await numero(db, '1');
		// Erreur de données que les sources produisent : la liste de contenu
		// référence le recueil lui-même.
		const recueil = await contenant(db, 'omnibus', ['1', 'omnibus']);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });

		expect(await appuis(db, membreId, recueil)).toEqual([]);
		expect(await appuis(db, membreId, un)).toEqual([recueil]);
		expect(await nombreDAppuis(db)).toBe(1);

		// Et il reste supprimable : une entrée soutenue par elle-même ne le serait
		// plus.
		await retirer(db, { membreId, oeuvreId: recueil, now: T0 + 2 });
		await deroulerCascades(db, { now: T0 + 3 });
		expect(await lireJournal(db, membreId)).toHaveLength(0);
	});

	it('la cascade d un membre ne touche pas au journal d un autre', async () => {
		const db = createTestDb();
		const antoine = await membre(db, 'Antoine');
		const camille = await membre(db, 'Camille');
		const un = await numero(db, '1');
		const recueil = await contenant(db, 'omnibus', ['1']);

		await consigner(db, { membreId: antoine, oeuvreId: recueil, etagere: 'termine', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });

		expect(await lireConsignation(db, antoine, un)).toMatchObject({ atteinte: true });
		expect(await lireConsignation(db, camille, un)).toBe(null);
		expect(await lireJournal(db, camille)).toHaveLength(0);
	});

	it('la provenance du recueil est celle de ses numéros (R42)', async () => {
		const db = createTestDb();
		const membreId = await membre(db, 'Antoine');
		const prescripteur = await membre(db, 'Camille');
		const un = await numero(db, '1');
		const recueil = await contenant(db, 'omnibus', ['1']);

		await consigner(db, {
			membreId,
			oeuvreId: recueil,
			etagere: 'termine',
			provenance: { type: 'membre', membreId: prescripteur },
			now: T0
		});
		await deroulerCascades(db, { now: T0 + 1 });

		expect((await lireConsignation(db, membreId, un))?.provenance).toEqual({
			type: 'membre',
			membreId: prescripteur
		});
	});

	it('une cascade terminée reste lisible, et une nouvelle consignation en ouvre une autre', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		await numero(db, '1');
		const recueil = await contenant(db, 'omnibus', ['1']);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'en_cours', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });
		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 + 2 });
		await deroulerCascades(db, { now: T0 + 3 });

		const lignes = await db.select().from(cascades).where(eq(cascades.memberId, membreId));
		expect(lignes).toHaveLength(2);
		expect(lignes.every((ligne) => ligne.completedAt !== null)).toBe(true);
	});

	it('aucune entrée dérivée ne survit sans appui', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		await numero(db, '1');
		await numero(db, '2');
		const recueil = await contenant(db, 'omnibus', ['1', '2']);

		await consigner(db, { membreId, oeuvreId: recueil, etagere: 'termine', now: T0 });
		await deroulerCascades(db, { now: T0 + 1 });
		await retirer(db, { membreId, oeuvreId: recueil, now: T0 + 2 });
		await deroulerCascades(db, { now: T0 + 3 });

		const derivees = await db
			.select()
			.from(journalEntries)
			.where(eq(journalEntries.origin, 'derivee'));
		expect(derivees).toHaveLength(0);
		expect(await nombreDAppuis(db)).toBe(0);
	});
});
