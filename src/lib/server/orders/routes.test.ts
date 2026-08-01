import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import { members, type Member } from '../db/schema';
import { ingererOeuvre } from '../catalog/ingest';
import { T0, oeuvreDistante } from '../catalog/testing';
import { consigner } from '../journal/entries';
import { creerOrdre, ajouterEntree, lireOrdre, suivre, suiveursDOrdre } from './orders';

/**
 * Les surfaces des ordres, éprouvées sur ce qu'elles envoient et ce qu'elles
 * écrivent.
 *
 * Deux choses ne se voient qu'ici, et aucun test de module ne les attrape :
 *
 * - **l'identité du membre vient de la session**, pas du formulaire. Un champ
 *   `membre` posté n'a aucun effet, parce qu'aucune action ne le lit ;
 * - **le refus d'édition est vérifié côté serveur**, et pas seulement en
 *   masquant l'éditeur. Cacher un formulaire n'est pas une autorisation.
 *
 * Même harnais qu'en U6 : la base de test est injectée par substitution de
 * `getDb`, tout le reste des routes s'exécute tel quel.
 */
const contexte = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('$lib/server/db', async (importOriginal) => {
	const original = await importOriginal<typeof import('../db')>();
	return { ...original, getDb: () => contexte.db };
});

const { load: chargerOrdre, actions: actionsOrdre } =
	await import('../../../routes/order/[id]/+page.server');
const { load: chargerListe } = await import('../../../routes/orders/+page.server');
const { actions: actionsCreation } = await import('../../../routes/order/new/+page.server');

let db: Db;

beforeEach(() => {
	db = createTestDb();
	contexte.db = db;
});

async function membre(nom: string): Promise<Member> {
	const [ligne] = await db.insert(members).values({ displayName: nom, createdAt: T0 }).returning();
	return ligne;
}

async function oeuvre(idExterne: string, titre = `Numéro ${idExterne}`): Promise<string> {
	const { oeuvreId } = await ingererOeuvre(db, oeuvreDistante('metron', idExterne, { titre }), {
		now: T0
	});
	return oeuvreId;
}

/** Un événement de requête réduit à ce que les routes lisent. */
function evenement<T>(
	membreConnecte: Member | null,
	params: Record<string, string> = {},
	champs: Record<string, string> = {},
	requete = ''
): T {
	const corps = new FormData();
	for (const [nom, valeur] of Object.entries(champs)) corps.set(nom, valeur);

	return {
		params,
		url: new URL(`http://localhost/${requete}`),
		locals: { member: membreConnecte },
		platform: { env: { DB: {} } },
		request: new Request('http://localhost/', { method: 'POST', body: corps })
	} as unknown as T;
}

function utile<T>(charge: T): Exclude<T, void> {
	return charge as Exclude<T, void>;
}

/**
 * Ce qu'une action rend **ou** jette.
 *
 * `redirect` de SvelteKit est une exception, pas une valeur de retour : une
 * action qui redirige n'a rien à rendre, et c'est l'objet jeté qui porte la
 * destination.
 */
async function issue(action: unknown): Promise<{ status?: number; location?: string }> {
	try {
		return ((await (action as () => Promise<unknown>)()) ?? {}) as { status?: number };
	} catch (jetee) {
		return jetee as { status?: number; location?: string };
	}
}

/** Un ordre de trois entrées, signé par `auteur`. */
async function scene() {
	const auteur = await membre('Camille');
	const suiveur = await membre('Antoine');

	const creation = await creerOrdre(db, { membreId: auteur.id, titre: 'Par où entrer', now: T0 });
	if (!creation.ok) throw new Error(creation.motif);

	const oeuvres: string[] = [];
	for (const index of [1, 2, 3]) {
		const oeuvreId = await oeuvre(String(index));
		await ajouterEntree(db, {
			membreId: auteur.id,
			ordreId: creation.ordreId,
			oeuvreId,
			now: T0
		});
		oeuvres.push(oeuvreId);
	}

	return { auteur, suiveur, ordreId: creation.ordreId, oeuvres };
}

// ---------------------------------------------------------------------------
// La page
// ---------------------------------------------------------------------------

describe('la page d’un ordre', () => {
	it('rend la progression du membre connecté, pas celle de l’auteur', async () => {
		const { auteur, suiveur, ordreId, oeuvres } = await scene();
		await consigner(db, {
			membreId: suiveur.id,
			oeuvreId: oeuvres[0],
			etagere: 'termine',
			now: T0
		});

		const vuParLeSuiveur = utile(await chargerOrdre(evenement(suiveur, { id: ordreId })));
		const vuParLAuteur = utile(await chargerOrdre(evenement(auteur, { id: ordreId })));

		expect(vuParLeSuiveur.progression.pourcentage).toBe(33);
		expect(vuParLAuteur.progression.pourcentage).toBe(0);
		expect(vuParLeSuiveur.ordre.modifiable).toBe(false);
		expect(vuParLAuteur.ordre.modifiable).toBe(true);
	});

	it('R22 — porte le nombre de suiveurs et la progression de chacun', async () => {
		const { auteur, suiveur, ordreId, oeuvres } = await scene();
		await suivre(db, { membreId: suiveur.id, ordreId, now: T0 });
		await consigner(db, {
			membreId: suiveur.id,
			oeuvreId: oeuvres[0],
			etagere: 'termine',
			now: T0
		});

		const charge = utile(await chargerOrdre(evenement(auteur, { id: ordreId })));

		expect(charge.ordre.nombreDeSuiveurs).toBe(1);
		expect(charge.suiveurs).toEqual([
			{ membreId: suiveur.id, nom: 'Antoine', pourcentage: 33, nombreAtteintes: 1 }
		]);
	});

	it('ne charge la recherche et les séries que pour l’auteur', async () => {
		const { auteur, suiveur, ordreId } = await scene();
		await oeuvre('cible', 'Une œuvre à verser');

		const pourLAuteur = utile(
			await chargerOrdre(evenement(auteur, { id: ordreId }, {}, '?q=verser'))
		);
		const pourLeSuiveur = utile(
			await chargerOrdre(evenement(suiveur, { id: ordreId }, {}, '?q=verser'))
		);

		expect(pourLAuteur.resultats).toHaveLength(1);
		expect(pourLeSuiveur.resultats).toEqual([]);
		expect(pourLeSuiveur.series).toEqual([]);
	});

	it('refuse la page sans session et rend 404 sur un ordre inconnu', async () => {
		const { auteur, ordreId } = await scene();

		await expect(chargerOrdre(evenement(null, { id: ordreId }))).rejects.toMatchObject({
			status: 401
		});
		await expect(chargerOrdre(evenement(auteur, { id: 'forgé' }))).rejects.toMatchObject({
			status: 404
		});
	});
});

// ---------------------------------------------------------------------------
// Les gestes
// ---------------------------------------------------------------------------

describe('les gestes d’édition (R16)', () => {
	it('un suiveur qui poste directement reçoit un refus, et rien ne bouge', async () => {
		const { auteur, suiveur, ordreId } = await scene();
		const intruse = await oeuvre('intruse');

		const resultat = await actionsOrdre.ajouter(
			evenement(suiveur, { id: ordreId }, { oeuvre: intruse })
		);

		expect(resultat).toMatchObject({ status: 403 });
		expect((await lireOrdre(db, ordreId, auteur.id))?.entrees).toHaveLength(3);
	});

	it('l’auteur verse, déplace, bascule et retire', async () => {
		const { auteur, ordreId } = await scene();
		const neuve = await oeuvre('neuve', 'La neuve');

		await actionsOrdre.ajouter(evenement(auteur, { id: ordreId }, { oeuvre: neuve }));
		let ordre = await lireOrdre(db, ordreId, auteur.id);
		expect(ordre?.entrees.map((entree) => entree.oeuvre?.titre)).toEqual([
			'Numéro 1',
			'Numéro 2',
			'Numéro 3',
			'La neuve'
		]);

		// Le rang saisi est affiché à partir de 1 : « place-la première ».
		const derniere = ordre!.entrees[3];
		await actionsOrdre.deplacer(
			evenement(auteur, { id: ordreId }, { entree: derniere.id, rang: '1' })
		);
		ordre = await lireOrdre(db, ordreId, auteur.id);
		expect(ordre?.entrees[0].oeuvre?.titre).toBe('La neuve');

		await actionsOrdre.descendre(evenement(auteur, { id: ordreId }, { entree: derniere.id }));
		ordre = await lireOrdre(db, ordreId, auteur.id);
		expect(ordre?.entrees[1].oeuvre?.titre).toBe('La neuve');

		await actionsOrdre.basculer(
			evenement(auteur, { id: ordreId }, { entree: derniere.id, facultative: '1' })
		);
		ordre = await lireOrdre(db, ordreId, auteur.id);
		expect(ordre?.entrees[1].facultative).toBe(true);
		expect(ordre?.progression.essentielles).toBe(3);

		await actionsOrdre.retirer(evenement(auteur, { id: ordreId }, { entree: derniere.id }));
		expect((await lireOrdre(db, ordreId, auteur.id))?.entrees).toHaveLength(3);
	});

	it('monter la première entrée est sans effet plutôt qu’en erreur', async () => {
		const { auteur, ordreId } = await scene();
		const premiere = (await lireOrdre(db, ordreId, auteur.id))!.entrees[0];

		const resultat = await actionsOrdre.monter(
			evenement(auteur, { id: ordreId }, { entree: premiere.id })
		);

		expect(resultat).toEqual({ fait: true });
		expect((await lireOrdre(db, ordreId, auteur.id))?.entrees[0].id).toBe(premiere.id);
	});
});

describe('le suivi vient de la session (R36)', () => {
	it('un membre ne peut pas faire suivre ou cesser de suivre à un autre', async () => {
		const { suiveur, ordreId } = await scene();
		const intrus = await membre('Dominique');
		await suivre(db, { membreId: suiveur.id, ordreId, now: T0 });

		// L'intrus poste tout ce qu'il peut forger, dont l'identifiant du suiveur.
		await actionsOrdre.cesserDeSuivre(
			evenement(intrus, { id: ordreId }, { membre: suiveur.id, membreId: suiveur.id })
		);

		const suiveurs = await suiveursDOrdre(db, ordreId);
		expect(suiveurs.map((s) => s.membreId)).toEqual([suiveur.id]);

		// Et suivre au nom d'un autre n'inscrit que lui-même.
		await actionsOrdre.suivre(evenement(intrus, { id: ordreId }, { membre: suiveur.id }));
		expect((await suiveursDOrdre(db, ordreId)).map((s) => s.membreId).sort()).toEqual(
			[suiveur.id, intrus.id].sort()
		);
	});

	it('cesser de suivre ne touche aucune consignation', async () => {
		const { suiveur, ordreId, oeuvres } = await scene();
		await suivre(db, { membreId: suiveur.id, ordreId, now: T0 });
		await consigner(db, {
			membreId: suiveur.id,
			oeuvreId: oeuvres[0],
			etagere: 'termine',
			now: T0
		});

		await actionsOrdre.cesserDeSuivre(evenement(suiveur, { id: ordreId }));
		await actionsOrdre.suivre(evenement(suiveur, { id: ordreId }));

		const charge = utile(await chargerOrdre(evenement(suiveur, { id: ordreId })));
		expect(charge.ordre.suivi).toBe(true);
		expect(charge.progression.pourcentage).toBe(33);
	});

	it('refuse tout geste sans session', async () => {
		const { ordreId } = await scene();

		for (const action of [
			actionsOrdre.suivre,
			actionsOrdre.cesserDeSuivre,
			actionsOrdre.forker,
			actionsOrdre.ajouter
		]) {
			expect(await action(evenement(null, { id: ordreId }))).toMatchObject({ status: 401 });
		}
	});
});

describe('forker depuis la page (R17)', () => {
	it('redirige vers le fork, qui appartient au forkeur', async () => {
		const { auteur, suiveur, ordreId } = await scene();

		const redirection = await issue(() => actionsOrdre.forker(evenement(suiveur, { id: ordreId })));

		expect(redirection).toMatchObject({ status: 303 });
		const forkId = (redirection.location ?? '').slice('/order/'.length);

		const fork = await lireOrdre(db, forkId, suiveur.id);
		expect(fork?.auteur.id).toBe(suiveur.id);
		expect(fork?.forkDe?.id).toBe(ordreId);
		// L'original n'a pas bougé.
		expect((await lireOrdre(db, ordreId, auteur.id))?.entrees).toHaveLength(3);
	});
});

describe('créer un ordre depuis la page', () => {
	it('redirige vers l’ordre créé', async () => {
		const auteur = await membre('Camille');

		const redirection = await issue(() =>
			actionsCreation.default(evenement(auteur, {}, { titre: 'Entrer chez les X-Men' }))
		);

		expect(redirection).toMatchObject({ status: 303 });
		const ordreId = (redirection.location ?? '').slice('/order/'.length);
		expect((await lireOrdre(db, ordreId, auteur.id))?.titre).toBe('Entrer chez les X-Men');
	});

	it('refuse un titre vide sans perdre la saisie', async () => {
		const auteur = await membre('Camille');

		const resultat = await actionsCreation.default(
			evenement(auteur, {}, { titre: '  ', description: 'Un texte qu’on ne veut pas retaper.' })
		);

		expect(resultat).toMatchObject({
			status: 400,
			data: { description: 'Un texte qu’on ne veut pas retaper.' }
		});
	});
});

describe('la liste des ordres du groupe (F3)', () => {
	it('les rend tous, avec la progression du lecteur', async () => {
		const { suiveur, ordreId, oeuvres } = await scene();
		await consigner(db, {
			membreId: suiveur.id,
			oeuvreId: oeuvres[0],
			etagere: 'termine',
			now: T0
		});

		const charge = utile(await chargerListe(evenement(suiveur)));

		expect(charge.ordres).toEqual([
			expect.objectContaining({
				id: ordreId,
				titre: 'Par où entrer',
				auteur: 'Camille',
				nombreDEntrees: 3,
				pourcentage: 33,
				suivi: false,
				mien: false
			})
		]);
	});

	it('refuse la liste sans session', async () => {
		await expect(chargerListe(evenement(null))).rejects.toMatchObject({ status: 401 });
	});
});
