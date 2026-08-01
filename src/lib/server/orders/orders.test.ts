import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import { ingererOeuvre } from '../catalog/ingest';
import { T0, entite, membre, oeuvreDistante } from '../catalog/testing';
import { markMemberAsLeft } from '../auth/sessions';
import { orderEntries, works } from '../db/schema';
import { abandonner, consigner, reprendre, retirer } from '../journal/entries';
import type { TypeOeuvre } from '../catalog/sources/types';
import {
	ajouterEntree,
	ajouterSerie,
	cesserDeSuivre,
	creerOrdre,
	deplacerEntree,
	forker,
	lireOrdre,
	listerOrdres,
	marquerFacultative,
	modifierOrdre,
	ordresDUnMembre,
	progressionDansOrdre,
	retirerEntree,
	suiveursDOrdre,
	suivre,
	supprimerOrdre
} from './orders';
import { chercherOeuvresAVerser, seriesVersables } from './versement';

/**
 * Les ordres, éprouvés sur la base réelle.
 *
 * `progression.test.ts` couvre l'arithmétique de KTD8 ; ce fichier-ci couvre ce
 * qu'aucune fonction pure ne peut montrer : que les écritures tiennent les
 * invariants — rangs contigus, identités stables, droits de l'auteur — et que la
 * progression **dérivée** suit réellement les gestes du journal.
 */

let db: Db;

beforeEach(() => {
	db = createTestDb();
});

/** Une œuvre du catalogue, ingérée comme un adaptateur le ferait. */
async function oeuvre(
	idExterne: string,
	champs: { titre?: string; type?: TypeOeuvre; serie?: string; numero?: number } = {}
): Promise<string> {
	const { oeuvreId } = await ingererOeuvre(
		db,
		oeuvreDistante('metron', idExterne, {
			titre: champs.titre ?? `Numéro ${idExterne}`,
			...(champs.type ? { type: champs.type } : {}),
			...(champs.serie ? { serie: entite('metron', champs.serie, `Série ${champs.serie}`) } : {}),
			...(champs.numero !== undefined ? { numeroDansLaSerie: champs.numero } : {})
		}),
		{ now: T0 }
	);
	return oeuvreId;
}

/** Un ordre de `n` entrées essentielles, versées dans l'ordre. */
async function ordreDe(
	auteurId: string,
	n: number,
	prefixe = 'x'
): Promise<{ ordreId: string; oeuvres: string[]; entrees: string[] }> {
	const creation = await creerOrdre(db, { membreId: auteurId, titre: 'Par où entrer', now: T0 });
	if (!creation.ok) throw new Error(creation.motif);

	const oeuvres: string[] = [];
	const entrees: string[] = [];
	for (let index = 0; index < n; index += 1) {
		const oeuvreId = await oeuvre(`${prefixe}${index + 1}`);
		const ajout = await ajouterEntree(db, {
			membreId: auteurId,
			ordreId: creation.ordreId,
			oeuvreId,
			now: T0
		});
		if (!ajout.ok) throw new Error(ajout.motif);
		oeuvres.push(oeuvreId);
		entrees.push(ajout.entreeId);
	}

	return { ordreId: creation.ordreId, oeuvres, entrees };
}

/** Les rangs de l'ordre, dans l'ordre de la séquence. Sert à vérifier la contiguïté. */
async function rangs(ordreId: string): Promise<number[]> {
	const lignes = await db
		.select({ rang: orderEntries.rank })
		.from(orderEntries)
		.where(eq(orderEntries.orderId, ordreId));
	return lignes.map((ligne) => ligne.rang).sort((a, b) => a - b);
}

/** Les titres de l'ordre, dans l'ordre de la séquence. */
async function sequence(ordreId: string, lecteurId: string): Promise<string[]> {
	const ordre = await lireOrdre(db, ordreId, lecteurId);
	return (ordre?.entrees ?? []).map((entree) => entree.oeuvre?.titre ?? '(disparue)');
}

// ---------------------------------------------------------------------------
// Création et versement (R14, R15, KTD1)
// ---------------------------------------------------------------------------

describe('créer un ordre (R14)', () => {
	it('crée un ordre vide, signé par son auteur', async () => {
		const auteurId = await membre(db, 'Camille');

		const creation = await creerOrdre(db, {
			membreId: auteurId,
			titre: 'Entrer chez les X-Men',
			description: 'Le chemin le plus court.',
			now: T0
		});
		expect(creation.ok).toBe(true);
		if (!creation.ok) return;

		const ordre = await lireOrdre(db, creation.ordreId, auteurId);
		expect(ordre).toMatchObject({
			titre: 'Entrer chez les X-Men',
			description: 'Le chemin le plus court.',
			auteur: { id: auteurId, nom: 'Camille', parti: false },
			entrees: [],
			nombreDeSuiveurs: 0,
			modifiable: true
		});
		// Un ordre vide n'a pas de pourcentage : ni 0 ni 100 ne seraient vrais.
		expect(ordre?.progression.pourcentage).toBe(null);
	});

	it('refuse un titre vide', async () => {
		const auteurId = await membre(db);

		expect(await creerOrdre(db, { membreId: auteurId, titre: '   ', now: T0 })).toEqual({
			ok: false,
			motif: 'titre vide'
		});
	});

	it('refuse un membre inconnu', async () => {
		expect(await creerOrdre(db, { membreId: 'forgé', titre: 'Ordre', now: T0 })).toEqual({
			ok: false,
			motif: 'membre introuvable'
		});
	});
});

describe('verser des œuvres (KTD1)', () => {
	it('un ordre peut être bâti sur des œuvres que personne n’a consignées', async () => {
		const auteurId = await membre(db);
		const { ordreId, oeuvres } = await ordreDe(auteurId, 3);

		const ordre = await lireOrdre(db, ordreId, auteurId);

		expect(ordre?.entrees).toHaveLength(3);
		expect(ordre?.entrees.every((entree) => !entree.atteinte)).toBe(true);
		// Aucune consignation n'existe, ni pour l'auteur ni pour quiconque.
		const versables = await chercherOeuvresAVerser(db, { requete: 'Numéro', ordreId });
		expect(versables.every((oeuvre) => !oeuvre.connueDuGroupe)).toBe(true);
		expect(versables.map((v) => v.id).sort()).toEqual([...oeuvres].sort());
	});

	it('verse à la fin par défaut, avec des rangs contigus', async () => {
		const auteurId = await membre(db);
		const { ordreId } = await ordreDe(auteurId, 4);

		expect(await rangs(ordreId)).toEqual([0, 1, 2, 3]);
	});

	it('refuse de verser deux fois la même œuvre', async () => {
		const auteurId = await membre(db);
		const { ordreId, oeuvres } = await ordreDe(auteurId, 1);

		expect(await ajouterEntree(db, { membreId: auteurId, ordreId, oeuvreId: oeuvres[0] })).toEqual({
			ok: false,
			motif: 'œuvre déjà présente'
		});
	});

	it('refuse une œuvre inconnue du catalogue', async () => {
		const auteurId = await membre(db);
		const { ordreId } = await ordreDe(auteurId, 0);

		expect(await ajouterEntree(db, { membreId: auteurId, ordreId, oeuvreId: 'forgée' })).toEqual({
			ok: false,
			motif: 'œuvre introuvable'
		});
	});

	it('refuse un rang hors de la séquence', async () => {
		const auteurId = await membre(db);
		const { ordreId } = await ordreDe(auteurId, 2);
		const neuve = await oeuvre('neuve');

		expect(
			await ajouterEntree(db, { membreId: auteurId, ordreId, oeuvreId: neuve, rang: 7 })
		).toEqual({ ok: false, motif: 'rang invalide' });
	});
});

describe('verser une série entière (F2)', () => {
	it('verse ses œuvres dans l’ordre de parution, l’œuvre « série » exclue', async () => {
		const auteurId = await membre(db);
		const creation = await creerOrdre(db, { membreId: auteurId, titre: 'Toute la série', now: T0 });
		if (!creation.ok) throw new Error(creation.motif);

		// Versées dans le désordre, avec la série elle-même dans le catalogue.
		await oeuvre('s3', { titre: 'Numéro 3', serie: 'ux', numero: 3 });
		await oeuvre('s1', { titre: 'Numéro 1', serie: 'ux', numero: 1 });
		await oeuvre('s2', { titre: 'Numéro 2', serie: 'ux', numero: 2 });
		await oeuvre('serie', { titre: 'Uncanny X-Men', type: 'serie', serie: 'ux' });

		const series = await seriesVersables(db);
		expect(series).toEqual([{ entityId: expect.any(String), nom: 'Série ux', nombreDOeuvres: 3 }]);

		const versement = await ajouterSerie(db, {
			membreId: auteurId,
			ordreId: creation.ordreId,
			serieEntityId: series[0].entityId,
			now: T0
		});

		expect(versement).toEqual({ ok: true, ajoutees: 3, dejaPresentes: 0, tronque: false });
		expect(await sequence(creation.ordreId, auteurId)).toEqual([
			'Numéro 1',
			'Numéro 2',
			'Numéro 3'
		]);
	});

	it('ignore les œuvres déjà présentes plutôt que d’échouer', async () => {
		const auteurId = await membre(db);
		const creation = await creerOrdre(db, { membreId: auteurId, titre: 'Toute la série', now: T0 });
		if (!creation.ok) throw new Error(creation.motif);

		const premier = await oeuvre('s1', { titre: 'Numéro 1', serie: 'ux', numero: 1 });
		await oeuvre('s2', { titre: 'Numéro 2', serie: 'ux', numero: 2 });
		await ajouterEntree(db, { membreId: auteurId, ordreId: creation.ordreId, oeuvreId: premier });

		const [serie] = await seriesVersables(db);
		const versement = await ajouterSerie(db, {
			membreId: auteurId,
			ordreId: creation.ordreId,
			serieEntityId: serie.entityId,
			now: T0
		});

		expect(versement).toEqual({ ok: true, ajoutees: 1, dejaPresentes: 1, tronque: false });
		expect(await rangs(creation.ordreId)).toEqual([0, 1]);
	});

	it('refuse une série inconnue', async () => {
		const auteurId = await membre(db);
		const { ordreId } = await ordreDe(auteurId, 0);

		expect(
			await ajouterSerie(db, { membreId: auteurId, ordreId, serieEntityId: 'forgée' })
		).toEqual({ ok: false, motif: 'série introuvable' });
	});
});

// ---------------------------------------------------------------------------
// La progression dérivée (R19, R20, R21, AE4, AE5)
// ---------------------------------------------------------------------------

describe('la progression se dérive des œuvres atteintes (KTD8)', () => {
	it('AE5 — dix entrées essentielles, les 1, 2, 5 et 9 atteintes : 40 % et l’entrée suivante est la troisième', async () => {
		const auteurId = await membre(db, 'Camille');
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres, entrees } = await ordreDe(auteurId, 10);
		await suivre(db, { membreId: suiveurId, ordreId, now: T0 });

		for (const rang of [1, 2, 5, 9]) {
			await consigner(db, {
				membreId: suiveurId,
				oeuvreId: oeuvres[rang - 1],
				etagere: 'termine',
				now: T0
			});
		}

		const progression = await progressionDansOrdre(db, ordreId, suiveurId);

		expect(progression?.pourcentage).toBe(40);
		expect(progression?.entreeSuivante?.id).toBe(entrees[2]);
		expect(progression?.atteintes).toEqual([entrees[0], entrees[1], entrees[4], entrees[8]]);
	});

	it('AE4 — atteindre une œuvre présente dans trois ordres suivis fait avancer les trois', async () => {
		const auteurId = await membre(db, 'Camille');
		const suiveurId = await membre(db, 'Antoine');
		const commune = await oeuvre('commune', { titre: 'Le numéro pivot' });

		const ordreIds: string[] = [];
		for (const nom of ['Un', 'Deux', 'Trois']) {
			const creation = await creerOrdre(db, { membreId: auteurId, titre: nom, now: T0 });
			if (!creation.ok) throw new Error(creation.motif);
			await ajouterEntree(db, {
				membreId: auteurId,
				ordreId: creation.ordreId,
				oeuvreId: commune,
				now: T0
			});
			await ajouterEntree(db, {
				membreId: auteurId,
				ordreId: creation.ordreId,
				oeuvreId: await oeuvre(`autre-${nom}`),
				now: T0
			});
			await suivre(db, { membreId: suiveurId, ordreId: creation.ordreId, now: T0 });
			ordreIds.push(creation.ordreId);
		}

		for (const ordreId of ordreIds) {
			expect((await progressionDansOrdre(db, ordreId, suiveurId))?.pourcentage).toBe(0);
		}

		await consigner(db, {
			membreId: suiveurId,
			oeuvreId: commune,
			etagere: 'termine',
			now: T0 + 1
		});

		for (const ordreId of ordreIds) {
			expect((await progressionDansOrdre(db, ordreId, suiveurId))?.pourcentage).toBe(50);
		}
	});

	it('l’abandon fait avancer autant que « terminé » (R3)', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres } = await ordreDe(auteurId, 2);

		await consigner(db, {
			membreId: suiveurId,
			oeuvreId: oeuvres[0],
			etagere: 'en_cours',
			now: T0
		});
		expect((await progressionDansOrdre(db, ordreId, suiveurId))?.pourcentage).toBe(0);

		await abandonner(db, { membreId: suiveurId, oeuvreId: oeuvres[0], now: T0 + 1 });
		expect((await progressionDansOrdre(db, ordreId, suiveurId))?.pourcentage).toBe(50);
	});

	it('R35 — reprendre une œuvre abandonnée fait reculer la progression', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres } = await ordreDe(auteurId, 2);

		await consigner(db, { membreId: suiveurId, oeuvreId: oeuvres[0], etagere: 'termine', now: T0 });
		expect((await progressionDansOrdre(db, ordreId, suiveurId))?.pourcentage).toBe(50);

		await reprendre(db, { membreId: suiveurId, oeuvreId: oeuvres[0], now: T0 + 1 });
		expect((await progressionDansOrdre(db, ordreId, suiveurId))?.pourcentage).toBe(0);
	});

	it('R33 — retirer une consignation fait reculer la progression des ordres concernés', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres, entrees } = await ordreDe(auteurId, 4);
		await suivre(db, { membreId: suiveurId, ordreId, now: T0 });

		for (const oeuvreId of oeuvres.slice(0, 2)) {
			await consigner(db, { membreId: suiveurId, oeuvreId, etagere: 'termine', now: T0 });
		}
		expect((await progressionDansOrdre(db, ordreId, suiveurId))?.pourcentage).toBe(50);

		await retirer(db, { membreId: suiveurId, oeuvreId: oeuvres[0], now: T0 + 1 });

		const apres = await progressionDansOrdre(db, ordreId, suiveurId);
		expect(apres?.pourcentage).toBe(25);
		expect(apres?.atteintes).toEqual([entrees[1]]);
		expect(apres?.entreeSuivante?.id).toBe(entrees[0]);
	});

	it('la progression d’un membre ne dépend pas du fait qu’il suive l’ordre', async () => {
		const auteurId = await membre(db);
		const passantId = await membre(db, 'Dominique');
		const { ordreId, oeuvres } = await ordreDe(auteurId, 2);

		await consigner(db, { membreId: passantId, oeuvreId: oeuvres[0], etagere: 'termine', now: T0 });

		const ordre = await lireOrdre(db, ordreId, passantId);
		expect(ordre?.suivi).toBe(false);
		expect(ordre?.progression.pourcentage).toBe(50);
	});
});

// ---------------------------------------------------------------------------
// Insertion, retrait, réordonnancement (R16, AE6)
// ---------------------------------------------------------------------------

describe('l’ordre reste juste après modification (R16, AE6)', () => {
	it('AE6 — insérer une entrée ne retire rien de l’ensemble atteint du suiveur', async () => {
		const auteurId = await membre(db, 'Camille');
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres, entrees } = await ordreDe(auteurId, 4);
		await suivre(db, { membreId: suiveurId, ordreId, now: T0 });

		for (const oeuvreId of oeuvres.slice(0, 2)) {
			await consigner(db, { membreId: suiveurId, oeuvreId, etagere: 'termine', now: T0 });
		}
		const avant = await progressionDansOrdre(db, ordreId, suiveurId);
		expect(avant?.pourcentage).toBe(50);
		expect(avant?.entreeSuivante?.id).toBe(entrees[2]);

		const inseree = await ajouterEntree(db, {
			membreId: auteurId,
			ordreId,
			oeuvreId: await oeuvre('inserée'),
			rang: 1,
			now: T0 + 1
		});
		if (!inseree.ok) throw new Error(inseree.motif);

		const apres = await progressionDansOrdre(db, ordreId, suiveurId);

		// L'ensemble atteint est intact : c'est la garantie de R16.
		expect(apres?.atteintes).toEqual(avant?.atteintes);
		// Le pourcentage baisse mécaniquement — le dénominateur a grandi.
		expect(apres?.pourcentage).toBe(40);
		// Et l'entrée suivante est recalculée : c'est celle qu'on vient d'insérer.
		expect(apres?.entreeSuivante?.id).toBe(inseree.entreeId);
		expect(await rangs(ordreId)).toEqual([0, 1, 2, 3, 4]);
	});

	it('retirer une entrée déjà atteinte par un suiveur ajuste son pourcentage sans erreur', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres, entrees } = await ordreDe(auteurId, 4);
		await suivre(db, { membreId: suiveurId, ordreId, now: T0 });

		for (const oeuvreId of oeuvres.slice(0, 2)) {
			await consigner(db, { membreId: suiveurId, oeuvreId, etagere: 'termine', now: T0 });
		}
		expect((await progressionDansOrdre(db, ordreId, suiveurId))?.pourcentage).toBe(50);

		expect(
			await retirerEntree(db, { membreId: auteurId, ordreId, entreeId: entrees[0], now: T0 + 1 })
		).toEqual({ ok: true });

		const apres = await progressionDansOrdre(db, ordreId, suiveurId);
		// Une atteinte de moins sur une essentielle de moins : un tiers.
		expect(apres?.pourcentage).toBeCloseTo(33.33, 1);
		expect(apres?.atteintes).toEqual([entrees[1]]);
		expect(await rangs(ordreId)).toEqual([0, 1, 2]);
	});

	it('retirer une entrée que personne n’avait atteinte fait monter le pourcentage', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres, entrees } = await ordreDe(auteurId, 4);

		for (const oeuvreId of oeuvres.slice(0, 2)) {
			await consigner(db, { membreId: suiveurId, oeuvreId, etagere: 'termine', now: T0 });
		}

		await retirerEntree(db, { membreId: auteurId, ordreId, entreeId: entrees[3], now: T0 + 1 });

		expect((await progressionDansOrdre(db, ordreId, suiveurId))?.pourcentage).toBeCloseTo(66.67, 1);
	});

	it('réordonner ne change aucun ensemble atteint', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres, entrees } = await ordreDe(auteurId, 5);
		await suivre(db, { membreId: suiveurId, ordreId, now: T0 });

		for (const rang of [2, 4]) {
			await consigner(db, {
				membreId: suiveurId,
				oeuvreId: oeuvres[rang - 1],
				etagere: 'termine',
				now: T0
			});
		}
		const avant = await progressionDansOrdre(db, ordreId, suiveurId);

		// La dernière passe en tête, puis la première descend au milieu.
		expect(
			await deplacerEntree(db, {
				membreId: auteurId,
				ordreId,
				entreeId: entrees[4],
				nouveauRang: 0,
				now: T0 + 1
			})
		).toEqual({ ok: true });
		await deplacerEntree(db, {
			membreId: auteurId,
			ordreId,
			entreeId: entrees[0],
			nouveauRang: 3,
			now: T0 + 2
		});

		const apres = await progressionDansOrdre(db, ordreId, suiveurId);
		expect([...(apres?.atteintes ?? [])].sort()).toEqual([...(avant?.atteintes ?? [])].sort());
		expect(apres?.pourcentage).toBe(avant?.pourcentage);
		expect(await rangs(ordreId)).toEqual([0, 1, 2, 3, 4]);
	});

	it('déplacer conserve la séquence attendue, vers le haut comme vers le bas', async () => {
		const auteurId = await membre(db);
		const creation = await creerOrdre(db, { membreId: auteurId, titre: 'Séquence', now: T0 });
		if (!creation.ok) throw new Error(creation.motif);

		const identifiants: string[] = [];
		for (const lettre of ['A', 'B', 'C', 'D']) {
			const ajout = await ajouterEntree(db, {
				membreId: auteurId,
				ordreId: creation.ordreId,
				oeuvreId: await oeuvre(lettre, { titre: lettre }),
				now: T0
			});
			if (!ajout.ok) throw new Error(ajout.motif);
			identifiants.push(ajout.entreeId);
		}

		// D remonte en tête.
		await deplacerEntree(db, {
			membreId: auteurId,
			ordreId: creation.ordreId,
			entreeId: identifiants[3],
			nouveauRang: 0
		});
		expect(await sequence(creation.ordreId, auteurId)).toEqual(['D', 'A', 'B', 'C']);

		// Puis A descend en queue.
		await deplacerEntree(db, {
			membreId: auteurId,
			ordreId: creation.ordreId,
			entreeId: identifiants[0],
			nouveauRang: 3
		});
		expect(await sequence(creation.ordreId, auteurId)).toEqual(['D', 'B', 'C', 'A']);
	});

	it('refuse un rang hors bornes et laisse la séquence intacte', async () => {
		const auteurId = await membre(db);
		const { ordreId, entrees } = await ordreDe(auteurId, 3);

		expect(
			await deplacerEntree(db, {
				membreId: auteurId,
				ordreId,
				entreeId: entrees[0],
				nouveauRang: 3
			})
		).toEqual({ ok: false, motif: 'rang invalide' });
		expect(await rangs(ordreId)).toEqual([0, 1, 2]);
	});

	it('refuse une entrée qui appartient à un autre ordre', async () => {
		const auteurId = await membre(db);
		const premier = await ordreDe(auteurId, 2, 'a');
		const second = await ordreDe(auteurId, 2, 'b');

		expect(
			await retirerEntree(db, {
				membreId: auteurId,
				ordreId: second.ordreId,
				entreeId: premier.entrees[0]
			})
		).toEqual({ ok: false, motif: 'entrée introuvable' });
	});
});

// ---------------------------------------------------------------------------
// Les entrées facultatives (R18)
// ---------------------------------------------------------------------------

describe('les entrées facultatives (R18)', () => {
	it('sont exclues du dénominateur et jamais proposées comme entrée suivante', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres, entrees } = await ordreDe(auteurId, 3);

		await marquerFacultative(db, {
			membreId: auteurId,
			ordreId,
			entreeId: entrees[1],
			facultative: true,
			now: T0 + 1
		});
		await consigner(db, { membreId: suiveurId, oeuvreId: oeuvres[0], etagere: 'termine', now: T0 });

		const progression = await progressionDansOrdre(db, ordreId, suiveurId);
		expect(progression?.essentielles).toBe(2);
		expect(progression?.pourcentage).toBe(50);
		expect(progression?.entreeSuivante?.id).toBe(entrees[2]);
	});

	it('un membre qui les saute atteint 100 %', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres, entrees } = await ordreDe(auteurId, 3);

		await marquerFacultative(db, {
			membreId: auteurId,
			ordreId,
			entreeId: entrees[1],
			facultative: true
		});
		for (const oeuvreId of [oeuvres[0], oeuvres[2]]) {
			await consigner(db, { membreId: suiveurId, oeuvreId, etagere: 'termine', now: T0 });
		}

		const progression = await progressionDansOrdre(db, ordreId, suiveurId);
		expect(progression?.pourcentage).toBe(100);
		expect(progression?.entreeSuivante).toBe(null);
	});

	it('un ordre entièrement facultatif n’a pas de pourcentage', async () => {
		const auteurId = await membre(db);
		const { ordreId, entrees } = await ordreDe(auteurId, 2);

		for (const entreeId of entrees) {
			await marquerFacultative(db, { membreId: auteurId, ordreId, entreeId, facultative: true });
		}

		const ordre = await lireOrdre(db, ordreId, auteurId);
		expect(ordre?.progression.pourcentage).toBe(null);
		expect(ordre?.progression.total).toBe(2);
	});

	it('la bascule se défait : une entrée redevient essentielle', async () => {
		const auteurId = await membre(db);
		const { ordreId, entrees } = await ordreDe(auteurId, 2);

		await marquerFacultative(db, {
			membreId: auteurId,
			ordreId,
			entreeId: entrees[0],
			facultative: true
		});
		await marquerFacultative(db, {
			membreId: auteurId,
			ordreId,
			entreeId: entrees[0],
			facultative: false
		});

		expect((await lireOrdre(db, ordreId, auteurId))?.progression.essentielles).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Suivi (R17, R22, R36)
// ---------------------------------------------------------------------------

describe('suivre et cesser de suivre (R36)', () => {
	it('R36 — cesser de suivre puis suivre à nouveau restitue la progression exacte', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres } = await ordreDe(auteurId, 4);
		await suivre(db, { membreId: suiveurId, ordreId, now: T0 });

		for (const oeuvreId of oeuvres.slice(0, 3)) {
			await consigner(db, { membreId: suiveurId, oeuvreId, etagere: 'termine', now: T0 });
		}
		const avant = await progressionDansOrdre(db, ordreId, suiveurId);
		expect(avant?.pourcentage).toBe(75);

		expect(await cesserDeSuivre(db, { membreId: suiveurId, ordreId })).toEqual({ ok: true });
		// Aucune consignation n'a bougé.
		expect((await lireOrdre(db, ordreId, suiveurId))?.suivi).toBe(false);
		expect((await progressionDansOrdre(db, ordreId, suiveurId))?.pourcentage).toBe(75);

		await suivre(db, { membreId: suiveurId, ordreId, now: T0 + 10 });

		const apres = await lireOrdre(db, ordreId, suiveurId);
		expect(apres?.suivi).toBe(true);
		expect(apres?.progression.atteintes).toEqual(avant?.atteintes);
		expect(apres?.progression.pourcentage).toBe(75);
		expect(apres?.progression.entreeSuivante?.id).toBe(avant?.entreeSuivante?.id);
	});

	it('suivre deux fois ne compte qu’une fois', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId } = await ordreDe(auteurId, 1);

		await suivre(db, { membreId: suiveurId, ordreId, now: T0 });
		await suivre(db, { membreId: suiveurId, ordreId, now: T0 + 1 });

		expect((await lireOrdre(db, ordreId, suiveurId))?.nombreDeSuiveurs).toBe(1);
	});

	it('cesser de suivre un ordre qu’on ne suivait pas est sans effet', async () => {
		const auteurId = await membre(db);
		const passantId = await membre(db, 'Dominique');
		const { ordreId } = await ordreDe(auteurId, 1);

		expect(await cesserDeSuivre(db, { membreId: passantId, ordreId })).toEqual({ ok: true });
		expect((await lireOrdre(db, ordreId, passantId))?.nombreDeSuiveurs).toBe(0);
	});

	it('refuse de suivre un ordre inconnu plutôt que d’écrire une ligne orpheline', async () => {
		const suiveurId = await membre(db);

		expect(await suivre(db, { membreId: suiveurId, ordreId: 'forgé' })).toEqual({
			ok: false,
			motif: 'ordre introuvable'
		});
	});
});

describe('R22 — un ordre affiche ses suiveurs et leur progression', () => {
	it('rend chaque suiveur avec son avancement propre', async () => {
		const auteurId = await membre(db, 'Camille');
		const rapide = await membre(db, 'Antoine');
		const lent = await membre(db, 'Dominique');
		const { ordreId, oeuvres } = await ordreDe(auteurId, 4);

		await suivre(db, { membreId: rapide, ordreId, now: T0 });
		await suivre(db, { membreId: lent, ordreId, now: T0 + 1 });

		for (const oeuvreId of oeuvres.slice(0, 3)) {
			await consigner(db, { membreId: rapide, oeuvreId, etagere: 'termine', now: T0 });
		}
		await consigner(db, { membreId: lent, oeuvreId: oeuvres[0], etagere: 'termine', now: T0 });

		const suiveurs = await suiveursDOrdre(db, ordreId);

		expect(suiveurs).toHaveLength(2);
		expect(suiveurs[0]).toMatchObject({ nom: 'Antoine', parti: false });
		expect(suiveurs[0].progression.pourcentage).toBe(75);
		expect(suiveurs[1]).toMatchObject({ nom: 'Dominique' });
		expect(suiveurs[1].progression.pourcentage).toBe(25);
		expect((await lireOrdre(db, ordreId, auteurId))?.nombreDeSuiveurs).toBe(2);
	});

	it('un ordre que personne ne suit rend une liste vide, pas une erreur', async () => {
		const auteurId = await membre(db);
		const { ordreId } = await ordreDe(auteurId, 1);

		expect(await suiveursDOrdre(db, ordreId)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Fork (R17)
// ---------------------------------------------------------------------------

describe('forker (R17)', () => {
	it('copie les entrées en conservant une référence à l’original', async () => {
		const auteurId = await membre(db, 'Camille');
		const forkeurId = await membre(db, 'Antoine');
		const { ordreId } = await ordreDe(auteurId, 3);

		const fork = await forker(db, { membreId: forkeurId, ordreId, now: T0 + 1 });
		expect(fork.ok).toBe(true);
		if (!fork.ok) return;

		const copie = await lireOrdre(db, fork.ordreId, forkeurId);
		expect(copie).toMatchObject({
			auteur: { id: forkeurId, nom: 'Antoine' },
			forkDe: { id: ordreId, titre: 'Par où entrer' },
			modifiable: true
		});
		expect(copie?.entrees).toHaveLength(3);
	});

	it('un fork modifié ne modifie pas l’original', async () => {
		const auteurId = await membre(db, 'Camille');
		const forkeurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres } = await ordreDe(auteurId, 3);

		const fork = await forker(db, { membreId: forkeurId, ordreId, now: T0 + 1 });
		if (!fork.ok) return;

		const copie = await lireOrdre(db, fork.ordreId, forkeurId);
		const premiere = copie!.entrees[0];

		await retirerEntree(db, {
			membreId: forkeurId,
			ordreId: fork.ordreId,
			entreeId: premiere.id,
			now: T0 + 2
		});
		await ajouterEntree(db, {
			membreId: forkeurId,
			ordreId: fork.ordreId,
			oeuvreId: await oeuvre('ajoutée-au-fork'),
			now: T0 + 3
		});
		await marquerFacultative(db, {
			membreId: forkeurId,
			ordreId: fork.ordreId,
			entreeId: copie!.entrees[1].id,
			facultative: true,
			now: T0 + 4
		});

		const original = await lireOrdre(db, ordreId, auteurId);
		expect(original?.entrees.map((entree) => entree.oeuvreId)).toEqual(oeuvres);
		expect(original?.entrees.every((entree) => !entree.facultative)).toBe(true);
		expect((await lireOrdre(db, fork.ordreId, forkeurId))?.entrees).toHaveLength(3);
	});

	it('les identités d’entrée du fork sont neuves : rien n’est partagé (R15)', async () => {
		const auteurId = await membre(db);
		const forkeurId = await membre(db, 'Antoine');
		const { ordreId, entrees } = await ordreDe(auteurId, 2);

		const fork = await forker(db, { membreId: forkeurId, ordreId, now: T0 + 1 });
		if (!fork.ok) return;

		const copie = await lireOrdre(db, fork.ordreId, forkeurId);
		for (const entree of copie?.entrees ?? []) {
			expect(entrees).not.toContain(entree.id);
		}
	});

	it('forker un fork pointe vers l’ordre dont on est parti, pas vers la racine', async () => {
		const auteurId = await membre(db, 'Camille');
		const premierId = await membre(db, 'Antoine');
		const secondId = await membre(db, 'Dominique');
		const { ordreId } = await ordreDe(auteurId, 2);

		const premier = await forker(db, {
			membreId: premierId,
			ordreId,
			titre: 'Variante',
			now: T0 + 1
		});
		if (!premier.ok) return;
		const second = await forker(db, {
			membreId: secondId,
			ordreId: premier.ordreId,
			titre: 'Variante de la variante',
			now: T0 + 2
		});
		if (!second.ok) return;

		expect((await lireOrdre(db, second.ordreId, secondId))?.forkDe).toEqual({
			id: premier.ordreId,
			titre: 'Variante'
		});
		// Et l'original n'a pas bougé d'un pouce.
		expect((await lireOrdre(db, ordreId, auteurId))?.entrees).toHaveLength(2);
	});

	it('forker un ordre vide donne un ordre vide, pas une erreur', async () => {
		const auteurId = await membre(db);
		const forkeurId = await membre(db, 'Antoine');
		const { ordreId } = await ordreDe(auteurId, 0);

		const fork = await forker(db, { membreId: forkeurId, ordreId, now: T0 + 1 });
		expect(fork.ok).toBe(true);
		if (!fork.ok) return;
		expect((await lireOrdre(db, fork.ordreId, forkeurId))?.entrees).toEqual([]);
	});

	it('un ordre sans auteur reste forkable (R38)', async () => {
		const auteurId = await membre(db, 'Camille');
		const forkeurId = await membre(db, 'Antoine');
		const { ordreId } = await ordreDe(auteurId, 2);
		await markMemberAsLeft(db, auteurId, T0 + 1);

		const fork = await forker(db, { membreId: forkeurId, ordreId, now: T0 + 2 });
		expect(fork.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Autorisation (R16, R38)
// ---------------------------------------------------------------------------

describe('seul l’auteur modifie son ordre (R16)', () => {
	it('un suiveur reçoit un refus sur chaque geste d’édition', async () => {
		const auteurId = await membre(db, 'Camille');
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres, entrees } = await ordreDe(auteurId, 2);
		await suivre(db, { membreId: suiveurId, ordreId, now: T0 });

		const refus = { ok: false, motif: "seul l'auteur peut modifier" };
		const neuve = await oeuvre('neuve');

		expect(await modifierOrdre(db, { membreId: suiveurId, ordreId, titre: 'Détourné' })).toEqual(
			refus
		);
		expect(await ajouterEntree(db, { membreId: suiveurId, ordreId, oeuvreId: neuve })).toEqual(
			refus
		);
		expect(
			await ajouterSerie(db, { membreId: suiveurId, ordreId, serieEntityId: 'peu importe' })
		).toEqual(refus);
		expect(await retirerEntree(db, { membreId: suiveurId, ordreId, entreeId: entrees[0] })).toEqual(
			refus
		);
		expect(
			await deplacerEntree(db, {
				membreId: suiveurId,
				ordreId,
				entreeId: entrees[0],
				nouveauRang: 1
			})
		).toEqual(refus);
		expect(
			await marquerFacultative(db, {
				membreId: suiveurId,
				ordreId,
				entreeId: entrees[0],
				facultative: true
			})
		).toEqual(refus);
		expect(await supprimerOrdre(db, { membreId: suiveurId, ordreId })).toEqual(refus);

		// Rien n'a bougé.
		const ordre = await lireOrdre(db, ordreId, suiveurId);
		expect(ordre?.titre).toBe('Par où entrer');
		expect(ordre?.entrees.map((entree) => entree.oeuvreId)).toEqual(oeuvres);
		expect(ordre?.modifiable).toBe(false);
	});

	it('R38 — un ordre dont l’auteur est parti n’est plus modifiable, mais reste suivable', async () => {
		const auteurId = await membre(db, 'Camille');
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId } = await ordreDe(auteurId, 2);

		await markMemberAsLeft(db, auteurId, T0 + 1);

		expect(await modifierOrdre(db, { membreId: auteurId, ordreId, titre: 'Repris' })).toEqual({
			ok: false,
			motif: 'ordre sans auteur'
		});

		expect(await suivre(db, { membreId: suiveurId, ordreId, now: T0 + 2 })).toEqual({ ok: true });
		const ordre = await lireOrdre(db, ordreId, suiveurId);
		expect(ordre?.auteur.parti).toBe(true);
		expect(ordre?.modifiable).toBe(false);
		expect(ordre?.entrees).toHaveLength(2);
	});

	it('un ordre inconnu est refusé comme tel, pas confondu avec un refus de droits', async () => {
		const auteurId = await membre(db);

		expect(await modifierOrdre(db, { membreId: auteurId, ordreId: 'forgé', titre: 'X' })).toEqual({
			ok: false,
			motif: 'ordre introuvable'
		});
	});
});

describe('un membre ne modifie pas le suivi d’un autre', () => {
	it('le geste est désigné par le couple membre-ordre : il n’y a pas d’identifiant à forger', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const intrusId = await membre(db, 'Dominique');
		const { ordreId } = await ordreDe(auteurId, 1);
		await suivre(db, { membreId: suiveurId, ordreId, now: T0 });

		// Tout ce que l'intrus peut faire, c'est agir en son propre nom.
		await cesserDeSuivre(db, { membreId: intrusId, ordreId });
		await suivre(db, { membreId: intrusId, ordreId, now: T0 + 1 });

		expect((await lireOrdre(db, ordreId, suiveurId))?.suivi).toBe(true);
		const suiveurs = await suiveursDOrdre(db, ordreId);
		expect(suiveurs.map((suiveur) => suiveur.membreId).sort()).toEqual(
			[suiveurId, intrusId].sort()
		);
	});
});

// ---------------------------------------------------------------------------
// Suppression et cas limites
// ---------------------------------------------------------------------------

describe('supprimer un ordre', () => {
	it('emporte ses entrées et ses suivis', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId } = await ordreDe(auteurId, 2);
		await suivre(db, { membreId: suiveurId, ordreId, now: T0 });

		expect(await supprimerOrdre(db, { membreId: auteurId, ordreId })).toEqual({ ok: true });

		expect(await lireOrdre(db, ordreId, auteurId)).toBe(null);
		expect(await listerOrdres(db, auteurId)).toEqual([]);
	});

	it('laisse vivre ses forks, qui perdent seulement leur référence', async () => {
		const auteurId = await membre(db, 'Camille');
		const forkeurId = await membre(db, 'Antoine');
		const { ordreId } = await ordreDe(auteurId, 2);
		const fork = await forker(db, { membreId: forkeurId, ordreId, now: T0 + 1 });
		if (!fork.ok) return;

		await supprimerOrdre(db, { membreId: auteurId, ordreId });

		const survivant = await lireOrdre(db, fork.ordreId, forkeurId);
		expect(survivant?.forkDe).toBe(null);
		expect(survivant?.entrees).toHaveLength(2);
	});
});

describe('une œuvre disparue du catalogue', () => {
	it('laisse l’ordre lisible, hors du dénominateur et jamais proposée', async () => {
		const auteurId = await membre(db);
		const suiveurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres, entrees } = await ordreDe(auteurId, 3);
		await consigner(db, { membreId: suiveurId, oeuvreId: oeuvres[2], etagere: 'termine', now: T0 });

		// Une fusion de doublons a fait disparaître la première œuvre. Les clés
		// étrangères la protègent en temps normal ; on simule ici l'après-coup.
		await db.run(sql`pragma foreign_keys = off`);
		await db.delete(works).where(eq(works.id, oeuvres[0]));
		await db.run(sql`pragma foreign_keys = on`);

		const ordre = await lireOrdre(db, ordreId, suiveurId);

		expect(ordre?.entrees).toHaveLength(3);
		expect(ordre?.entrees[0]).toMatchObject({ introuvable: true, oeuvre: null, atteinte: false });
		expect(ordre?.progression.essentielles).toBe(2);
		expect(ordre?.progression.pourcentage).toBe(50);
		expect(ordre?.progression.entreeSuivante?.id).toBe(entrees[1]);
	});
});

describe('les listes', () => {
	it('R6 — les ordres qu’un membre a créés et ceux qu’il suit sont deux listes', async () => {
		const membreId = await membre(db, 'Camille');
		const autreId = await membre(db, 'Antoine');
		const sien = await ordreDe(membreId, 2, 'a');
		const autre = await ordreDe(autreId, 2, 'b');

		await suivre(db, { membreId, ordreId: autre.ordreId, now: T0 });
		await suivre(db, { membreId, ordreId: sien.ordreId, now: T0 + 1 });

		const { crees, suivis } = await ordresDUnMembre(db, membreId, membreId);

		expect(crees.map((ordre) => ordre.id)).toEqual([sien.ordreId]);
		expect(suivis.map((ordre) => ordre.id).sort()).toEqual([sien.ordreId, autre.ordreId].sort());
	});

	it('la liste du groupe porte la progression du lecteur, pas celle de l’auteur', async () => {
		const auteurId = await membre(db, 'Camille');
		const lecteurId = await membre(db, 'Antoine');
		const { ordreId, oeuvres } = await ordreDe(auteurId, 2);

		await consigner(db, { membreId: auteurId, oeuvreId: oeuvres[0], etagere: 'termine', now: T0 });
		await consigner(db, { membreId: auteurId, oeuvreId: oeuvres[1], etagere: 'termine', now: T0 });

		const [vuParLeLecteur] = await listerOrdres(db, lecteurId);
		const [vuParLAuteur] = await listerOrdres(db, auteurId);

		expect(vuParLeLecteur.id).toBe(ordreId);
		expect(vuParLeLecteur.progression.pourcentage).toBe(0);
		expect(vuParLAuteur.progression.pourcentage).toBe(100);
		expect(vuParLeLecteur.modifiable).toBe(false);
		expect(vuParLAuteur.modifiable).toBe(true);
	});
});
