import { describe, expect, it } from 'vitest';
import { creerMetron, interpreter, BASE_METRON } from './metron';
import { chronometreFactice, transportFactice } from './testing';
import listeReelle from './fixtures/metron-issue-liste.json';
import ficheReelle from './fixtures/metron-issue-detail.json';
import parcoursReel from './fixtures/metron-parcours-personnage.json';

/**
 * Les fixtures sont des **réponses réellement capturées** le 2026-08-01, pas des
 * formes supposées. C'est la leçon de la décision 001 : un accesseur écrit
 * d'après la documentation publique avait conclu à 0 % de couverture personnages
 * sur une donnée qui était là. Un test contre un JSON inventé aurait validé
 * l'accesseur faux.
 */

const identifiants = { utilisateur: 'membre', motDePasse: 'secret' };

function metron(reponses: Parameters<typeof transportFactice>[0]) {
	const chronometre = chronometreFactice();
	const factice = transportFactice(reponses, chronometre);
	const adaptateur = creerMetron({ ...identifiants, transport: factice.transport, chronometre });
	return { adaptateur, ...factice, chronometre };
}

describe('interprétation de la requête', () => {
	it('cherche par nom de série quand rien ne ressemble à un numéro', () => {
		expect(interpreter('Immortal X-Men')).toEqual([{ serie: 'Immortal X-Men' }]);
	});

	it('un dièse explicite désigne un numéro, en un seul appel', () => {
		expect(interpreter('Immortal X-Men #1')).toEqual([{ serie: 'Immortal X-Men', numero: '1' }]);
	});

	it('un entier final sans dièse essaie le nom entier d’abord — « X-Men 92 » est une série', () => {
		expect(interpreter('X-Men 92')).toEqual([
			{ serie: 'X-Men 92' },
			{ serie: 'X-Men', numero: '92' }
		]);
	});
});

describe('recherche', () => {
	it('interroge series_name, jamais name — le paramètre qui avait faussé la sonde', async () => {
		const { adaptateur, appels } = metron([{ quand: 'issue/?', corps: listeReelle }]);

		const trouvees = await adaptateur.rechercher('Immortal X-Men');

		expect(trouvees.ok).toBe(true);
		expect(appels[0]).toContain('series_name=Immortal+X-Men');
		expect(appels[0]).not.toMatch(/[?&]name=/);
	});

	it('mappe un élément de liste avec son titre, sa série, sa date et sa couverture', async () => {
		const { adaptateur } = metron([{ quand: 'issue/?', corps: listeReelle }]);

		const trouvees = await adaptateur.rechercher('Immortal X-Men');
		if (!trouvees.ok) throw new Error(trouvees.motif);

		expect(trouvees.valeur.elements[0]).toMatchObject({
			reference: { source: 'metron', idExterne: '44467' },
			type: 'numero',
			titre: 'Immortal X-Men (2022) #1',
			dateDeParution: '2022-05-01',
			numeroDansLaSerie: 1,
			serie: { reference: { source: 'metron', idExterne: '3231' }, nom: 'Immortal X-Men' },
			couvertureUrl: 'https://static.metron.cloud/media/issue/2022/03/18/immortal-xmen-1.jpg'
		});
	});

	it('déclare les personnages « indisponibles » et non « absents » : la liste ne les propose pas', async () => {
		const { adaptateur } = metron([{ quand: 'issue/?', corps: listeReelle }]);

		const trouvees = await adaptateur.rechercher('Immortal X-Men');
		if (!trouvees.ok) throw new Error(trouvees.motif);

		expect(trouvees.valeur.elements[0].completude).toEqual({
			personnages: 'indisponibles',
			createurs: 'indisponibles',
			contenu: 'sans objet'
		});
	});

	it('rejoue la requête avec le numéro quand le nom entier ne rend rien', async () => {
		const { adaptateur, appels } = metron([
			{ quand: 'series_name=Uncanny+X-Men+141', corps: { count: 0, results: [] } },
			{ quand: 'series_name=Uncanny+X-Men&number=141', corps: listeReelle }
		]);

		const trouvees = await adaptateur.rechercher('Uncanny X-Men 141');
		if (!trouvees.ok) throw new Error(trouvees.motif);

		expect(appels).toHaveLength(2);
		expect(trouvees.valeur.elements).not.toHaveLength(0);
	});

	it('une requête vide n’appelle rien', async () => {
		const { adaptateur, appels } = metron([]);

		expect(await adaptateur.rechercher('   ')).toEqual({ ok: true, valeur: { elements: [] } });
		expect(appels).toEqual([]);
	});
});

describe('cadence et quota (la contrainte la plus dure de U3b)', () => {
	it('espace les départs d’appels de 2,5 s', async () => {
		const { adaptateur, instants } = metron([{ quand: 'issue/', corps: listeReelle }]);

		await adaptateur.rechercher('un');
		await adaptateur.rechercher('deux');
		await adaptateur.rechercher('trois');

		expect(instants[1] - instants[0]).toBeGreaterThanOrEqual(2500);
		expect(instants[2] - instants[1]).toBeGreaterThanOrEqual(2500);
	});

	it('trois recherches lancées ensemble restent espacées', async () => {
		const { adaptateur, instants } = metron([{ quand: 'issue/', corps: listeReelle }]);

		await Promise.all([
			adaptateur.rechercher('un'),
			adaptateur.rechercher('deux'),
			adaptateur.rechercher('trois')
		]);

		expect(instants).toHaveLength(3);
		expect(instants[2] - instants[0]).toBeGreaterThanOrEqual(5000);
	});

	it('un 429 est rapporté comme quota, jamais comme une panne', async () => {
		const { adaptateur } = metron([
			{
				quand: 'issue/',
				statut: 429,
				texte: 'Request was throttled. Expected available in 12 seconds.'
			}
		]);

		expect(await adaptateur.rechercher('Immortal X-Men')).toEqual({ ok: false, motif: 'quota' });
	});

	it('après un 429, la source est mise en veille : plus aucun appel jusqu’à l’échéance annoncée', async () => {
		const { adaptateur, appels, chronometre } = metron([
			{ quand: 'issue/', statut: 429, texte: 'Expected available in 12 seconds.' }
		]);

		await adaptateur.rechercher('un');
		expect(appels).toHaveLength(1);

		// Vingt membres qui rejouent l'appel refusé prolongeraient l'étranglement.
		expect(await adaptateur.rechercher('deux')).toEqual({ ok: false, motif: 'quota' });
		expect(appels).toHaveLength(1);

		chronometre.avancer(13_000);
		await adaptateur.rechercher('trois');
		expect(appels).toHaveLength(2);
	});

	it('distingue les autres échecs du quota', async () => {
		const injoignable = metron([{ quand: 'issue/', statut: 503 }]);
		const refuse = metron([{ quand: 'issue/', statut: 401 }]);
		const coupe = metron([{ quand: 'issue/', coupure: true }]);
		const illisible = metron([{ quand: 'issue/', texte: 'pas du json' }]);

		expect(await injoignable.adaptateur.rechercher('x')).toEqual({
			ok: false,
			motif: 'indisponible'
		});
		expect(await refuse.adaptateur.rechercher('x')).toEqual({ ok: false, motif: 'non-autorise' });
		expect(await coupe.adaptateur.rechercher('x')).toEqual({ ok: false, motif: 'indisponible' });
		expect(await illisible.adaptateur.rechercher('x')).toEqual({ ok: false, motif: 'illisible' });
	});
});

describe('lecture d’une fiche', () => {
	it('mappe personnages, crédits, arc et série depuis une réponse réelle', async () => {
		const { adaptateur } = metron([{ quand: 'issue/44467/', corps: ficheReelle }]);

		const lue = await adaptateur.lireOeuvre('44467');
		if (!lue.ok || lue.valeur === null) throw new Error('fiche illisible');

		expect(lue.valeur).toMatchObject({
			reference: { source: 'metron', idExterne: '44467' },
			type: 'numero',
			titre: 'Immortal X-Men #1',
			dateDeParution: '2022-05-01',
			numeroDansLaSerie: 1,
			serie: { nom: 'Immortal X-Men' },
			event: { reference: { source: 'metron', idExterne: '1423' }, nom: 'Destiny of X' }
		});
		expect(lue.valeur.personnages[0]).toEqual({
			reference: { source: 'metron', idExterne: '1391' },
			nom: 'Abigail Brand'
		});
		expect(lue.valeur.completude).toEqual({
			personnages: 'fournis',
			createurs: 'fournis',
			contenu: 'sans objet'
		});
	});

	it('un créateur à plusieurs rôles produit une ligne par rôle', async () => {
		const { adaptateur } = metron([{ quand: 'issue/44467/', corps: ficheReelle }]);

		const lue = await adaptateur.lireOeuvre('44467');
		if (!lue.ok || lue.valeur === null) throw new Error('fiche illisible');

		const cowles = lue.valeur.createurs.filter((c) => c.nom === 'Clayton Cowles');
		expect(cowles.map((c) => c.role).sort()).toEqual(['Letterer', 'Production']);
		expect(new Set(cowles.map((c) => c.reference.idExterne))).toEqual(new Set(['5']));
	});

	it('un champ « characters » absent vaut indisponible, pas absent', async () => {
		const { characters, ...sansPersonnages } = ficheReelle;
		expect(characters.length).toBeGreaterThan(0);

		const { adaptateur } = metron([{ quand: 'issue/44467/', corps: sansPersonnages }]);
		const lue = await adaptateur.lireOeuvre('44467');
		if (!lue.ok || lue.valeur === null) throw new Error('fiche illisible');

		expect(lue.valeur.completude.personnages).toBe('indisponibles');
	});

	it('une liste vide vaut absent : la source affirme qu’il n’y a rien', async () => {
		const { adaptateur } = metron([
			{ quand: 'issue/44467/', corps: { ...ficheReelle, characters: [] } }
		]);

		const lue = await adaptateur.lireOeuvre('44467');
		if (!lue.ok || lue.valeur === null) throw new Error('fiche illisible');

		expect(lue.valeur.completude.personnages).toBe('absents');
	});

	it('un recueil porte son contenu et le déclare', async () => {
		const { adaptateur } = metron([
			{
				quand: 'issue/9/',
				corps: {
					...ficheReelle,
					id: 9,
					series: { ...ficheReelle.series, series_type: { id: 10, name: 'Trade Paperback' } },
					reprints: [{ id: 44467 }, { id: 44468 }]
				}
			}
		]);

		const lue = await adaptateur.lireOeuvre('9');
		if (!lue.ok || lue.valeur === null) throw new Error('fiche illisible');

		expect(lue.valeur.type).toBe('recueil');
		expect(lue.valeur.contenu).toEqual([
			{ source: 'metron', idExterne: '44467' },
			{ source: 'metron', idExterne: '44468' }
		]);
		expect(lue.valeur.completude.contenu).toBe('fourni');
	});

	it('une œuvre que la source ne connaît pas rend null, sans échec', async () => {
		const { adaptateur } = metron([{ quand: 'issue/999/', statut: 404 }]);

		expect(await adaptateur.lireOeuvre('999')).toEqual({ ok: true, valeur: null });
	});

	it('un numéro non numérique n’est pas approximé — la réconciliation s’appuie dessus', async () => {
		const { adaptateur } = metron([
			{ quand: 'issue/44467/', corps: { ...ficheReelle, number: '1.MU' } }
		]);

		const lue = await adaptateur.lireOeuvre('44467');
		if (!lue.ok || lue.valeur === null) throw new Error('fiche illisible');

		expect(lue.valeur.numeroDansLaSerie).toBeUndefined();
		expect(lue.valeur.titre).toBe('Immortal X-Men #1.MU');
	});

	it('un titre porteur de balisage traverse tel quel, sans nettoyage', async () => {
		const { adaptateur } = metron([
			{
				quand: 'issue/44467/',
				corps: {
					...ficheReelle,
					series: { ...ficheReelle.series, name: '<script>alert(1)</script>' }
				}
			}
		]);

		const lue = await adaptateur.lireOeuvre('44467');
		if (!lue.ok || lue.valeur === null) throw new Error('fiche illisible');

		// L'échappement est le travail du rendu. Nettoyer ici abîmerait la donnée,
		// et laisserait croire que la surface est protégée par l'ingestion.
		expect(lue.valeur.titre).toBe('<script>alert(1)</script> #1');
	});
});

describe('parcours par facette', () => {
	it('le parcours par personnage passe par character_id', async () => {
		const { adaptateur, appels } = metron([{ quand: 'character_id=1391', corps: parcoursReel }]);

		const trouvees = await adaptateur.parcourir('personnage', '1391');
		if (!trouvees.ok) throw new Error(trouvees.motif);

		expect(appels[0]).toContain('character_id=1391');
		expect(trouvees.valeur.elements[0].titre).toBe('Age of Ultron (2013) #10');
	});

	it('chaque axe a son filtre, et l’event est un arc narratif', async () => {
		const { adaptateur, appels } = metron([{ quand: 'issue/?', corps: parcoursReel }]);

		await adaptateur.parcourir('serie', '3231');
		await adaptateur.parcourir('createur', '215');
		await adaptateur.parcourir('event', '1423');

		expect(appels[0]).toContain('series_id=3231');
		expect(appels[1]).toContain('creator_id=215');
		expect(appels[2]).toContain('arc_id=1423');
	});

	it('la suite est rendue quand la source en annonce une', async () => {
		const { adaptateur } = metron([{ quand: 'character_id=1391', corps: parcoursReel }]);

		const trouvees = await adaptateur.parcourir('personnage', '1391');
		if (!trouvees.ok) throw new Error(trouvees.motif);

		expect(trouvees.valeur.suite).toBe(`${BASE_METRON}issue/?character_id=1391&page=2`);
	});

	it('une suite qui ne pointe pas vers la source est refusée', async () => {
		const { adaptateur, appels } = metron([{ quand: 'issue/?', corps: listeReelle }]);

		await adaptateur.parcourir('personnage', '1391', {
			suite: 'https://ailleurs.example/exfiltration'
		});

		expect(appels[0]).toContain('metron.cloud');
		expect(appels[0]).not.toContain('ailleurs.example');
	});

	it('une page tronquée n’annonce pas de suite : elle sauterait des résultats', async () => {
		const { adaptateur } = metron([{ quand: 'character_id=1391', corps: parcoursReel }]);

		const trouvees = await adaptateur.parcourir('personnage', '1391', { limite: 1 });
		if (!trouvees.ok) throw new Error(trouvees.motif);

		expect(trouvees.valeur.elements).toHaveLength(1);
		expect(trouvees.valeur.suite).toBeUndefined();
	});
});

describe('capacités déclarées', () => {
	it('déclare ce qui a été mesuré, et rien de plus', () => {
		const { adaptateur } = metron([]);

		expect(adaptateur.capacites).toEqual({
			rechercheParTitre: true,
			parcoursParPersonnage: true,
			parcoursParSerie: true,
			parcoursParCreateur: true,
			parcoursParEvent: true,
			// La liste des numéros d'un recueil n'a pas pu être vérifiée : U5 ne doit
			// pas se bâtir sur une capacité supposée.
			contenuDesRecueils: false,
			personnagesParOeuvre: true
		});
	});
});
